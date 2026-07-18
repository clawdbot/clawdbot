package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkEntry
import ai.openclaw.wear.shared.WearRealtimeTalkRole
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MainActivityTest {
  @Test
  fun assistantReplyMustBelongToOriginatingSession() {
    val reply = WearChatMessage(id = "reply-2", role = "assistant", text = "Second", timestamp = 2L)

    assertNull(
      newAssistantReplyForSession(
        awaitingSessionId = "session-a",
        activeSessionId = "session-b",
        expectedAssistantKey = "reply-1",
        latestAssistantMessage = reply,
      ),
    )
    assertEquals(
      reply,
      newAssistantReplyForSession(
        awaitingSessionId = "session-a",
        activeSessionId = "session-a",
        expectedAssistantKey = "reply-1",
        latestAssistantMessage = reply,
      ),
    )
  }

  @Test
  fun realtimeThinkingOverrideSurvivesUnrelatedActiveUpdates() {
    val streaming = realtimeSnapshot(entryStreaming = true)
    val completed = realtimeSnapshot(entryStreaming = false)
    val unrelatedUpdate =
      completed.copy(
        realtimeTalk = completed.realtimeTalk.copy(statusText = "Still active"),
      )

    val newTurnId = nextRealtimeThinkingTurnId(streaming, completed, currentTurnId = null)

    assertEquals("user-1", newTurnId)
    assertEquals("user-1", nextRealtimeThinkingTurnId(completed, unrelatedUpdate, newTurnId))
    assertNull(
      nextRealtimeThinkingTurnId(
        unrelatedUpdate,
        unrelatedUpdate.copy(realtimeTalk = unrelatedUpdate.realtimeTalk.copy(active = false)),
        newTurnId,
      ),
    )
  }

  private fun realtimeSnapshot(entryStreaming: Boolean): WearConversationSnapshot =
    WearConversationSnapshot(
      gatewayState = WearGatewayState.CONNECTED,
      realtimeTalk =
        WearRealtimeTalkSnapshot(
          active = true,
          conversation =
            listOf(
              WearRealtimeTalkEntry(
                id = "user-1",
                role = WearRealtimeTalkRole.USER,
                text = "Hello",
                streaming = entryStreaming,
              ),
            ),
        ),
    )
}
