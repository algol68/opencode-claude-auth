import { execFile } from "node:child_process"
import { readdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { compareVersions, setDetectedCliVersion } from "./model-config.ts"
import { log } from "./logger.ts"

// Find the installed Claude Code version. `claude --version` is the general
// answer; the native installer's versions directory is the fallback for a
// service process whose PATH does not include ~/.local/bin.

const VERSION = /(\d+\.\d+\.\d+)/

export interface CliVersionDeps {
  readonly run: () => Promise<string>
  readonly listInstalled: () => string[]
}

const extraPath = () =>
  [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].join(delimiter)

export const realCliVersionDeps: CliVersionDeps = {
  run: () =>
    new Promise((resolve, reject) =>
      execFile(
        "claude",
        ["--version"],
        {
          timeout: 5000,
          env: {
            ...process.env,
            PATH: [process.env.PATH, extraPath()].filter(Boolean).join(delimiter),
          },
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    ),
  listInstalled: () => {
    try {
      return readdirSync(join(homedir(), ".local", "share", "claude", "versions"))
    } catch {
      return []
    }
  },
}

export async function findInstalledCliVersion(
  deps: CliVersionDeps = realCliVersionDeps,
): Promise<string | null> {
  try {
    const match = VERSION.exec(await deps.run())
    if (match) return match[1]
  } catch {
    // fall through to the versions directory
  }
  const installed = deps
    .listInstalled()
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort(compareVersions)
  return installed.at(-1) ?? null
}

export async function detectCliVersion(
  deps: CliVersionDeps = realCliVersionDeps,
): Promise<string | null> {
  const version = await findInstalledCliVersion(deps)
  setDetectedCliVersion(version)
  log("cli_version_detected", { version })
  return version
}
