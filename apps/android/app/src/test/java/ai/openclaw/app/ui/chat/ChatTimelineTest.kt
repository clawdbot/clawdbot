package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatDiffStat
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatSubagentActivity
import ai.openclaw.app.chat.OUTBOX_OWNER_CHANGED_ERROR
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatTimelineTest {
  @Test
  fun activeRunAnchorsNewestUserPromptInsteadOfThinkingRow() {
    val user = textMessage(id = "user-1", role = "user", text = "hello")

    val timeline =
      buildChatTimeline(
        messages = listOf(user),
        pendingRunCount = 1,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(listOf("thinking", "message:user-1"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(1, timeline.readAnchorIndex)
    assertEquals(0, timeline.latestContentIndex)
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun activeRunAnchorsNewestUserPromptWhileAssistantStreams() {
    val olderAssistant = textMessage(id = "assistant-1", role = "assistant", text = "previous")
    val user = textMessage(id = "user-1", role = "user", text = "next")
    val tool =
      ChatPendingToolCall(
        toolCallId = "tool-1",
        name = "memory.search",
        startedAtMs = 1000L,
      )

    val timeline =
      buildChatTimeline(
        messages = listOf(olderAssistant, user),
        pendingRunCount = 1,
        pendingToolCalls = listOf(tool),
        streamingAssistantText = "streaming",
      )

    assertEquals(
      listOf("stream", "tools", "thinking", "message:user-1", "message:assistant-1"),
      timeline.items.map(::chatTimelineItemKey),
    )
    assertEquals(3, timeline.readAnchorIndex)
    assertEquals(0, timeline.latestContentIndex)
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun finishedRunKeepsLatestUserPromptAsReaderAnchor() {
    val user = textMessage(id = "user-1", role = "user", text = "hello")
    val assistant = textMessage(id = "assistant-1", role = "assistant", text = "done")

    val timeline =
      buildChatTimeline(
        messages = listOf(user, assistant),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(listOf("message:assistant-1", "message:user-1"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(1, timeline.readAnchorIndex)
    assertEquals(0, timeline.latestContentIndex)
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun finishedTurnRecapUsesNewestSlotWithoutChangingReaderAnchorRow() {
    val user = textMessage(id = "user-1", role = "user", text = "hello")
    val assistant = textMessage(id = "assistant-1", role = "assistant", text = "done")
    val timeline =
      buildChatTimeline(
        messages = listOf(user, assistant),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    val withRecap = timeline.withTurnRecap(TurnRecap(runtimeMs = 2_000L, outputTokens = 10L))

    assertEquals(
      listOf("turn-recap", "message:assistant-1", "message:user-1"),
      withRecap.items.map(::chatTimelineItemKey),
    )
    assertEquals(0, withRecap.latestContentIndex)
    assertEquals(2, withRecap.readAnchorIndex)
    assertEquals("user-1", withRecap.latestUserMessageId)
  }

  @Test
  fun emptyTimelineHasNoScrollTarget() {
    val timeline =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(emptyList<String>(), timeline.items.map(::chatTimelineItemKey))
    assertEquals(null, timeline.readAnchorIndex)
    assertEquals(null, timeline.latestContentIndex)
    assertEquals(null, timeline.latestUserMessageId)
  }

  @Test
  fun outboxRowsHideOnceTheirUserTurnIsVisibleAsAMessage() {
    val visible =
      ChatOutboxItem(
        id = "visible-row",
        sessionKey = "main",
        text = "still queued",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Queued,
        retryCount = 0,
        lastError = null,
        ownerAgentId = "main",
      )
    val consumed =
      visible.copy(
        id = "consumed-row",
        status = ChatOutboxStatus.Accepted,
        createdAtMs = 2,
      )
    val optimisticCopy =
      textMessage(id = "m1", role = "user", text = "sent already")
        .copy(idempotencyKey = "consumed-row:user")

    val filtered =
      outboxItemsForSession(
        items = listOf(visible, consumed),
        sessionKey = "main",
        mainSessionKey = "agent:work:main",
        ownerAgentId = "main",
        messages = listOf(optimisticCopy),
      )

    // A row whose turn already renders as a message never shows a second bubble.
    assertEquals(listOf("visible-row"), filtered.map { it.id })
  }

  @Test
  fun outboxRowsStayWithTheirAgentOwner() {
    val mainOwner =
      ChatOutboxItem(
        id = "main-row",
        sessionKey = "shared",
        text = "main",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Queued,
        retryCount = 0,
        lastError = null,
        ownerAgentId = "main",
      )
    val otherOwner = mainOwner.copy(id = "other-row", text = "other", ownerAgentId = "other")
    val migratedOwnerless = mainOwner.copy(id = "legacy-row", text = "legacy", ownerAgentId = null)

    val filtered =
      outboxItemsForSession(
        items = listOf(mainOwner, otherOwner, migratedOwnerless),
        sessionKey = "shared",
        mainSessionKey = "agent:main:device",
        ownerAgentId = "main",
      )

    assertEquals(listOf("main-row"), filtered.map { it.id })
  }

  @Test
  fun unreachableRowsRenderOnlyInTheNeutralRecoverySection() {
    val ownerless =
      ChatOutboxItem(
        id = "legacy-row",
        sessionKey = "shared",
        text = "legacy private text",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Failed,
        retryCount = 0,
        lastError = "owner unknown",
        ownerAgentId = null,
      )
    assertEquals(listOf(ownerless), outboxItemsForRecovery(listOf(ownerless)))

    val timeline =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
        recoveryOutboxItems = listOf(ownerless),
      )

    assertEquals(
      listOf("outbox-recovery:legacy-row", "outbox-recovery-header"),
      timeline.items.map(::chatTimelineItemKey),
    )
  }

  @Test
  fun parkedMainAliasRowRemainsReachableForRecovery() {
    val captured =
      ChatOutboxItem(
        id = "captured-main",
        sessionKey = "main",
        text = "park me",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Failed,
        retryCount = 0,
        lastError = OUTBOX_OWNER_CHANGED_ERROR,
        ownerAgentId = "agent-a",
      )

    assertEquals(listOf(captured), outboxItemsForRecovery(listOf(captured)))
    assertTrue(
      outboxItemsForSession(
        items = listOf(captured),
        sessionKey = "main",
        mainSessionKey = "agent:agent-a:device",
        ownerAgentId = "agent-a",
      ).isEmpty(),
    )
  }

  @Test
  fun validForeignMainAliasRowStaysHiddenUntilItsCapturedOwnerIsCurrent() {
    val captured =
      ChatOutboxItem(
        id = "captured-main",
        sessionKey = "main",
        text = "keep private",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Queued,
        retryCount = 0,
        lastError = null,
        ownerAgentId = "agent-a",
      )

    assertTrue(outboxItemsForRecovery(listOf(captured)).isEmpty())
  }

  @Test
  fun foreignCustomAliasRowStaysHiddenUntilItsCapturedOwnerIsCurrent() {
    val captured =
      ChatOutboxItem(
        id = "captured-custom",
        sessionKey = "custom-alias",
        text = "park me",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Failed,
        retryCount = 0,
        lastError = "owner changed",
        ownerAgentId = "agent-a",
      )

    assertTrue(outboxItemsForRecovery(listOf(captured)).isEmpty())
  }

  @Test
  fun agentQualifiedRowMovesToRecoveryWhenItsCapturedOwnerDisagrees() {
    val mismatched =
      ChatOutboxItem(
        id = "mismatched-owner",
        sessionKey = "agent:agent-b:device",
        text = "park me",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Failed,
        retryCount = 0,
        lastError = "owner changed",
        ownerAgentId = "agent-a",
      )

    assertEquals(listOf(mismatched), outboxItemsForRecovery(listOf(mismatched)))
  }

  @Test
  fun subagentRowsStayKeyedByTaskAndParticipateInLiveContentVersion() {
    val activity = subagentActivity(id = "task-1", snippet = "Reading files", added = 2)
    val first =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
        subagentActivities = mapOf(activity.id to activity),
      )
    val updated = activity.copy(snippet = "Editing files", diffStat = ChatDiffStat(added = 8, removed = 3, files = 2))
    val second =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
        subagentActivities = mapOf(updated.id to updated),
      )

    assertEquals(listOf("subagent-activity"), first.items.map(::chatTimelineItemKey))
    assertEquals(first.items.map(::chatTimelineItemKey), second.items.map(::chatTimelineItemKey))
    assertTrue(first.latestContentVersion != second.latestContentVersion)
  }

  @Test
  fun subagentRowsCapAtFiveAndOverflowCountsOnlyHiddenWorkingRows() {
    val working = (1..6).map { index -> subagentActivity(id = "task-$index", startedAtMs = index.toLong()) }
    val queued = subagentActivity(id = "task-queued", status = "queued", startedAtMs = 100)
    val finished = subagentActivity(id = "task-finished", status = "completed", startedAtMs = 0, endedAtMs = 20)

    val timeline =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = listOf(ChatPendingToolCall(toolCallId = "tool-1", name = "edit", startedAtMs = 1)),
        streamingAssistantText = null,
        subagentActivities = (working + queued + finished).associateBy(ChatSubagentActivity::id),
      )

    assertEquals(
      listOf("tools", "subagent-activity"),
      timeline.items.map(::chatTimelineItemKey),
    )
    val row = timeline.items.filterIsInstance<ChatTimelineItem.SubagentActivity>().single()
    assertEquals(listOf("task-1", "task-2", "task-3", "task-4", "task-5"), row.activities.map { it.id })
    assertEquals(1, row.moreWorkingCount)
  }

  @Test
  fun liveToolDiffChangesTimelineContentVersion() {
    val pending = ChatPendingToolCall(toolCallId = "tool-1", name = "edit", startedAtMs = 1)
    val initial =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = listOf(pending),
        streamingAssistantText = null,
      )
    val updated =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = listOf(pending.copy(liveDiff = ChatDiffStat(added = 4, removed = 1))),
        streamingAssistantText = null,
      )

    assertEquals(initial.items.map(::chatTimelineItemKey), updated.items.map(::chatTimelineItemKey))
    assertTrue(initial.latestContentVersion != updated.latestContentVersion)
  }

  private fun subagentActivity(
    id: String,
    status: String = "running",
    snippet: String? = null,
    added: Int = 0,
    startedAtMs: Long = 1,
    endedAtMs: Long? = null,
  ): ChatSubagentActivity =
    ChatSubagentActivity(
      id = id,
      status = status,
      snippet = snippet,
      diffStat = ChatDiffStat(added = added, removed = 0, files = 1),
      terminalSummary = null,
      error = null,
      startedAtMs = startedAtMs,
      endedAtMs = endedAtMs,
      childSessionKey = "agent:worker:subagent:$id",
    )

  private fun textMessage(
    id: String,
    role: String,
    text: String,
  ): ChatMessage =
    ChatMessage(
      id = id,
      role = role,
      content = listOf(ChatMessageContent(type = "text", text = text)),
      timestampMs = null,
    )
}
