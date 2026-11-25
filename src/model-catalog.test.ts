import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import {
  type AnthropicApiModel,
  CATALOG_TTL_MS,
  type CatalogModel,
  fetchCatalog,
  isStale,
  loadCatalog,
  reconcileModels,
  saveCatalog,
  variantsFor,
} from "./model-catalog.ts"

const efforts = (...levels: string[]) => ({
  supported: true,
  ...Object.fromEntries(levels.map((l) => [l, { supported: true }])),
})

const api = (
  id: string,
  extra: Partial<AnthropicApiModel> = {},
): AnthropicApiModel => ({
  id,
  display_name: id,
  created_at: "2026-11-09T18:30:00Z",
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  lifecycle: "active",
  capabilities: {
    image_input: { supported: true },
    pdf_input: { supported: true },
    thinking: { supported: true, types: { adaptive: { supported: true } } },
    effort: efforts("low", "medium", "high", "xhigh", "max"),
  },
  ...extra,
})

const dev = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  modelID: id,
  name: id,
  family: "claude-opus",
  package: "@opencode/ai/providers/anthropic",
  settings: { baseURL: "https://api.anthropic.com/v1" },
  limit: { context: 200_000, output: 64_000 },
  time: { released: 1 },
  variants: [{ id: "curated" }],
  cost: [{ input: 5 }],
  ...extra,
})

describe("reconcileModels", () => {
  const catalog = {
    fetchedAt: 0,
    models: [
      api("claude-mythos-5-2", { line: "mythos", display_name: "Claude Mythos 5.2" }),
      api("claude-opus-5-5", { line: "opus" }),
      api("claude-haiku-4-5-20251001", { line: "haiku", max_input_tokens: 200_000, max_tokens: 64_000 }),
      api("claude-sonnet-4-5-20250929", { lifecycle: "deprecated" }),
      api("claude-opus-4-5-20251101", { lifecycle: "deprecated" }),
    ],
  }
  const existing = [
    dev("claude-opus-5-5", { time: { released: 5 } }),
    dev("claude-opus-5-5-fast", { modelID: "claude-opus-5-5", body: { speed: "fast" } }),
    dev("claude-haiku-4-5", { family: "claude-haiku" }),
    dev("claude-sonnet-4-5-20250929", { family: "claude-sonnet" }),
    dev("claude-opus-4-1", { family: "claude-opus" }),
  ]
  const result = reconcileModels(existing, catalog)
  const byID = new Map(result.models.map((m) => [m.id, m]))

  it("drops models.dev entries the account does not have", () => {
    assert.deepEqual(result.removed, ["claude-opus-4-1"])
    assert.equal(byID.has("claude-opus-4-1"), false)
  })

  it("keeps curated entries, fast tiers and undated aliases", () => {
    assert.deepEqual(byID.get("claude-opus-5-5")!.variants, [{ id: "curated" }])
    assert.ok(byID.has("claude-opus-5-5-fast"))
    assert.ok(byID.has("claude-haiku-4-5"))
  })

  it("refreshes limits and lifecycle from the API", () => {
    assert.deepEqual(byID.get("claude-opus-5-5")!.limit, {
      context: 1_000_000,
      output: 128_000,
    })
    assert.equal(byID.get("claude-sonnet-4-5-20250929")!.status, "deprecated")
  })

  it("synthesizes models models.dev does not list yet, except deprecated ones", () => {
    assert.deepEqual(result.added, ["claude-mythos-5-2"])
    assert.equal(byID.has("claude-opus-4-5-20251101"), false)
    const mythos = byID.get("claude-mythos-5-2")!
    assert.equal(mythos.name, "Claude Mythos 5.2")
    assert.equal(mythos.modelID, "claude-mythos-5-2")
    assert.equal(mythos.family, "claude-mythos")
    assert.equal(mythos.package, "@opencode/ai/providers/anthropic")
    assert.equal(mythos.body, undefined)
    assert.deepEqual(mythos.capabilities!.input, ["text", "image", "pdf"])
    assert.deepEqual(mythos.limit, { context: 1_000_000, output: 128_000 })
    assert.deepEqual(
      (mythos.variants as { id: string }[]).map((v) => v.id),
      ["low", "medium", "high", "xhigh", "max"],
    )
  })

  it("does not modify its input", () => {
    assert.deepEqual(existing[0].limit, { context: 200_000, output: 64_000 })
  })
})

describe("variantsFor", () => {
  it("uses budget thinking for models without adaptive thinking", () => {
    const variants = variantsFor(
      api("claude-haiku-4-5-20251001", {
        max_tokens: 64_000,
        capabilities: {
          thinking: {
            supported: true,
            types: { enabled: { supported: true }, disabled: { supported: true } },
          },
          effort: { supported: false },
        },
      }),
    )
    assert.deepEqual(variants, [
      { id: "none", settings: { thinking: { type: "disabled" } } },
      { id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16000 } } },
      { id: "max", settings: { thinking: { type: "enabled", budgetTokens: 31999 } } },
    ])
  })

  it("offers only the effort levels the model supports", () => {
    const variants = variantsFor(
      api("claude-sonnet-4-6", {
        capabilities: {
          thinking: { supported: true, types: { adaptive: { supported: true } } },
          effort: efforts("low", "high"),
        },
      }),
    ) as { id: string }[]
    assert.deepEqual(variants.map((v) => v.id), ["low", "high"])
  })
})

describe("fetchCatalog", () => {
  it("pages through /v1/models with the OAuth headers", async () => {
    const seen: { url: string; headers: Headers }[] = []
    const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, headers: new Headers(init?.headers) })
      const page = url.includes("after_id")
        ? { data: [api("b")], has_more: false }
        : { data: [api("a")], has_more: true, last_id: "a" }
      return new Response(JSON.stringify(page))
    }
    const catalog = await fetchCatalog("tok", fake, 42)
    assert.deepEqual(catalog.models.map((m) => m.id), ["a", "b"])
    assert.equal(catalog.fetchedAt, 42)
    assert.equal(seen[0].headers.get("authorization"), "Bearer tok")
    assert.match(seen[0].headers.get("anthropic-beta")!, /oauth-2025-04-20/)
    assert.match(seen[1].url, /after_id=a/)
  })

  it("fails loudly instead of returning an empty catalog", async () => {
    const fake = async () => new Response("nope", { status: 401 })
    await assert.rejects(fetchCatalog("tok", fake), /401/)
  })
})

describe("catalog cache", () => {
  it("round-trips and ages out", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-"))
    try {
      const path = join(dir, "nested", "models.json")
      assert.equal(loadCatalog(path), null)
      saveCatalog({ fetchedAt: 1000, models: [api("a")] }, path)
      const loaded = loadCatalog(path)!
      assert.equal(loaded.models[0].id, "a")
      assert.equal(isStale(loaded, 1000 + CATALOG_TTL_MS - 1), false)
      assert.equal(isStale(loaded, 1000 + CATALOG_TTL_MS), true)
      assert.equal(isStale(null), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
