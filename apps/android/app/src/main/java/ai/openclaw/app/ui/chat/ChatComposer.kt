package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement

internal fun mergeChatDraft(
  draft: ChatDraft?,
  currentInput: String,
): String? {
  val text = draft?.text?.takeIf { it.isNotBlank() } ?: return null
  return when (draft.placement) {
    ChatDraftPlacement.Replace -> text
    ChatDraftPlacement.BeforeExisting -> text + currentInput
  }
}
