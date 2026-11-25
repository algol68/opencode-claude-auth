// Kept free of @opencode/plugin/tui so it can be unit-tested under Node.
// Must match NOTICE_SOURCE in index.ts. Not imported from there: the TUI loads
// tui.ts on its own, and index.ts pulls in the whole server part.
const NOTICE_SOURCE = "claude-auth"

export interface NoticeItem {
  readonly payload?: {
    readonly text?: string
    readonly metadata?: { readonly source?: unknown; readonly kind?: unknown }
  }
}

/** The toast for one of this plugin's synthetic notes, or null. */
export function noticeToast(item: NoticeItem | undefined): {
  title: string
  message: string
  variant: "info" | "warning"
  duration: number
} | null {
  const metadata = item?.payload?.metadata
  if (metadata?.source !== NOTICE_SOURCE) return null
  // The note to the agent ends with an instruction aimed at it; drop that.
  const message = String(item?.payload?.text ?? "")
    .replace(/\s*Agent: tell the user this\.\s*$/, "")
    .trim()
  if (!message) return null
  if (metadata.kind === "cli-update")
    return { title: "Claude Code", message, variant: "warning", duration: 15000 }
  return { title: "Claude models", message, variant: "info", duration: 10000 }
}
