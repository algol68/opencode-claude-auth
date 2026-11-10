import { Plugin, Provider } from "@opencode/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration"
import type { SessionRequest } from "@opencode/plugin/promise/session"
import {
  initAccounts,
  loadPersistedAccountSource,
  setActiveAccountSource,
} from "./credentials.ts"
import {
  buildEnvTokenCredential,
  ENV_OAUTH_TOKEN_VAR,
  getEnvToken,
  isEnvTokenCredential,
  refreshEnvTokenCredential,
} from "./env-token.ts"
import { readAllClaudeAccounts } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import {
  authorizeOAuth,
  CLAUDE_CODE_OAUTH_METADATA_KEY,
  CLAUDE_CODE_OAUTH_METADATA_VALUE,
  INTEGRATION_ID,
  labelOAuthCredential,
  METHOD_ID,
  oauthMethodDescriptor,
  realOAuthDeps,
  refreshOAuthCredential,
} from "./oauth-method.ts"
import { finishClaudeResponse, prepareClaudeRequest } from "./provider.ts"

export * from "./betas.ts"
export * from "./credentials.ts"
export * from "./env-token.ts"
export * from "./oauth-method.ts"
export * from "./provider.ts"
export * from "./signing.ts"
export * from "./transforms.ts"

const PROVIDER_ID = Provider.ID.make("anthropic")
const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

/**
 * Session request kinds that reach the model and are billed to the connected
 * subscription. OpenCode 2 dispatches one hook per kind - `context` drives the
 * agent loop, and compaction, generation and title are issued alongside it - so
 * a hook registered for only one of them leaves the rest without the identity
 * Claude Code requests are expected to carry.
 */
export const IDENTITY_REQUEST_HOOKS = [
  "context",
  "compaction",
  "generate",
  "title",
] as const

/** Prepends the Claude Code identity to an Anthropic request, once. */
export function injectClaudeIdentity(event: SessionRequest): void {
  if (event.model.providerID !== PROVIDER_ID) return
  if (event.system.some((part) => part.text.includes(SYSTEM_IDENTITY))) return
  event.system.unshift({ type: "text", text: SYSTEM_IDENTITY })
}

export function oauth(
  accounts: ReturnType<typeof readAllClaudeAccounts>,
  envToken: string | null = null,
): IntegrationOAuthMethodRegistration {
  return {
    integrationID: INTEGRATION_ID,
    // No account chooser in env-token mode: there is exactly one token.
    method: oauthMethodDescriptor(envToken ? [] : accounts),
    authorize: async (inputs) => {
      if (envToken)
        return {
          mode: "auto" as const,
          url: "",
          instructions: `Using the token from ${ENV_OAUTH_TOKEN_VAR}. Unset it to import a Claude Code account instead.`,
          callback: Promise.resolve(buildEnvTokenCredential(envToken)),
        }
      const value = await authorizeOAuth(inputs, accounts, realOAuthDeps)
      return {
        mode: "auto" as const,
        url: "",
        instructions: "Claude Code credentials imported from this device.",
        callback: Promise.resolve(value),
      }
    },
    // Dispatch on the stored credential, not on the current mode: a
    // credential imported from the Keychain keeps refreshing normally even
    // if the variable is set later, and vice versa.
    refresh: async (value) =>
      isEnvTokenCredential(value)
        ? refreshEnvTokenCredential(value)
        : refreshOAuthCredential(value, realOAuthDeps),
    label: (value) => labelOAuthCredential(value),
  } satisfies IntegrationOAuthMethodRegistration
}

export const ClaudeAuthPlugin = Plugin.define({
  id: "griffinmartin.claude-auth",
  setup: async (ctx) => {
    initLogger()
    // Read once at setup: switching modes mid-process would mix a static
    // token with refresh state from the store, which is exactly what this
    // mode exists to avoid.
    const envToken = getEnvToken()
    if (envToken) log("env_token_mode_enabled", { source: ENV_OAUTH_TOKEN_VAR })
    let accounts: ReturnType<typeof readAllClaudeAccounts> = []
    try {
      // In env-token mode the store is irrelevant; reading it would only
      // risk a Keychain prompt or a spurious failure on a headless host.
      if (!envToken) accounts = readAllClaudeAccounts()
    } catch (cause) {
      log("plugin_init_error", { cause: String(cause) })
    }
    initAccounts(accounts)
    const selected = loadPersistedAccountSource() ?? accounts[0]?.source
    if (selected) setActiveAccountSource(selected)

    await ctx.integration.transform((draft) => {
      draft.update(INTEGRATION_ID, (integration) => {
        integration.name = "Anthropic"
      })
      draft.method.update(oauth(accounts, envToken))
    })

    // The Anthropic integration keeps its built-in API-key method alongside
    // the subscription method registered above, so only OAuth usage is free.
    const hasSubscriptionConnection = async (): Promise<boolean> => {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return false
      const credential = await ctx.integration.connection.resolve(connection)
      return credential?.type === "oauth" && credential.methodID === METHOD_ID
    }

    let subscription: boolean = false
    const loadConnection = async () => {
      try {
        subscription = await hasSubscriptionConnection()
      } catch (cause) {
        subscription = false
        log("connection_lookup_failed", { cause: String(cause) })
      }
    }
    await loadConnection()

    await ctx.provider.transform((provider) => {
      const anthropic = provider.get(PROVIDER_ID)
      if (!anthropic) return
      provider.update(PROVIDER_ID, (info) => {
        info.name = "Anthropic"
        info.integrationID = INTEGRATION_ID
      })
      for (const [modelID] of anthropic.models) {
        provider.models.update(PROVIDER_ID, modelID, (model) => {
          if (subscription) model.cost = []
        })
      }
    })

    // Re-evaluate when the user switches credentials so the provider follows
    // the active connection instead of whatever was selected at startup.
    const watcher = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: watcher.signal,
      })) {
        if (
          event.type === "credential.updated" ||
          (event.type === "credential.switched" &&
            event.data.integrationID === INTEGRATION_ID)
        ) {
          const before: boolean = subscription
          await loadConnection()
          if (subscription !== before) await ctx.provider.reload()
        }
      }
    })().catch((cause) => {
      if (!watcher.signal.aborted)
        log("connection_watch_failed", { cause: String(cause) })
    })

    for (const kind of IDENTITY_REQUEST_HOOKS)
      await ctx.session.hook(kind, (event) => {
        if (subscription) injectClaudeIdentity(event)
      })

    // OpenCode's native Anthropic provider owns prompt conversion and streaming.
    // These HTTP hooks apply only the Claude Code subscription wire contract.
    const requests = new WeakMap<
      Request,
      { source?: string; staticToken: boolean }
    >()
    await ctx.session.hook("http.request", async (event) => {
      if (event.model.providerID !== PROVIDER_ID) return
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return
      const credential = await ctx.integration.connection.resolve(connection)
      if (
        credential?.type !== "oauth" ||
        credential.methodID !== METHOD_ID ||
        credential.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY] !==
          CLAUDE_CODE_OAUTH_METADATA_VALUE
      )
        return
      const source =
        typeof credential.metadata.source === "string"
          ? credential.metadata.source
          : undefined
      const staticToken = isEnvTokenCredential(credential)
      event.request = await prepareClaudeRequest(
        event.request,
        // Prefer the live variable over the stored copy so a token rotated
        // in the environment takes effect without reconnecting.
        staticToken ? (envToken ?? credential.access) : credential.access,
        source,
        { staticToken },
      )
      requests.set(event.request, { source, staticToken })
    })
    await ctx.session.hook("http.response", async (event) => {
      const context = requests.get(event.request)
      if (!context) return
      requests.delete(event.request)
      event.response = await finishClaudeResponse(
        event.request,
        event.response,
        context.source,
        fetch,
        { staticToken: context.staticToken },
      )
    })

    if (envToken) {
      log("plugin_init", { mode: "env_token" })
    } else if (accounts.length === 0) {
      log("plugin_init_no_accounts", { reason: "no credentials found" })
    } else {
      log("plugin_init", {
        accountCount: accounts.length,
        sources: accounts.map((account) => account.source),
      })
    }

    return () => {
      watcher.abort()
    }
  },
})

export default ClaudeAuthPlugin
