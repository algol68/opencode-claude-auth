import { Plugin } from "@opencode/plugin/tui"
import { type NoticeItem, noticeToast } from "./notice.ts"

// Synthetic notes posted with resume:false wait in the session inbox until
// the next turn, so the TUI shows them as toasts the moment they are queued.
export default Plugin.define({
  id: "griffinmartin.claude-auth.tui",
  setup(context) {
    return context.data.on("session.inbox.enqueued", (event) => {
      const toast = noticeToast(
        (event.data as { item?: NoticeItem } | undefined)?.item,
      )
      if (toast) context.ui.toast.show(toast)
    })
  },
})
