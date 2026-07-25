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

  @Test
  fun modelCatalogScopeTracksBothPhoneAndModel() {
    val requested =
      WearSession(
        key = "agent:main",
        title = "Main",
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-a",
        modelRef = "openai/model-a",
      )

    assertEquals(false, wearModelCatalogScopeChanged(requested, requested.copy()))
    assertEquals(true, wearModelCatalogScopeChanged(requested, requested.copy(phoneNodeId = "phone-b")))
    assertEquals(true, wearModelCatalogScopeChanged(requested, requested.copy(modelRef = "openai/model-b")))
  }

  @Test
  fun modelCatalogResultRequiresTheFullRequestedScope() {
    val requested =
      WearSession(
        key = "agent:main",
        title = "Main",
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-a",
        modelRef = "openai/model-a",
      )

    assertEquals(true, wearSessionRequestIsCurrent(requested, requested.copy(), "phone-a"))
    assertEquals(
      false,
      wearSessionRequestIsCurrent(requested, requested.copy(key = "agent:other"), "phone-a"),
    )
    assertEquals(
      false,
      wearSessionRequestIsCurrent(requested, requested.copy(modelRef = "openai/model-b"), "phone-a"),
    )
    assertEquals(false, wearSessionRequestIsCurrent(requested, requested.copy(), "phone-b"))
    assertEquals(
      false,
      wearSessionRequestIsCurrent(requested, requested.copy(phoneNodeId = "phone-b"), "phone-b"),
    )
  }

  @Test
  fun transcriptResultPreservesNewerModelWithinTheSamePhoneSession() {
    val requested =
      WearSession(
        key = "agent:main",
        title = "Main",
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-a",
        modelRef = "openai/model-a",
      )

    assertEquals(
      true,
      wearTranscriptRequestIsCurrent(requested, requested.copy(modelRef = "openai/model-b"), "phone-a"),
    )
    assertEquals(false, wearTranscriptRequestIsCurrent(requested, requested.copy(), "phone-b"))
    assertEquals(
      false,
      wearTranscriptRequestIsCurrent(requested, requested.copy(phoneNodeId = "phone-b"), "phone-b"),
    )
  }

  @Test
  fun snapshotResponsesRequireTheSamePhoneAndEventStream() {
    assertEquals(true, wearSnapshotSourcesMatch("phone-a", "stream-a", "phone-a", "stream-a"))
    assertEquals(false, wearSnapshotSourcesMatch("phone-a", "stream-a", "phone-b", "stream-a"))
    assertEquals(false, wearSnapshotSourcesMatch("phone-a", "stream-a", "phone-a", "stream-b"))
    assertEquals(true, wearSnapshotSourcesMatch("phone-a", null, "phone-a", null))
  }

  @Test
  fun agentSwitchDropsThePreviousSessionModelAndStreamTogether() {
    val previousSession =
      WearSession(
        key = "agent:old:thread-1",
        title = "Old",
        updatedAt = null,
        hasActiveRun = true,
        phoneNodeId = "phone-a",
        modelRef = "openai/old",
      )
    val state =
      WearUiState(
        activeAgentId = "old",
        sessions = listOf(previousSession),
        selectedSession = previousSession,
        selectedModelRef = "openai/old",
        models = listOf(WearModel("openai/old", "Old")),
        messages = listOf(WearChatMessage("m1", "assistant", "old reply", 1)),
        streamText = "old stream",
        activeRunId = "run-old",
      )

    val switched = state.switchAgentContext("new")

    assertEquals("new", switched.activeAgentId)
    assertNull(switched.selectedSession)
    assertNull(switched.selectedModelRef)
    assertNull(switched.streamText)
    assertNull(switched.activeRunId)
    assertEquals(emptyList<WearSession>(), switched.sessions)
    assertEquals(emptyList<WearModel>(), switched.models)
    assertEquals(emptyList<WearChatMessage>(), switched.messages)
  }

  @Test
  fun sessionSwitchMovesModelAndClearsThePreviousCatalogAndTranscript() {
    val nextSession =
      WearSession(
        key = "agent:main:thread-2",
        title = "Next",
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-a",
        modelRef = "openai/new",
      )
    val state =
      WearUiState(
        activeAgentId = "main",
        selectedModelRef = "openai/old",
        models = listOf(WearModel("openai/new", "New")),
        messages = listOf(WearChatMessage("m1", "assistant", "old reply", 1)),
        streamText = "old stream",
        activeRunId = "run-old",
      )

    val switched = state.switchSessionContext(nextSession)

    assertEquals(nextSession, switched.selectedSession)
    assertEquals("openai/new", switched.selectedModelRef)
    assertEquals("main", switched.activeAgentId)
    assertEquals(emptyList<WearModel>(), switched.models)
    assertEquals(emptyList<WearChatMessage>(), switched.messages)
    assertNull(switched.streamText)
    assertNull(switched.activeRunId)
  }

  @Test
  fun modelSwitchClearsTheSelectedModelScopedCatalog() {
    val selectedSession =
      WearSession(
        key = "agent:main:thread-2",
        title = "Selected",
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-a",
        modelRef = "openai/model-59",
      )
    val state =
      WearUiState(
        sessions = listOf(selectedSession),
        selectedSession = selectedSession,
        selectedModelRef = "openai/model-59",
        models =
          listOf(
            WearModel("openai/model-0", "Model 0"),
            WearModel("openai/model-59", "Model 59"),
          ),
      )

    val switched = state.switchModelContext("openai/model-0")

    assertEquals("openai/model-0", switched.selectedModelRef)
    assertEquals("openai/model-0", switched.selectedSession?.modelRef)
    assertEquals("openai/model-0", switched.sessions.single().modelRef)
    assertEquals(emptyList<WearModel>(), switched.models)
  }
}
