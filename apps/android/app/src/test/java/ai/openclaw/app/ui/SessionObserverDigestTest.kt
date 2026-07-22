package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatSessionAgentStatus
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.applySessionObserverDigest
import ai.openclaw.app.chat.mergeChatSessionEntry
import ai.openclaw.app.gateway.SessionObserverDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionObserverDigestTest {
  @Test
  fun observerEventsRequireTheServerRunAndAdvanceMonotonically() {
    val running =
      ChatSessionEntry(
        key = "agent:main:work",
        updatedAtMs = 100,
        hasActiveRun = true,
        activeRunIds = listOf(" run-1 "),
        status = "running",
      )
    var sessions =
      applySessionObserverDigest(
        listOf(running),
        digest(runId = "run-1", revision = 2, updatedAt = 200, headline = "Second"),
      )
    sessions =
      applySessionObserverDigest(
        sessions,
        digest(runId = "run-1", revision = 1, updatedAt = 300, headline = "Stale"),
      )
    sessions =
      applySessionObserverDigest(
        sessions,
        digest(runId = "run-old", revision = 3, updatedAt = 400, headline = "Wrong run"),
      )

    assertEquals("Second", sessions.single().observerDigest?.headline)
    assertEquals("Second", sessionListSubtitle(sessions.single(), fallback = "Work", nowMs = 1_000))

    val projected =
      ChatSessionEntry(
        key = running.key,
        updatedAtMs = 500,
        observerDigest = digest(runId = "run-1", revision = 3, updatedAt = 500, headline = "Projected"),
        hasObserverDigestMetadata = true,
        hasActiveRun = true,
        activeRunIds = listOf("run-1"),
        hasActiveRunMetadata = true,
        status = "running",
        hasRunMetadata = true,
      )
    assertEquals("Projected", mergeChatSessionEntry(sessions.single(), projected).observerDigest?.headline)
  }

  @Test
  fun sessionProjectionClearsDigestOnRunRollover() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:work",
        updatedAtMs = 100,
        hasActiveRun = true,
        activeRunIds = listOf("run-1"),
        status = "running",
        observerDigest = digest(runId = "run-1", revision = 8, updatedAt = 800, headline = "Old run"),
      )
    val replacement =
      ChatSessionEntry(
        key = existing.key,
        updatedAtMs = 900,
        hasActiveRun = true,
        activeRunIds = listOf("run-2"),
        hasActiveRunMetadata = true,
        status = "running",
        hasRunMetadata = true,
      )

    val rolled = mergeChatSessionEntry(existing, replacement)

    assertNull(rolled.observerDigest)
    val accepted =
      applySessionObserverDigest(
        listOf(rolled),
        digest(runId = "run-2", revision = 1, updatedAt = 901, headline = "New run"),
      )
    assertEquals("New run", accepted.single().observerDigest?.headline)
  }

  @Test
  fun explicitNullProjectionClearsDigestWhileRunIsActive() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:work",
        updatedAtMs = 100,
        observerDigest = digest(runId = "run-1", revision = 4, updatedAt = 400, headline = "Stale"),
        hasActiveRun = true,
        activeRunIds = listOf("run-1"),
        status = "running",
      )
    val explicitClear =
      ChatSessionEntry(
        key = existing.key,
        updatedAtMs = 500,
        observerDigest = null,
        hasObserverDigestMetadata = true,
        hasActiveRun = true,
        activeRunIds = listOf("run-1"),
        hasActiveRunMetadata = true,
        status = "running",
        hasRunMetadata = true,
      )

    assertNull(mergeChatSessionEntry(existing, explicitClear).observerDigest)
  }

  @Test
  fun subtitlePrecedenceAndUnreadFinalRuleMatchTheWebSidebar() {
    val liveDigest = digest(runId = "run-1", revision = 1, updatedAt = 200, headline = "Observer")
    val agentStatus = ChatSessionAgentStatus(note = "Agent note", expiresAt = 10_000)
    val failed =
      ChatSessionEntry(
        key = "work",
        updatedAtMs = 500,
        lastReadAt = 100,
        agentStatus = agentStatus,
        observerDigest = liveDigest,
        hasActiveRun = true,
        activeRunIds = listOf("run-1"),
        status = "failed",
        lastRunError = "Needs approval",
        endedAt = 500,
      )

    assertEquals("Needs approval", sessionListSubtitle(failed, fallback = "Work", nowMs = 1_000))
    assertEquals(
      "Agent note",
      sessionListSubtitle(failed.copy(status = "running", lastRunError = null), fallback = "Work", nowMs = 1_000),
    )

    val finalDigest = digest(runId = null, revision = 2, updatedAt = 2_000, headline = "Finished", health = "done")
    val idle = ChatSessionEntry(key = "work", updatedAtMs = 2_000, lastReadAt = 1_999, observerDigest = finalDigest)
    assertEquals("Finished", sessionListSubtitle(idle, fallback = "Work", nowMs = 3_000))
    assertEquals("Work", sessionListSubtitle(idle.copy(lastReadAt = 2_000), fallback = "Work", nowMs = 3_000))
  }

  private fun digest(
    runId: String?,
    revision: Long,
    updatedAt: Long,
    headline: String,
    health: String = "on-track",
  ): SessionObserverDigest =
    SessionObserverDigest(
      sessionKey = "agent:main:work",
      runId = runId,
      revision = revision,
      updatedAt = updatedAt,
      headline = headline,
      health = health,
    )
}
