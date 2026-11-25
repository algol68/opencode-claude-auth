import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// The account's own model list (GET /v1/models) is the source of truth for
// which Anthropic models exist. models.dev lags new releases and lists models
// the subscription cannot use; this catalog fixes both. It is cached on disk
// so startup never waits on the network, refreshed when older than
// CATALOG_TTL_MS, and on demand through the /claude-models command.

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
export const CATALOG_PATH_VAR = "CLAUDE_AUTH_MODELS_CACHE"
const MODELS_URL = "https://api.anthropic.com/v1/models"

interface Supported {
  readonly supported?: boolean
}

export interface AnthropicApiModel {
  readonly id: string
  readonly display_name?: string
  readonly created_at?: string
  readonly line?: string
  readonly lifecycle?: string
  readonly max_input_tokens?: number
  readonly max_tokens?: number
  readonly capabilities?: {
    readonly image_input?: Supported
    readonly pdf_input?: Supported
    readonly thinking?: Supported & {
      readonly types?: Record<string, Supported>
    }
    readonly effort?: Supported & Record<string, unknown>
  }
}

export interface ModelCatalog {
  readonly fetchedAt: number
  readonly models: readonly AnthropicApiModel[]
}

// Structural subset of @opencode/schema Model.Info this module reads/writes.
export interface CatalogModel {
  id: string
  modelID?: string
  name: string
  family?: string
  status?: string
  enabled?: boolean
  limit?: { context: number; output: number; input?: number }
  time?: { released?: number }
  capabilities?: { tools: boolean; input: string[]; output: string[] }
  variants?: unknown[]
  cost?: unknown[]
  [key: string]: unknown
}

export function catalogPath(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env[CATALOG_PATH_VAR]) return env[CATALOG_PATH_VAR]!
  const cache = env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(cache, "opencode-claude-auth", "models.json")
}

export function loadCatalog(path: string = catalogPath()): ModelCatalog | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelCatalog
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.models))
      return null
    return parsed.models.length > 0 ? parsed : null
  } catch {
    return null
  }
}

export function saveCatalog(
  catalog: ModelCatalog,
  path: string = catalogPath(),
): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(catalog, null, 2), "utf-8")
  renameSync(tmp, path)
}

export function isStale(
  catalog: ModelCatalog | null,
  now: number = Date.now(),
): boolean {
  return !catalog || now - catalog.fetchedAt >= CATALOG_TTL_MS
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function fetchCatalog(
  accessToken: string,
  fetchImpl: Fetch = fetch,
  now: number = Date.now(),
): Promise<ModelCatalog> {
  const models: AnthropicApiModel[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = new URL(MODELS_URL)
    url.searchParams.set("limit", "100")
    if (after) url.searchParams.set("after_id", after)
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    })
    if (!response.ok)
      throw new Error(
        `GET /v1/models failed: ${response.status} ${(await response.text()).slice(0, 200)}`,
      )
    const body = (await response.json()) as {
      data?: AnthropicApiModel[]
      has_more?: boolean
      last_id?: string
    }
    models.push(...(body.data ?? []))
    if (!body.has_more || !body.last_id) break
    after = body.last_id
  }
  if (models.length === 0) throw new Error("GET /v1/models returned no models")
  return { fetchedAt: now, models }
}

const DATED = /-\d{8}$/

/** The API id a catalog entry is served by, if the account has it. */
function resolveApiModel(
  model: CatalogModel,
  byID: ReadonlyMap<string, AnthropicApiModel>,
): AnthropicApiModel | undefined {
  const target = model.modelID ?? model.id
  const exact = byID.get(target)
  if (exact) return exact
  // models.dev lists undated aliases (claude-haiku-4-5) next to the dated
  // id the API returns (claude-haiku-4-5-20251001); the alias still works.
  if (DATED.test(target)) return undefined
  for (const [id, api] of byID)
    if (id.startsWith(`${target}-`) && DATED.test(id)) return api
  return undefined
}

export function variantsFor(api: AnthropicApiModel): unknown[] {
  const thinking = api.capabilities?.thinking
  const types = thinking?.supported ? (thinking.types ?? {}) : {}
  const effort = api.capabilities?.effort
  const variants: unknown[] = []
  if (types.disabled?.supported)
    variants.push({ id: "none", settings: { thinking: { type: "disabled" } } })
  if (types.adaptive?.supported && effort?.supported) {
    for (const level of ["low", "medium", "high", "xhigh", "max"])
      if ((effort[level] as Supported | undefined)?.supported)
        variants.push({
          id: level,
          settings: {
            thinking: { type: "adaptive", display: "summarized" },
            effort: level,
          },
        })
  } else if (types.enabled?.supported) {
    const output = api.max_tokens ?? 32000
    variants.push(
      {
        id: "high",
        settings: { thinking: { type: "enabled", budgetTokens: 16000 } },
      },
      {
        id: "max",
        settings: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31999, output - 1),
          },
        },
      },
    )
  }
  return variants
}

function inputsFor(api: AnthropicApiModel): string[] {
  const input = ["text"]
  if (api.capabilities?.image_input?.supported) input.push("image")
  if (api.capabilities?.pdf_input?.supported) input.push("pdf")
  return input
}

function refreshFromApi(model: CatalogModel, api: AnthropicApiModel): void {
  if (api.max_input_tokens && api.max_tokens)
    model.limit = {
      ...model.limit,
      context: api.max_input_tokens,
      output: api.max_tokens,
    }
  model.status = api.lifecycle === "deprecated" ? "deprecated" : "active"
}

export function synthesizeModel(
  api: AnthropicApiModel,
  template: CatalogModel | undefined,
): CatalogModel {
  const base: CatalogModel = template
    ? structuredClone(template)
    : { id: api.id, name: api.id }
  // A template carries another model's identity; drop every per-model field.
  delete base.body
  delete base.headers
  const released = api.created_at ? Date.parse(api.created_at) : NaN
  const model: CatalogModel = {
    ...base,
    id: api.id,
    modelID: api.id,
    name: api.display_name ?? api.id,
    family: api.line ? `claude-${api.line}` : base.family,
    enabled: true,
    capabilities: {
      ...base.capabilities,
      tools: true,
      input: inputsFor(api),
      output: ["text"],
    },
    variants: variantsFor(api),
    time: Number.isFinite(released) ? { released } : {},
    cost: [],
  }
  refreshFromApi(model, api)
  return model
}

export interface Reconciled {
  readonly models: CatalogModel[]
  readonly added: string[]
  readonly removed: string[]
}

/**
 * Make the provider's models match the account catalog: keep models.dev
 * entries the account has (they carry curated variants and pricing), with
 * limits and lifecycle refreshed from the API; drop the ones it does not;
 * synthesize entries for models models.dev has not caught up with.
 */
export function reconcileModels(
  existing: readonly CatalogModel[],
  catalog: ModelCatalog,
): Reconciled {
  const byID = new Map(catalog.models.map((api) => [api.id, api]))
  const covered = new Set<string>()
  const models: CatalogModel[] = []
  const removed: string[] = []
  for (const original of existing) {
    const api = resolveApiModel(original, byID)
    if (!api) {
      removed.push(original.id)
      continue
    }
    covered.add(api.id)
    const model = structuredClone(original)
    refreshFromApi(model, api)
    models.push(model)
  }
  const newest = (line?: string) =>
    existing
      .filter((m) => !m.body && (!line || m.family === `claude-${line}`))
      .sort((a, b) => (b.time?.released ?? 0) - (a.time?.released ?? 0))[0]
  const added: string[] = []
  for (const api of catalog.models) {
    // opencode already hides deprecated models.dev entries; do not revive them.
    if (covered.has(api.id) || api.lifecycle === "deprecated") continue
    models.push(synthesizeModel(api, newest(api.line) ?? newest()))
    added.push(api.id)
  }
  return { models, added, removed }
}
