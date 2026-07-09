package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatComposerDraftTest {
  @Test
  fun replyDraftPreservesExistingComposerText() {
    val draft = ChatDraft(text = "> quoted\n\n", placement = ChatDraftPlacement.BeforeExisting)

    assertEquals("> quoted\n\nmy reply", mergeChatDraft(draft, "my reply"))
  }

  @Test
  fun replacementDraftReplacesExistingComposerText() {
    val draft = ChatDraft(text = "repeat this", placement = ChatDraftPlacement.Replace)

    assertEquals("repeat this", mergeChatDraft(draft, "existing text"))
  }
}
