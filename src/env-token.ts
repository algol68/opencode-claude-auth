import { Credential } from "@opencode/plugin"
import {
  CLAUDE_CODE_OAUTH_METADATA_KEY,
  CLAUDE_CODE_OAUTH_METADATA_VALUE,
  METHOD_ID,
} from "./oauth-method.ts"

// Long-lived token minted by `claude setup-token` (the same variable Claude
// Code itself honours). It carries no refresh token, so when it is set the
// plugin uses it verbatim and bypasses the Keychain / credentials-file store
// and all OAuth refresh, recovery, and rotation machinery.
export const ENV_OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN"

// Credential metadata `source` for a credential minted from the env token.
// Never a real Keychain service / file path, so account lookups by source
// cannot accidentally resolve it to a stored account and re-sign the request
// with that account's token.
export const ENV_TOKEN_SOURCE = `env:${ENV_OAUTH_TOKEN_VAR}`

// The real expiry is not knowable from the token itself. setup-token tokens
// are issued for roughly a year; this nominal value only exists so OpenCode
// treats the stored credential as live and does not call refresh constantly.
export const ENV_TOKEN_NOMINAL_TTL_MS = 365 * 24 * 60 * 60 * 1000

export function getEnvToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const token = env[ENV_OAUTH_TOKEN_VAR]?.trim()
  return token ? token : null
}

export function isEnvTokenCredential(value: {
  readonly metadata?: Record<string, unknown>
}): boolean {
  return value.metadata?.source === ENV_TOKEN_SOURCE
}

/** The OAuth credential `/connect` stores when env-token mode is active. */
export function buildEnvTokenCredential(
  token: string,
  now: number = Date.now(),
): Credential.OAuth {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    access: token,
    refresh: "",
    expires: now + ENV_TOKEN_NOMINAL_TTL_MS,
    metadata: {
      [CLAUDE_CODE_OAUTH_METADATA_KEY]: CLAUDE_CODE_OAUTH_METADATA_VALUE,
      source: ENV_TOKEN_SOURCE,
      label: `Claude Code (${ENV_OAUTH_TOKEN_VAR})`,
    },
  })
}

/**
 * Refresh for an env-token credential never touches the network: there is no
 * refresh token. It re-reads the variable so a token rotated in the shell
 * profile is picked up on the next refresh, and keeps the stored one if the
 * variable has since been unset (the stored token may still be valid).
 */
export function refreshEnvTokenCredential(
  value: Credential.OAuth,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): Credential.OAuth {
  return buildEnvTokenCredential(getEnvToken(env) ?? value.access, now)
}
