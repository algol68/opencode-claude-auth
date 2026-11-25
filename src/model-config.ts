export interface ModelOverride {
  exclude?: string[]
  add?: string[]
  disableEffort?: boolean
}

export interface ModelConfig {
  ccVersion: string
  baseBetas: string[]
  longContextBetas: string[]
  modelOverrides: Record<string, ModelOverride>
}

export const config: ModelConfig = {
  ccVersion: "2.1.332",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "extended-cache-ttl-2025-04-11",
  ],
  longContextBetas: [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
  ],
  // NOTE: getModelOverride is first-match-wins. Keep "haiku" ahead of any
  // "4-5" add so claude-haiku-4-5 never receives effort. "opus-4-5" is
  // more specific than a bare "4-5" would be (sonnet-4-5 still omits
  // effort). Pinned by the "effort beta" test in betas.test.ts from
  // Claude CLI 2.1.257 intercept traffic.
  modelOverrides: {
    haiku: {
      exclude: ["effort-2025-11-24"],
      disableEffort: true,
    },
    "opus-4-5": {
      add: ["effort-2025-11-24"],
    },
    "4-6": {
      add: ["effort-2025-11-24"],
    },
    "4-7": {
      add: ["effort-2025-11-24"],
    },
  },
}

/**
 * Find the override entry matching a model ID.
 * Keys are matched via includes() against the lowercased model ID.
 *
 * First-match-wins: if multiple keys match, only the first (by insertion
 * order) is returned. List more specific keys before broader ones
 * (e.g. "opus-4-6" before "opus") so they take priority.
 */
export function getModelOverride(modelId: string): ModelOverride | null {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(config.modelOverrides)) {
    if (lower.includes(pattern)) return override
  }
  return null
}

// The Claude Code version sent with every request. Anthropic gates new models
// on a minimum client version, so a hardcoded value goes stale with each
// release. The effective version is the highest of: the floor in `config`, the
// installed `claude` CLI, and any minimum the API has demanded in an error.
// ANTHROPIC_CLI_VERSION still overrides everything.
let detectedVersion: string | null = null
let requiredVersion: string | null = null

const VERSION = /^\d+\.\d+\.\d+$/

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

const highest = (...versions: (string | null)[]): string =>
  versions
    .filter((v): v is string => !!v && VERSION.test(v))
    .reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))

export function getCliVersion(): string {
  return (
    process.env.ANTHROPIC_CLI_VERSION ??
    highest(config.ccVersion, detectedVersion, requiredVersion)
  )
}

/** The installed Claude Code version, if one was found. */
export function getInstalledCliVersion(): string | null {
  return detectedVersion
}

/**
 * When the API has demanded a newer Claude Code than the one installed, the
 * version it demanded; otherwise null. The plugin works around the gap, but the
 * user should still update so Claude Code itself can use the model.
 */
export function getOutdatedCliRequirement(): string | null {
  if (!requiredVersion || process.env.ANTHROPIC_CLI_VERSION) return null
  if (detectedVersion && compareVersions(detectedVersion, requiredVersion) >= 0)
    return null
  return requiredVersion
}

export function setDetectedCliVersion(version: string | null): void {
  detectedVersion = version && VERSION.test(version) ? version : null
}

const REQUIRED = /version (\d+\.\d+\.\d+) or newer is required/i

/**
 * Learn a minimum version from an API error such as "Claude Code 2.1.280 does
 * not support this model; version 2.1.290 or newer is required". Returns true
 * when the effective version went up, i.e. a retry can succeed.
 */
export function noteRequiredCliVersion(errorText: string): boolean {
  const match = REQUIRED.exec(errorText)
  if (!match || process.env.ANTHROPIC_CLI_VERSION) return false
  const before = getCliVersion()
  requiredVersion = highest(requiredVersion, match[1])
  return compareVersions(getCliVersion(), before) > 0
}

export function resetCliVersionState(): void {
  detectedVersion = null
  requiredVersion = null
}

export function getUserAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, sdk-cli)`
  )
}
