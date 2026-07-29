package ai.openclaw.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
  fun delayedSessionActionsRequireTheOriginalPhoneAndSession() {
    val requested =
      WearSession(
        key = "agent:main",
        title = "Main",
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-a",
        modelRef = "openai/model-a",
      )

    assertTrue(
      wearSessionActionIsCurrent(
        requested,
        WearUiState(phoneNodeId = "phone-a", selectedSession = requested),
        requestedRouteGeneration = 3,
        currentRouteGeneration = 3,
      ),
    )
    assertFalse(
      wearSessionActionIsCurrent(
        requested,
        WearUiState(
          phoneNodeId = "phone-b",
          selectedSession = requested.copy(phoneNodeId = "phone-b"),
        ),
        requestedRouteGeneration = 3,
        currentRouteGeneration = 4,
      ),
    )
    assertFalse(
      wearSessionActionIsCurrent(
        requested,
        WearUiState(
          phoneNodeId = "phone-a",
          selectedSession = requested.copy(key = "agent:other"),
        ),
        requestedRouteGeneration = 3,
        currentRouteGeneration = 3,
      ),
    )
    assertFalse(
      wearSessionActionIsCurrent(
        requested,
        WearUiState(phoneNodeId = "phone-a", selectedSession = requested),
        requestedRouteGeneration = 3,
        currentRouteGeneration = 5,
      ),
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

  @Test
  fun olderRunFinalMergesItsMessageWithoutEndingTheActiveReply() {
    val previous = WearChatMessage("previous", "assistant", "Earlier", 1)
    val completed = WearChatMessage("older", "assistant", "Finished older reply", 2)
    val current = activeTerminalState(messages = listOf(previous))

    val transition =
      reduceWearTerminalChatEvent(
        current,
        terminalEvent(state = "final", runId = "older-run", message = completed),
      )

    assertEquals(listOf(previous, completed), transition.state.messages)
    assertEquals("active-run", transition.state.activeRunId)
    assertEquals("Hello", transition.state.streamText)
    assertFalse(transition.reloadHistory)
    assertNull(transition.observedMessage)
  }

  @Test
  fun olderRunAbortCannotEndTheActiveReply() {
    assertForeignTerminalPreservesLiveReply("aborted")
  }

  @Test
  fun olderRunErrorCannotEndTheActiveReply() {
    assertForeignTerminalPreservesLiveReply("error")
  }

  @Test
  fun identifiedOlderFinalCannotEndAnAnonymousReply() {
    assertForeignTerminalPreservesLiveReply("final", activeRunId = null)
  }

  @Test
  fun identifiedOlderAbortCannotEndAnAnonymousReply() {
    assertForeignTerminalPreservesLiveReply("aborted", activeRunId = null)
  }

  @Test
  fun identifiedOlderErrorCannotEndAnAnonymousReply() {
    assertForeignTerminalPreservesLiveReply("error", activeRunId = null)
  }

  @Test
  fun anonymousReplyFinalReconcilesWhenTheRunIsFirstIdentified() {
    val completed = WearChatMessage("completed", "assistant", "Finished reply", 2)
    val current = activeTerminalState(activeRunId = null)
    val transition =
      reduceWearTerminalChatEvent(
        current,
        terminalEvent(state = "final", runId = "revealed-run", message = completed),
      )

    assertEquals(listOf(completed), transition.state.messages)
    assertEquals("Hello", transition.state.streamText)
    assertNull(transition.state.activeRunId)
    assertTrue(transition.reloadHistory)
    assertEquals(completed, transition.observedMessage)
  }

  @Test
  fun anonymousReplyAbortReconcilesWhenTheRunIsFirstIdentified() {
    assertUncertainTerminalPreservesReplyAndReloadsHistory(
      state = "aborted",
      activeRunId = null,
      eventRunId = "revealed-run",
    )
  }

  @Test
  fun anonymousReplyErrorReconcilesWhenTheRunIsFirstIdentified() {
    assertUncertainTerminalPreservesReplyAndReloadsHistory(
      state = "error",
      activeRunId = null,
      eventRunId = "revealed-run",
    )
  }

  @Test
  fun matchingRunFinalEndsTheReplyAndReloadsItsFinalMessage() {
    val completed = WearChatMessage("completed", "assistant", "Finished reply", 2)
    val transition =
      reduceWearTerminalChatEvent(
        activeTerminalState(),
        terminalEvent(state = "final", runId = "active-run", message = completed),
      )

    assertEquals(listOf(completed), transition.state.messages)
    assertNull(transition.state.activeRunId)
    assertNull(transition.state.streamText)
    assertTrue(transition.reloadHistory)
    assertEquals(completed, transition.observedMessage)
  }

  @Test
  fun matchingRunAbortEndsTheReplyAndReloadsHistory() {
    assertOwnTerminalEndsLiveReply("aborted", runId = "active-run")
  }

  @Test
  fun matchingRunErrorEndsTheReplyAndReloadsHistory() {
    assertOwnTerminalEndsLiveReply("error", runId = "active-run")
  }

  @Test
  fun unidentifiedAbortReconcilesWithoutClearingAnIdentifiedReply() {
    assertUncertainTerminalPreservesReplyAndReloadsHistory(
      state = "aborted",
      activeRunId = "active-run",
      eventRunId = null,
    )
  }

  @Test
  fun unidentifiedErrorReconcilesWithoutClearingAnIdentifiedReply() {
    assertUncertainTerminalPreservesReplyAndReloadsHistory(
      state = "error",
      activeRunId = "active-run",
      eventRunId = null,
    )
  }

  @Test
  fun unidentifiedFinalMergesWithoutClearingAnIdentifiedReply() {
    val completed = WearChatMessage("completed", "assistant", "Finished reply", 2)
    val transition =
      reduceWearTerminalChatEvent(
        activeTerminalState(),
        terminalEvent(state = "final", runId = null, message = completed),
      )

    assertEquals(listOf(completed), transition.state.messages)
    assertEquals("active-run", transition.state.activeRunId)
    assertEquals("Hello", transition.state.streamText)
    assertTrue(transition.reloadHistory)
    assertEquals(completed, transition.observedMessage)
  }

  @Test
  fun otherSessionTerminalNeverChangesTheSelectedReply() {
    val current = activeTerminalState()
    val transition =
      reduceWearTerminalChatEvent(
        current,
        terminalEvent(state = "final", runId = "active-run", sessionKey = "agent:other"),
      )

    assertEquals(current, transition.state)
    assertFalse(transition.reloadHistory)
    assertNull(transition.observedMessage)
  }

  private fun assertUncertainTerminalPreservesReplyAndReloadsHistory(
    state: String,
    activeRunId: String?,
    eventRunId: String?,
  ) {
    val current = activeTerminalState(activeRunId = activeRunId)
    val transition =
      reduceWearTerminalChatEvent(
        current,
        terminalEvent(state = state, runId = eventRunId),
      )

    assertEquals(current, transition.state)
    assertTrue(transition.reloadHistory)
    assertNull(transition.observedMessage)
  }

  private fun assertForeignTerminalPreservesLiveReply(
    state: String,
    activeRunId: String? = "active-run",
  ) {
    val current = activeTerminalState(activeRunId = activeRunId)
    val transition =
      reduceWearTerminalChatEvent(
        current,
        terminalEvent(state = state, runId = "older-run"),
      )

    assertEquals(current, transition.state)
    if (activeRunId == null) {
      assertTrue(transition.reloadHistory)
    } else {
      assertFalse(transition.reloadHistory)
    }
    assertNull(transition.observedMessage)
  }

  private fun assertOwnTerminalEndsLiveReply(
    state: String,
    runId: String?,
  ) {
    val transition =
      reduceWearTerminalChatEvent(
        activeTerminalState(),
        terminalEvent(state = state, runId = runId),
      )

    assertNull(transition.state.activeRunId)
    assertNull(transition.state.streamText)
    assertTrue(transition.reloadHistory)
    assertNull(transition.observedMessage)
  }

  private fun activeTerminalState(
    activeRunId: String? = "active-run",
    messages: List<WearChatMessage> = emptyList(),
  ): WearUiState {
    val selected =
      WearSession(
        key = "agent:main",
        title = "Main",
        updatedAt = null,
        hasActiveRun = true,
        phoneNodeId = "phone-a",
      )
    return WearUiState(
      selectedSession = selected,
      messages = messages,
      streamText = "Hello",
      activeRunId = activeRunId,
    )
  }

  private fun terminalEvent(
    state: String,
    runId: String?,
    sessionKey: String = "agent:main",
    message: WearChatMessage? = null,
  ): WearChatEvent =
    WearChatEvent(
      sessionKey = sessionKey,
      runId = runId,
      state = state,
      deltaText = null,
      replace = false,
      streamText = null,
      streamTextComplete = false,
      message = message,
    )
}
