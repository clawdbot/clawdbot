package ai.openclaw.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearSessionScopeTest {
  @Test
  fun discardsStatusSessionWhenLaterListReportsDifferentAgent() {
    assertNull(
      coherentWearActiveSessionKey(
        statusAgentId = "agent-a",
        statusSessionKey = "agent:agent-a:main",
        sessionListAgentId = "agent-b",
      ),
    )
  }

  @Test
  fun keepsStatusSessionForMatchingAndLegacyPhoneSnapshots() {
    val sessionKey = "agent:agent-a:main"

    assertEquals(sessionKey, coherentWearActiveSessionKey("agent-a", sessionKey, "agent-a"))
    assertEquals(sessionKey, coherentWearActiveSessionKey("agent-a", sessionKey, null))
  }

  @Test
  fun exposesModelOnlyForPhoneActiveSession() {
    assertEquals("openai/model", wearSelectedModelRef("agent:main", "agent:main", "openai/model"))
    assertNull(wearSelectedModelRef("agent:other", "agent:main", "openai/model"))
    assertNull(wearSelectedModelRef(null, "agent:main", "openai/model"))
  }
}
