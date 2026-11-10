import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildEnvTokenCredential,
  CLAUDE_CODE_OAUTH_METADATA_KEY,
  CLAUDE_CODE_OAUTH_METADATA_VALUE,
  ENV_OAUTH_TOKEN_VAR,
  ENV_TOKEN_NOMINAL_TTL_MS,
  ENV_TOKEN_SOURCE,
  finishClaudeResponse,
  getEnvToken,
  initAccounts,
  isEnvTokenCredential,
  METHOD_ID,
  oauth,
  prepareClaudeRequest,
  refreshEnvTokenCredential,
  setActiveAccountSource,
} from "./index.ts"

const messageRequest = () =>
  new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }),
  })

// A stored account whose token must never leak into an env-token request.
const STORED = {
  label: "Claude Max",
  source: "Claude Code-credentials-stored01",
  credentials: {
    accessToken: "stored-token",
    refreshToken: "stored-refresh",
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  },
}

describe("getEnvToken", () => {
  it("reads and trims the variable", () => {
    assert.equal(
      getEnvToken({ [ENV_OAUTH_TOKEN_VAR]: "  sk-ant-oat01-x \n" }),
      "sk-ant-oat01-x",
    )
  })

  it("treats unset, empty and whitespace-only as off", () => {
    assert.equal(getEnvToken({}), null)
    assert.equal(getEnvToken({ [ENV_OAUTH_TOKEN_VAR]: "" }), null)
    assert.equal(getEnvToken({ [ENV_OAUTH_TOKEN_VAR]: "   " }), null)
  })
})

describe("env-token credential", () => {
  it("is a subscription OAuth credential the request hook will sign", () => {
    const value = buildEnvTokenCredential("tok", 1_000)
    assert.equal(value.type, "oauth")
    assert.equal(value.methodID, METHOD_ID)
    assert.equal(value.access, "tok")
    assert.equal(value.refresh, "")
    assert.equal(value.expires, 1_000 + ENV_TOKEN_NOMINAL_TTL_MS)
    assert.equal(
      value.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY],
      CLAUDE_CODE_OAUTH_METADATA_VALUE,
    )
    assert.equal(value.metadata?.source, ENV_TOKEN_SOURCE)
    assert.equal(isEnvTokenCredential(value), true)
  })

  it("is not confused with a Keychain-imported credential", () => {
    assert.equal(
      isEnvTokenCredential({ metadata: { source: STORED.source } }),
      false,
    )
    assert.equal(isEnvTokenCredential({}), false)
  })

  it("refresh picks up a rotated variable without touching the network", () => {
    const stored = buildEnvTokenCredential("old", 0)
    const fresh = refreshEnvTokenCredential(
      stored,
      { [ENV_OAUTH_TOKEN_VAR]: "new" },
      5_000,
    )
    assert.equal(fresh.access, "new")
    assert.equal(fresh.expires, 5_000 + ENV_TOKEN_NOMINAL_TTL_MS)
  })

  it("refresh keeps the stored token once the variable is unset", () => {
    const stored = buildEnvTokenCredential("old", 0)
    assert.equal(refreshEnvTokenCredential(stored, {}, 5_000).access, "old")
  })
})

describe("oauth method in env-token mode", () => {
  it("offers no account chooser even when accounts exist", () => {
    const registration = oauth([STORED, { ...STORED, source: "other" }], "tok")
    assert.equal(registration.method.form, undefined)
  })

  it("authorizes with the env token, not a stored account", async () => {
    const registration = oauth([STORED], "env-tok")
    const auth = await registration.authorize({})
    assert.equal(auth.mode, "auto")
    assert.match(auth.instructions, new RegExp(ENV_OAUTH_TOKEN_VAR))
    const value = await (auth.mode === "auto" ? auth.callback : null)
    assert.equal(value?.access, "env-tok")
    assert.equal(value?.metadata?.source, ENV_TOKEN_SOURCE)
  })

  it("refreshes an env credential locally", async () => {
    const registration = oauth([], "env-tok")
    const stored = buildEnvTokenCredential("env-tok", 0)
    const fresh = await registration.refresh!(stored)
    assert.equal(isEnvTokenCredential(fresh), true)
    assert.equal(fresh.refresh, "")
  })
})

describe("static-token requests", () => {
  it("signs with the env token even when a stored account is active", async () => {
    initAccounts([structuredClone(STORED)])
    setActiveAccountSource(STORED.source)
    try {
      const request = await prepareClaudeRequest(
        messageRequest(),
        "env-tok",
        ENV_TOKEN_SOURCE,
        { staticToken: true },
      )
      assert.equal(request.headers.get("authorization"), "Bearer env-tok")
    } finally {
      initAccounts([])
    }
  })

  for (const status of [401, 429]) {
    it(`surfaces a ${status} instead of swapping in a stored account`, async () => {
      initAccounts([structuredClone(STORED)])
      setActiveAccountSource(STORED.source)
      let resent = 0
      try {
        const request = await prepareClaudeRequest(
          messageRequest(),
          "env-tok",
          ENV_TOKEN_SOURCE,
          { staticToken: true },
        )
        const response = await finishClaudeResponse(
          request,
          new Response("{}", { status }),
          ENV_TOKEN_SOURCE,
          async () => {
            resent++
            return new Response("{}", { status: 200 })
          },
          { staticToken: true },
        )
        assert.equal(response.status, status)
        assert.equal(resent, 0)
      } finally {
        initAccounts([])
      }
    })
  }
})
