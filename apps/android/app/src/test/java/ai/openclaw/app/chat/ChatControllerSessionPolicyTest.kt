package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerSessionPolicyTest {
  @Test
  fun applyMainSessionKeyMovesCurrentSessionWhenStillOnDefault() {
    val state =
      applyMainSessionKey(
        currentSessionKey = "main",
        appliedMainSessionKey = "main",
        nextMainSessionKey = "agent:ops:node-device",
      )

    assertEquals("agent:ops:node-device", state.currentSessionKey)
    assertEquals("agent:ops:node-device", state.appliedMainSessionKey)
  }

  @Test
  fun applyMainSessionKeyKeepsUserSelectedSession() {
    val state =
      applyMainSessionKey(
        currentSessionKey = "custom",
        appliedMainSessionKey = "agent:ops:node-old",
        nextMainSessionKey = "agent:ops:node-new",
      )

    assertEquals("custom", state.currentSessionKey)
    assertEquals("agent:ops:node-new", state.appliedMainSessionKey)
  }

  @Test
  fun staleHistoryLoadCannotApplyAfterSessionSwitch() {
    assertTrue(
      isCurrentHistoryLoad(
        requestedSessionKey = "agent:one",
        currentSessionKey = "agent:one",
        requestGeneration = 2,
        activeGeneration = 2,
      ),
    )
    assertFalse(
      isCurrentHistoryLoad(
        requestedSessionKey = "agent:old",
        currentSessionKey = "agent:new",
        requestGeneration = 1,
        activeGeneration = 2,
      ),
    )
    assertFalse(
      isCurrentHistoryLoad(
        requestedSessionKey = "agent:new",
        currentSessionKey = "agent:new",
        requestGeneration = 1,
        activeGeneration = 2,
      ),
    )
  }
}
