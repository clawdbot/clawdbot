package ai.openclaw.app.ui.chat

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatSheetContentTest {
  @Test
  fun resolvesPendingAssistantAutoSendOnlyWhenChatIsReady() {
    assertNull(
      resolvePendingAssistantAutoSend(
        pendingPrompt = "summarize mail",
        healthOk = false,
        pendingRunCount = 0,
      ),
    )
    assertNull(
      resolvePendingAssistantAutoSend(
        pendingPrompt = "summarize mail",
        healthOk = true,
        pendingRunCount = 1,
      ),
    )
    assertEquals(
      "summarize mail",
      resolvePendingAssistantAutoSend(
        pendingPrompt = "  summarize mail  ",
        healthOk = true,
        pendingRunCount = 0,
      ),
    )
  }

  @Test
  fun keepsPendingAssistantAutoSendWhenDispatchRejected() =
    runBlocking {
      var dispatchedPrompt: String? = null

      val consumed =
        dispatchPendingAssistantAutoSend(
          pendingPrompt = "summarize mail",
          healthOk = true,
          pendingRunCount = 0,
        ) { prompt ->
          dispatchedPrompt = prompt
          false
        }

      assertFalse(consumed)
      assertEquals("summarize mail", dispatchedPrompt)
    }

  @Test
  fun clearsPendingAssistantAutoSendOnlyAfterAcceptedDispatch() =
    runBlocking {
      var dispatchedPrompt: String? = null

      val consumed =
        dispatchPendingAssistantAutoSend(
          pendingPrompt = "summarize mail",
          healthOk = true,
          pendingRunCount = 0,
        ) { prompt ->
          dispatchedPrompt = prompt
          true
        }

      assertTrue(consumed)
      assertEquals("summarize mail", dispatchedPrompt)
    }
}
