import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { findInstalledCliVersion } from "./cli-version.ts"
import {
  compareVersions,
  config,
  getCliVersion,
  getOutdatedCliRequirement,
  getUserAgent,
  noteRequiredCliVersion,
  resetCliVersionState,
  setDetectedCliVersion,
} from "./model-config.ts"
import { finishClaudeResponse, prepareClaudeRequest } from "./provider.ts"

const GATE_ERROR =
  "Claude Code 2.1.280 does not support this model; version 9.9.290 or newer is required. Run 'claude update'."

const billingVersion = (body: string) => {
  const system = (JSON.parse(body) as { system: { text: string }[] }).system
  return /cc_version=(\d+\.\d+\.\d+)\./.exec(system[0].text)?.[1]
}

afterEach(() => resetCliVersionState())

describe("effective Claude Code version", () => {
  it("compares versions numerically", () => {
    assert.ok(compareVersions("2.1.290", "2.1.280") > 0)
    assert.ok(compareVersions("2.10.0", "2.9.9") > 0)
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0)
  })

  it("uses the installed CLI when it is newer than the floor", () => {
    setDetectedCliVersion("9.0.0")
    assert.equal(getCliVersion(), "9.0.0")
    assert.match(getUserAgent(), /claude-cli\/9\.0\.0 /)
  })

  it("never goes below the floor for an older install", () => {
    setDetectedCliVersion("0.0.1")
    assert.equal(getCliVersion(), config.ccVersion)
  })

  it("learns a minimum from an API gate error", () => {
    assert.equal(noteRequiredCliVersion("some other error"), false)
    assert.equal(noteRequiredCliVersion(GATE_ERROR), true)
    assert.equal(getCliVersion(), "9.9.290")
    // Already at the demanded version: nothing new to retry with.
    assert.equal(noteRequiredCliVersion(GATE_ERROR), false)
  })

  it("lets ANTHROPIC_CLI_VERSION override everything", () => {
    process.env.ANTHROPIC_CLI_VERSION = "1.0.0"
    try {
      setDetectedCliVersion("9.0.0")
      assert.equal(noteRequiredCliVersion(GATE_ERROR), false)
      assert.equal(getCliVersion(), "1.0.0")
    } finally {
      delete process.env.ANTHROPIC_CLI_VERSION
    }
  })
})

describe("outdated Claude Code notice", () => {
  it("flags a demanded version newer than the installed CLI", () => {
    setDetectedCliVersion("2.1.280")
    assert.equal(getOutdatedCliRequirement(), null)
    noteRequiredCliVersion(GATE_ERROR)
    assert.equal(getOutdatedCliRequirement(), "9.9.290")
  })

  it("stays quiet when the installed CLI already satisfies it", () => {
    setDetectedCliVersion("9.9.300")
    noteRequiredCliVersion(GATE_ERROR)
    assert.equal(getOutdatedCliRequirement(), null)
  })

  it("tells the user to run claude update", async () => {
    const { outdatedCliMessage } = await import("./index.ts")
    const text = outdatedCliMessage("claude-mythos-5-2", "2.1.290", "2.1.280")
    assert.match(text, /claude-mythos-5-2 requires Claude Code 2\.1\.290/)
    assert.match(text, /2\.1\.280 is installed/)
    assert.match(text, /claude update/)
    assert.match(outdatedCliMessage("m", "1.0.0", null), /not found/)
  })
})

describe("findInstalledCliVersion", () => {
  it("parses claude --version", async () => {
    const version = await findInstalledCliVersion({
      run: async () => "2.1.332 (Claude Code)\n",
      listInstalled: () => [],
    })
    assert.equal(version, "2.1.332")
  })

  it("falls back to the newest installed version directory", async () => {
    const version = await findInstalledCliVersion({
      run: async () => {
        throw new Error("ENOENT")
      },
      listInstalled: () => ["2.1.302", "2.1.332", "2.1.40", ".tmp"],
    })
    assert.equal(version, "2.1.332")
  })

  it("returns null when Claude Code is not installed", async () => {
    const version = await findInstalledCliVersion({
      run: async () => {
        throw new Error("ENOENT")
      },
      listInstalled: () => [],
    })
    assert.equal(version, null)
  })
})

describe("version-gated model retry", () => {
  const body = JSON.stringify({
    model: "claude-mythos-5-2",
    system: [{ type: "text", text: "agent prompt" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  })

  it("re-signs and retries once when the API demands a newer client", async () => {
    const request = await prepareClaudeRequest(
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      "tok",
      undefined,
      { staticToken: true },
    )
    assert.equal(billingVersion(await request.clone().text()), config.ccVersion)
    const resent: Request[] = []
    const response = await finishClaudeResponse(
      request,
      new Response(JSON.stringify({ error: { message: GATE_ERROR } }), { status: 400 }),
      undefined,
      async (input, init) => {
        resent.push(new Request(input, init))
        return new Response("data: {}\n\n", { status: 200 })
      },
      { staticToken: true },
    )
    assert.equal(response.status, 200)
    assert.equal(resent.length, 1)
    assert.equal(billingVersion(await resent[0].clone().text()), "9.9.290")
    assert.match(resent[0].headers.get("user-agent")!, /claude-cli\/9\.9\.290 /)
    // Re-signed from the original body: identical to a fresh prepare.
    const fresh = await prepareClaudeRequest(
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      "tok",
      undefined,
      { staticToken: true },
    )
    assert.equal(await resent[0].clone().text(), await fresh.text())
  })

  it("does not retry other client errors", async () => {
    const request = await prepareClaudeRequest(
      new Request("https://api.anthropic.com/v1/messages", { method: "POST", body }),
      "tok",
      undefined,
      { staticToken: true },
    )
    let resent = 0
    const response = await finishClaudeResponse(
      request,
      new Response('{"error":{"message":"bad request"}}', { status: 400 }),
      undefined,
      async () => {
        resent++
        return new Response("{}")
      },
      { staticToken: true },
    )
    assert.equal(response.status, 400)
    assert.equal(resent, 0)
  })
})
