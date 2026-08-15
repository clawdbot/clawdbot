package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkEntry
import ai.openclaw.wear.shared.WearRealtimeTalkRole
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

  @Test
  fun threadFollowKeepsStreamingContentVisibleAtLatest() {
    val first =
      nextWearThreadFollowForContent(
        state = WearThreadFollowState(),
        contentRevision = threadRevision(text = "Hel", streaming = true),
      )
    val continued =
      nextWearThreadFollowForContent(
        state = first.state,
        contentRevision = threadRevision(text = "Hello", streaming = true),
      )

    assertTrue(first.scrollToLatest)
    assertTrue(continued.scrollToLatest)
    assertTrue(continued.state.followingLatest)
    assertFalse(continued.state.hasNewContent)
  }

  @Test
  fun chatFollowTracksStreamingGrowthAtLatest() {
    val messages = listOf(WearChatMessage(id = "user-1", role = "user", text = "Status?", timestamp = 1L))
    val anchor = wearChatLatestAnchorIndex(1, hasStreaming = true, canAbort = false, hasAssistant = false, hasFailure = false)
    val first =
      nextWearThreadFollowForContent(
        state = WearThreadFollowState(),
        contentRevision = wearChatContentRevision("session-1", messages, "Read", anchor),
      )
    val continued =
      nextWearThreadFollowForContent(
        state = first.state,
        contentRevision = wearChatContentRevision("session-1", messages, "Ready", anchor),
      )

    assertTrue(first.scrollToLatest)
    assertTrue(continued.scrollToLatest)
    assertTrue(continued.state.followingLatest)
    assertFalse(continued.state.hasNewContent)
  }

  @Test
  fun chatFollowPreservesManualScrollForNewContent() {
    val firstMessage = WearChatMessage(id = "message-1", role = "assistant", text = "First", timestamp = 1L)
    val initial =
      nextWearThreadFollowForContent(
        state = WearThreadFollowState(),
        contentRevision = wearChatContentRevision("session-1", listOf(firstMessage), null, 6),
      )
    val scrolledBack =
      nextWearThreadFollowForViewport(
        state = initial.state,
        atLatest = false,
        scrollingBackward = true,
      )
    val newContent =
      nextWearThreadFollowForContent(
        state = scrolledBack,
        contentRevision =
          wearChatContentRevision(
            "session-1",
            listOf(firstMessage, WearChatMessage(id = "message-2", role = "assistant", text = "Second", timestamp = 2L)),
            null,
            7,
          ),
      )

    assertFalse(newContent.scrollToLatest)
    assertFalse(newContent.state.followingLatest)
    assertTrue(newContent.state.hasNewContent)
    assertTrue(wearThreadFollowLatest(newContent.state).followingLatest)
  }

  @Test
  fun chatFollowTargetsRenderedTrailingAnchor() {
    assertEquals(
      -1,
      wearChatLatestAnchorIndex(0, hasStreaming = false, canAbort = false, hasAssistant = false, hasFailure = true),
    )
    assertEquals(
      5,
      wearChatLatestAnchorIndex(1, hasStreaming = false, canAbort = false, hasAssistant = false, hasFailure = false),
    )
    assertEquals(
      10,
      wearChatLatestAnchorIndex(2, hasStreaming = true, canAbort = true, hasAssistant = true, hasFailure = true),
    )
  }

  @Test
  fun threadFollowTargetsTrailingAnchorAfterLatestContent() {
    assertEquals(-1, wearThreadLatestAnchorIndex(entryCount = 0, thinking = false))
    assertEquals(1, wearThreadLatestAnchorIndex(entryCount = 1, thinking = false))
    assertEquals(3, wearThreadLatestAnchorIndex(entryCount = 2, thinking = true))
  }

  @Test
  fun threadFollowPreservesManualScrollUntilLatestIsRequested() {
    val initial =
      nextWearThreadFollowForContent(
        state = WearThreadFollowState(),
        contentRevision = threadRevision(text = "First", streaming = false),
      )
    val scrolledBack =
      nextWearThreadFollowForViewport(
        state = initial.state,
        atLatest = false,
        scrollingBackward = true,
      )
    val newContent =
      nextWearThreadFollowForContent(
        state = scrolledBack,
        contentRevision = threadRevision(text = "Second", streaming = false),
      )

    assertFalse(newContent.scrollToLatest)
    assertFalse(newContent.state.followingLatest)
    assertTrue(newContent.state.hasNewContent)

    val latest = wearThreadFollowLatest(newContent.state)
    assertTrue(latest.followingLatest)
    assertFalse(latest.hasNewContent)
  }

  @Test
  fun threadFollowClearsNewContentWhenUserScrollsToLatest() {
    val away =
      WearThreadFollowState(
        followingLatest = false,
        hasNewContent = true,
      )

    val latest =
      nextWearThreadFollowForViewport(
        state = away,
        atLatest = true,
        scrollingBackward = false,
      )

    assertTrue(latest.followingLatest)
    assertFalse(latest.hasNewContent)
  }

  @Test
  fun threadFollowResetsWhenRealtimeStops() {
    val revision = threadRevision(text = "Old", streaming = false)
    val away =
      WearThreadFollowState(
        contentRevision = revision,
        followingLatest = false,
        hasNewContent = true,
      )
    val stopped =
      nextWearThreadFollowForContent(
        state = away,
        contentRevision = revision,
        realtimeActive = false,
      )

    assertFalse(stopped.scrollToLatest)
    assertTrue(stopped.state.followingLatest)
    assertFalse(stopped.state.hasNewContent)

    val restarted =
      nextWearThreadFollowForContent(
        state = stopped.state,
        contentRevision = revision,
      )
    assertTrue(restarted.scrollToLatest)
  }

  @Test
  fun proxyErrorsMapToLocalizedFailureCodes() {
    assertEquals(
      WearConversationFailure.PHONE_UNAVAILABLE,
      WearProxyException("phone_unavailable", "Raw phone error").toWearConversationFailure(),
    )
    assertEquals(
      WearConversationFailure.INCOMPATIBLE,
      WearProxyException("unsupported_peer", "Raw compatibility error").toWearConversationFailure(),
    )
    assertEquals(
      WearConversationFailure.INTERNAL_ERROR,
      IllegalStateException("Raw internal error").toWearConversationFailure(),
    )
  }

  @Test
  fun conversationSnapshotCarriesSemanticFailureAndUntitledSession() {
    val session =
      WearSession(
        key = "session-1",
        title = null,
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-1",
      )
    val snapshot =
      WearUiState(
        connected = true,
        phoneNodeId = "phone-1",
        sessions = listOf(session),
        selectedSession = session,
        failure = WearConversationFailure.ACTION_REJECTED,
      ).toConversationSnapshot()

    assertEquals(WearConversationFailure.ACTION_REJECTED, snapshot?.failure)
    assertNull(snapshot?.sessions?.single()?.title)
  }

  @Test
  fun conversationSnapshotExposesPulseOnlyForConnectedCapablePhone() {
    val pulse =
      WearAgentPulseSnapshot(
        tasks =
          WearAgentPulseTasks(
            state = WearAgentPulseTaskState.Ready,
            queued = 2,
            running = 3,
            completed = 5,
            failed = 1,
            activeAtLimit = false,
            recentAtLimit = false,
          ),
        swarm =
          WearAgentPulseSwarm(
            state = WearAgentPulseSwarmState.Active,
            groups = 1,
            running = 1,
            done = 0,
            failed = 0,
            phases =
              listOf(
                WearAgentPulsePhase(
                  queued = 2,
                  running = 1,
                  done = 0,
                  failed = 0,
                  hidden = 0,
                ),
              ),
            morePhases = false,
          ),
        approvals =
          WearAgentPulseApprovals(
            state = WearAgentPulseApprovalsState.Ready,
            pending = 2,
          ),
        eventSequence = 7L,
        phoneNodeId = "phone-1",
        eventStreamId = "epoch-1",
      )
    val capable =
      WearUiState(
        loading = false,
        connected = true,
        phoneNodeId = "phone-1",
        proxyCapabilities = setOf(WearProxyCapability.AgentPulse),
        agentPulse = pulse,
        agentPulseLoading = true,
        agentPulseFailure = WearConversationFailure.INTERNAL_ERROR,
      ).toConversationSnapshot()

    assertTrue(capable?.agentPulseSupported == true)
    assertEquals(pulse, capable?.agentPulse)
    assertTrue(capable?.agentPulseLoading == true)
    assertEquals(WearConversationFailure.INTERNAL_ERROR, capable?.agentPulseFailure)

    val offline =
      WearUiState(
        loading = false,
        connected = false,
        phoneNodeId = "phone-1",
        proxyCapabilities = setOf(WearProxyCapability.AgentPulse),
        agentPulse = pulse,
        agentPulseLoading = true,
        agentPulseFailure = WearConversationFailure.INTERNAL_ERROR,
      ).toConversationSnapshot()

    assertFalse(offline?.agentPulseSupported == true)
    assertNull(offline?.agentPulse)
    assertFalse(offline?.agentPulseLoading == true)
    assertNull(offline?.agentPulseFailure)

    val unsupported =
      WearUiState(
        loading = false,
        connected = true,
        phoneNodeId = "phone-1",
        agentPulse = pulse,
      ).toConversationSnapshot()

    assertFalse(unsupported?.agentPulseSupported == true)
    assertNull(unsupported?.agentPulse)
  }

  @Test
  fun connectionEventsPreserveTypedAndLegacyIncompatibilityReasons() {
    assertEquals(
      WearConversationFailure.INCOMPATIBLE,
      wearConversationFailureForConnection(
        buildJsonObject {
          put("connected", false)
          put("failure", "incompatible")
          put("status", "Offline")
        },
      ),
    )
    assertEquals(
      WearConversationFailure.INCOMPATIBLE,
      wearConversationFailureForConnection(
        buildJsonObject {
          put("connected", false)
          put("status", "Update required")
        },
      ),
    )
    assertEquals(
      WearConversationFailure.GATEWAY_OFFLINE,
      wearConversationFailureForConnection(
        buildJsonObject {
          put("connected", false)
          put("status", "Offline")
        },
      ),
    )
  }

  private fun threadRevision(
    text: String,
    streaming: Boolean,
  ): WearThreadContentRevision =
    WearThreadContentRevision(
      entryCount = 1,
      latestEntryId = "entry-1",
      latestText = text,
      latestStreaming = streaming,
      thinking = false,
    )

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
