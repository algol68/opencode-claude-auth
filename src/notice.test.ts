import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { NOTICE_SOURCE } from "./index.ts"
import { noticeToast } from "./notice.ts"

const item = (kind: string, text: string, source: string = NOTICE_SOURCE) => ({
  payload: { text, metadata: { source, kind } },
})

describe("noticeToast", () => {
  it("toasts the /claude-models result", () => {
    assert.deepEqual(noticeToast(item("models", "17 models.")), {
      title: "Claude models",
      message: "17 models.",
      variant: "info",
      duration: 10000,
    })
  })

  it("warns about an outdated Claude Code without the agent instruction", () => {
    const toast = noticeToast(
      item("cli-update", "Please run `claude update`. Agent: tell the user this."),
    )
    assert.equal(toast?.variant, "warning")
    assert.equal(toast?.message, "Please run `claude update`.")
  })

  it("ignores other plugins' notes and empty ones", () => {
    assert.equal(noticeToast(item("models", "x", "vlad_vault")), null)
    assert.equal(noticeToast(item("models", "")), null)
    assert.equal(noticeToast(undefined), null)
  })
})
