package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.gateway.QuestionAnswers
import ai.openclaw.app.gateway.QuestionRecord
import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatReaderScrollControllerTest {
  @Test
  fun initialHistoryRestoresLatestUserAsReaderAnchor() {
    val timeline = timeline(user("user-1"), assistant("assistant-1"))

    val transition = initialChatReaderTransition(timeline)

    assertEquals(1, transition.scrollIndex)
    assertFalse(transition.animated)
    assertEquals(ChatScrollFollowTarget.ReadAnchor, transition.state.followTarget)
    assertTrue(transition.state.hasNewerContent)
    assertEquals("user-1", transition.state.latestUserMessageId)
  }

  @Test
  fun userAtLiveEdgeRemainsReaderAnchorWhenRemoteReplyArrives() {
    val initial = initialChatReaderTransition(timeline(user("user-1")))
    val replied = timeline(user("user-1"), assistant("assistant-1"))

    val transition = initial.state.onTimelineChanged(replied)

    assertEquals(ChatScrollFollowTarget.ReadAnchor, initial.state.followTarget)
    assertFalse(initial.state.hasNewerContent)
    assertEquals(replied.readAnchorIndex, transition.scrollIndex)
    assertEquals(ChatScrollFollowTarget.ReadAnchor, transition.state.followTarget)
    assertTrue(transition.state.hasNewerContent)
  }

  @Test
  fun contentAfterManualDeparturePreservesPositionAndOffersJump() {
    val before = initialChatReaderTransition(timeline(user("user-1"), assistant("assistant-1"))).state
    val readerMoved = before.onViewportChanged(index = 3, offset = 50, timeline = timeline(user("user-1")), targetTolerancePx = 24)

    val transition = readerMoved.onTimelineChanged(timeline(user("user-1"), assistant("assistant-2")))

    assertNull(transition.scrollIndex)
    assertTrue(transition.state.hasNewerContent)
  }

  @Test
  fun newUserTurnFollowsLatestContentWhileStreaming() {
    val previous = initialChatReaderTransition(timeline(assistant("assistant-1"))).state
    val active = activeTimeline(user("user-1"), stream = null)

    val newTurn = previous.onTimelineChanged(active)
    val streaming = activeTimeline(user("user-1"), stream = "reply")
    val streamUpdate = newTurn.state.onTimelineChanged(streaming)

    assertEquals(ChatScrollFollowTarget.LatestContent, newTurn.state.followTarget)
    assertEquals(active.latestContentIndex, newTurn.scrollIndex)
    assertTrue(newTurn.animated)
    assertFalse(newTurn.state.hasNewerContent)
    assertEquals(streaming.latestContentIndex, streamUpdate.scrollIndex)
    assertFalse(streamUpdate.state.hasNewerContent)
  }

  @Test
  fun completedReplyKeepsPromptAnchoredAndOffersLatestJump() {
    val active = activeTimeline(user("user-1"), stream = "reply")
    val followingPrompt = initialChatReaderTransition(active).state
    val finished = timeline(user("user-1"), assistant("assistant-1"))

    val transition = followingPrompt.onTimelineChanged(finished)

    assertEquals(finished.readAnchorIndex, transition.scrollIndex)
    assertTrue(transition.state.hasNewerContent)
    assertEquals(ChatScrollFollowTarget.ReadAnchor, transition.state.followTarget)
  }

  @Test
  fun removedOptimisticPromptPreservesPositionWithoutOfferingJump() {
    val active =
      buildChatTimeline(
        messages = listOf(user("user-old"), assistant("assistant-old"), user("user-optimistic")),
        pendingRunCount = 1,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )
    val followingPrompt = initialChatReaderTransition(active).state
    val rejected = timeline(user("user-old"), assistant("assistant-old"))

    val transition = followingPrompt.onTimelineChanged(rejected)

    assertNull(transition.scrollIndex)
    assertNull(transition.state.followTarget)
    assertFalse(transition.state.hasNewerContent)
    assertEquals("user-old", transition.state.latestUserMessageId)
  }

  @Test
  fun firstUserTurnAfterAssistantOnlyHistoryFollowsLatestContent() {
    val previous = initialChatReaderTransition(timeline(assistant("assistant-1"))).state
    val active = activeTimeline(user("user-1"), stream = null)

    val transition = previous.onTimelineChanged(active)

    assertEquals(active.latestContentIndex, transition.scrollIndex)
    assertEquals(ChatScrollFollowTarget.LatestContent, transition.state.followTarget)
    assertEquals("user-1", transition.state.latestUserMessageId)
  }

  @Test
  fun liveEdgeClearsNewerContentAndJumpFollowsLatest() {
    val timeline = activeTimeline(user("user-1"), stream = "reply")
    val waiting = ChatReaderState(initialized = true, hasNewerContent = true, latestUserMessageId = "user-1")

    val atLiveEdge = waiting.onViewportChanged(index = 0, offset = 20, timeline = timeline, targetTolerancePx = 24)
    val jump = waiting.jumpToLatest(timeline)

    assertFalse(atLiveEdge.hasNewerContent)
    assertEquals(0, jump.scrollIndex)
    assertTrue(jump.animated)
    assertFalse(jump.state.hasNewerContent)
  }

  @Test
  fun manualDepartureOffersJumpWithoutResumingFollowing() {
    val timeline = activeTimeline(user("user-1"), stream = "reply")
    val following =
      ChatReaderState(
        initialized = true,
        followTarget = ChatScrollFollowTarget.ReadAnchor,
        hasNewerContent = false,
        latestUserMessageId = "user-1",
      )

    val moved =
      following.onViewportChanged(
        index = checkNotNull(timeline.readAnchorIndex),
        offset = 0,
        timeline = timeline,
        targetTolerancePx = 24,
      )

    assertNull(moved.followTarget)
    assertTrue(moved.hasNewerContent)
  }

  @Test
  fun stateStartsFreshForEachSession() {
    val oldSession = ChatReaderState(initialized = true, hasNewerContent = true, latestUserMessageId = "old")

    val nextSession = initialChatReaderTransition(timeline(user("new")))

    assertTrue(oldSession.hasNewerContent)
    assertFalse(nextSession.state.hasNewerContent)
    assertEquals("new", nextSession.state.latestUserMessageId)
  }

  @Test
  fun emptyTimelineCanResetReaderStateBeforeSameSessionReload() {
    val previous = ChatReaderState(initialized = true, hasNewerContent = true, latestUserMessageId = "old")

    val reset = previous.onTimelineChanged(emptyTimeline()).state
    val reloaded = initialChatReaderTransition(timeline(user("new")))

    assertFalse(reset.initialized)
    assertFalse(reset.hasNewerContent)
    assertEquals("new", reloaded.state.latestUserMessageId)
  }

  @Test
  fun emptyBootstrapTimelinePreservesRestoredReaderState() {
    val restored =
      ChatReaderState(
        initialized = true,
        hasNewerContent = true,
        latestUserMessageId = "old",
        latestContentVersion = "old-version",
      )

    val loading = restored.onTimelineChanged(emptyTimeline(), historyLoading = true)

    assertEquals(restored, loading.state)
    assertNull(loading.scrollIndex)
  }

  @Test
  fun savedReaderStateRestoresViewportIntent() {
    val timeline = timeline(user("user-1"), assistant("assistant-1"))
    val state =
      ChatReaderState(
        initialized = true,
        followTarget = ChatScrollFollowTarget.ReadAnchor,
        hasNewerContent = true,
        latestUserMessageId = "user-1",
        latestContentVersion = timeline.latestContentVersion,
      )
    val saved = with(ChatReaderStateSaver) { SaverScope { true }.save(state) }

    val restored = ChatReaderStateSaver.restore(requireNotNull(saved))

    assertEquals(state, restored)
  }

  @Test
  fun savedReaderStateDoesNotRestoreIntoAnotherSession() {
    val state =
      ChatReaderState(
        ownerSessionKey = "session-old",
        initialized = true,
        followTarget = ChatScrollFollowTarget.LatestContent,
      )
    val saved = with(ChatReaderStateSaver) { SaverScope { true }.save(state) }

    val restored = createChatReaderStateSaver("session-new").restore(requireNotNull(saved))

    assertNull(restored)
  }

  @Test
  fun restoredReaderRebindsRegeneratedMessageIds() {
    val before =
      timeline(
        user("user-before", text = "original prompt", timestampMs = 1000L, idempotencyKey = "run-1:user"),
        assistant("assistant-before", text = "same reply"),
      )
    val savedState =
      ChatReaderState(
        initialized = true,
        followTarget = ChatScrollFollowTarget.LatestContent,
        latestUserMessageId = before.latestUserMessageId,
        latestUserMessageVersion = before.latestUserMessageVersion,
        latestContentVersion = before.latestContentVersion,
      )
    val saved = with(ChatReaderStateSaver) { SaverScope { true }.save(savedState) }
    val restored = requireNotNull(ChatReaderStateSaver.restore(requireNotNull(saved)))
    val after =
      timeline(
        user("user-after", text = "rewritten prompt", timestampMs = 2000L, idempotencyKey = "run-1:user"),
        assistant("assistant-after", text = "same reply"),
      )

    val transition = restored.onTimelineChanged(after)

    assertEquals(ChatScrollFollowTarget.LatestContent, transition.state.followTarget)
    assertEquals(after.latestContentIndex, transition.scrollIndex)
    assertEquals("user-after", transition.state.latestUserMessageId)
    assertEquals(after.latestUserMessageVersion, transition.state.latestUserMessageVersion)
  }

  @Test
  fun restoredReaderRecognizesRegeneratedPromptBeforeNewerUserTurn() {
    val before =
      timeline(
        user("user-before", text = "original prompt", timestampMs = 1000L, idempotencyKey = "run-1:user"),
        assistant("assistant-before", text = "original reply"),
      )
    val restored =
      ChatReaderState(
        initialized = true,
        followTarget = ChatScrollFollowTarget.LatestContent,
        latestUserMessageId = before.latestUserMessageId,
        latestUserMessageVersion = before.latestUserMessageVersion,
        latestContentVersion = before.latestContentVersion,
      )
    val after =
      timeline(
        user("user-restored", text = "original prompt", timestampMs = 2000L, idempotencyKey = "run-1:user"),
        assistant("assistant-restored", text = "original reply"),
        user("user-new", text = "new prompt", timestampMs = 3000L, idempotencyKey = "run-2:user"),
      )

    val transition = restored.onTimelineChanged(after)

    assertEquals(ChatScrollFollowTarget.LatestContent, transition.state.followTarget)
    assertEquals(after.latestContentIndex, transition.scrollIndex)
    assertTrue(transition.animated)
    assertEquals("user-new", transition.state.latestUserMessageId)
    assertEquals(after.latestUserMessageVersion, transition.state.latestUserMessageVersion)
  }

  @Test
  fun restoredReaderTreatsCurrentTimelineAsBaseline() {
    val timeline = timeline(user("user-1"), assistant("assistant-1"))
    val restored =
      ChatReaderState(
        initialized = true,
        hasNewerContent = false,
        latestUserMessageId = "user-1",
        latestContentVersion = timeline.latestContentVersion,
      )

    val transition = restored.onTimelineChanged(timeline)

    assertEquals(restored, transition.state)
    assertNull(transition.scrollIndex)
  }

  @Test
  fun questionTerminalStateAndHydratedAnswersChangeContentVersion() {
    val pending =
      ChatQuestionPrompt(
        QuestionRecord(
          id = "ask-1",
          questions = emptyList(),
          createdAtMs = 1_000,
          expiresAtMs = Long.MAX_VALUE,
          status = "pending",
        ),
      )
    val pendingTimeline = questionTimeline(pending)
    val unavailableTimeline = questionTimeline(pending.copy(recoveryUnavailable = true))
    val answered = pending.copy(record = pending.record.copy(status = "answered"))
    val answeredWithoutValues = questionTimeline(answered)
    val answeredWithValues =
      questionTimeline(
        answered.copy(
          record =
            answered.record.copy(
              answers =
                QuestionAnswers(
                  mapOf("choice" to listOf("Yes")),
                ),
            ),
        ),
      )

    assertNotEquals(pendingTimeline.latestContentVersion, unavailableTimeline.latestContentVersion)
    assertNotEquals(answeredWithoutValues.latestContentVersion, answeredWithValues.latestContentVersion)
  }

  private fun timeline(vararg messages: ChatMessage): ChatTimeline =
    buildChatTimeline(
      messages = messages.toList(),
      pendingRunCount = 0,
      pendingToolCalls = emptyList(),
      streamingAssistantText = null,
    )

  private fun emptyTimeline(): ChatTimeline = timeline()

  private fun questionTimeline(question: ChatQuestionPrompt): ChatTimeline =
    buildChatTimeline(
      messages = emptyList(),
      pendingRunCount = 0,
      pendingToolCalls = emptyList(),
      streamingAssistantText = null,
      questions = listOf(question),
    )

  private fun activeTimeline(
    message: ChatMessage,
    stream: String?,
  ): ChatTimeline =
    buildChatTimeline(
      messages = listOf(message),
      pendingRunCount = 1,
      pendingToolCalls = emptyList(),
      streamingAssistantText = stream,
    )

  private fun user(
    id: String,
    text: String = id,
    timestampMs: Long? = null,
    idempotencyKey: String? = null,
  ) = message(id, "user", text, timestampMs, idempotencyKey)

  private fun assistant(
    id: String,
    text: String = id,
  ) = message(id, "assistant", text, timestampMs = null, idempotencyKey = null)

  private fun message(
    id: String,
    role: String,
    text: String,
    timestampMs: Long?,
    idempotencyKey: String?,
  ) = ChatMessage(
    id = id,
    role = role,
    content = listOf(ChatMessageContent(type = "text", text = text)),
    timestampMs = timestampMs,
    idempotencyKey = idempotencyKey,
  )
}
