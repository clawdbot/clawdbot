package ai.openclaw.wear

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
