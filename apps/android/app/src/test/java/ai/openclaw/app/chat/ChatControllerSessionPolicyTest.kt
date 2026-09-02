package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerSessionPolicyTest {
  @Test
  fun sessionMergeRetainsTheLatestObservedDurableIdentity() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 1L,
        sessionId = "session-a",
      )

    val retained = mergeChatSessionEntry(existing, existing.copy(updatedAtMs = 2L, sessionId = null))
    val replaced = mergeChatSessionEntry(retained, existing.copy(updatedAtMs = 3L, sessionId = "session-b"))

    assertEquals("session-a", retained.sessionId)
    assertEquals("session-b", replaced.sessionId)
  }

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

  @Test
  fun sessionMergeClearsUsageWhenNewSnapshotOmitsUsageMetadata() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 1L,
        displayName = "Phone",
        totalTokens = 41_000L,
        totalTokensFresh = true,
        contextTokens = 100_000L,
      )
    val next =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 2L,
        displayName = "Phone renamed",
        hasContextUsageMetadata = false,
      )

    val merged = mergeChatSessionEntry(existing, next)

    assertEquals("agent:main:phone", merged.key)
    assertEquals(2L, merged.updatedAtMs)
    assertEquals("Phone renamed", merged.displayName)
    assertEquals(null, merged.totalTokens)
    assertEquals(null, merged.totalTokensFresh)
    assertEquals(null, merged.contextTokens)
    assertFalse(merged.hasContextUsageMetadata)
  }

  @Test
  fun sessionMergePreservesUsageWhenHistorySnapshotOmitsTotalTokens() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 1L,
        displayName = "Phone",
        totalTokens = 41_000L,
        totalTokensFresh = true,
        contextTokens = 100_000L,
      )
    val next =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 2L,
        displayName = "Phone renamed",
        totalTokensFresh = false,
        contextTokens = 120_000L,
      )

    val merged =
      mergeChatSessionEntry(
        existing = existing,
        next = next,
        preserveExistingContextUsageWithoutTotal = true,
      )

    assertEquals(2L, merged.updatedAtMs)
    assertEquals("Phone renamed", merged.displayName)
    assertEquals(41_000L, merged.totalTokens)
    assertEquals(true, merged.totalTokensFresh)
    assertEquals(120_000L, merged.contextTokens)
    assertTrue(merged.hasContextUsageMetadata)
  }

  @Test
  fun sessionMergeAppliesExplicitStaleUsageMetadata() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 1L,
        totalTokens = 41_000L,
        totalTokensFresh = true,
        contextTokens = 100_000L,
      )
    val next =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 2L,
        totalTokens = 82_000L,
        totalTokensFresh = false,
        contextTokens = 100_000L,
      )

    val merged = mergeChatSessionEntry(existing, next)

    assertEquals(82_000L, merged.totalTokens)
    assertEquals(false, merged.totalTokensFresh)
    assertEquals(100_000L, merged.contextTokens)
    assertTrue(merged.hasContextUsageMetadata)
  }

  @Test
  fun sessionMergePreservesMissingSessionListMetadata() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 1L,
        displayName = "Phone",
        label = "Daily",
        category = "Work",
        pinned = true,
        archived = false,
        unread = true,
        lastReadAt = 10L,
        markedUnreadAt = 15L,
        lastActivityAt = 20L,
      )
    val next = ChatSessionEntry(key = "agent:main:phone", updatedAtMs = 2L)

    val merged = mergeChatSessionEntry(existing, next)

    assertEquals("Daily", merged.label)
    assertEquals("Work", merged.category)
    assertEquals(true, merged.pinned)
    assertEquals(false, merged.archived)
    assertEquals(true, merged.unread)
    assertEquals(10L, merged.lastReadAt)
    assertEquals(15L, merged.markedUnreadAt)
    assertEquals(20L, merged.lastActivityAt)
  }

  @Test
  fun sessionMergeRetainsOrReplacesClassificationMetadataAsOneSnapshot() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:telegram:main:direct:491234567890",
        updatedAtMs = 1L,
        classification = "direct",
        accountId = "main",
        peerKind = "direct",
        isMain = false,
        isBackground = false,
      )

    val retained = mergeChatSessionEntry(existing, ChatSessionEntry(key = existing.key, updatedAtMs = 2L))
    assertEquals("direct", retained.classification)
    assertEquals("main", retained.accountId)
    assertEquals("direct", retained.peerKind)
    assertEquals(false, retained.isMain)
    assertEquals(false, retained.isBackground)

    val replaced =
      mergeChatSessionEntry(
        existing,
        ChatSessionEntry(
          key = existing.key,
          updatedAtMs = 3L,
          classification = "subagent",
          isMain = false,
          isBackground = true,
          hasClassificationMetadata = true,
        ),
      )
    assertEquals("subagent", replaced.classification)
    assertEquals(null, replaced.accountId)
    assertEquals(null, replaced.peerKind)
    assertEquals(false, replaced.isMain)
    assertEquals(true, replaced.isBackground)
  }

  @Test
  fun sessionMergeReplacesRunMetadataAsOneSnapshot() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 1L,
        status = "done",
        startedAt = 100L,
        endedAt = 200L,
        runtimeMs = 100L,
        outputTokens = 12L,
      )
    val running =
      ChatSessionEntry(
        key = "agent:main:phone",
        updatedAtMs = 2L,
        status = "running",
        startedAt = 300L,
        hasRunMetadata = true,
      )

    val merged = mergeChatSessionEntry(existing, running)

    assertEquals("running", merged.status)
    assertEquals(300L, merged.startedAt)
    assertEquals(null, merged.endedAt)
    assertEquals(null, merged.runtimeMs)
    assertEquals(null, merged.outputTokens)
  }

  @Test
  fun activeRunSelectionPrefersAdvertisedOverlapThenDeterministicLocalThenAdvertised() {
    assertEquals(
      "local-b",
      resolvePreferredActiveRunId(
        localRunIds = listOf("local-a", "local-b"),
        advertisedRunIds = listOf("server", "local-b", "local-a"),
      ),
    )
    assertEquals(
      "local-a",
      resolvePreferredActiveRunId(
        localRunIds = listOf("local-b", "local-a"),
        advertisedRunIds = listOf("server"),
      ),
    )
    assertEquals("server", resolvePreferredActiveRunId(emptyList(), listOf("server", "later")))
  }

  @Test
  fun activeRunCountIncludesBooleanFallbackWithoutAnId() {
    assertEquals(
      1,
      resolveSelectedActiveRunCount(
        localRunIds = emptyList(),
        advertisedRunIds = emptyList(),
        hasAdvertisedRun = true,
      ),
    )
    assertEquals(
      3,
      resolveSelectedActiveRunCount(
        localRunIds = listOf("local", "overlap"),
        advertisedRunIds = listOf("overlap", "server"),
        hasAdvertisedRun = true,
      ),
    )
  }
}
