package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatSessionAgentStatus
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.applySessionObserverDigest
import ai.openclaw.app.chat.mergeChatSessionEntry
import ai.openclaw.app.chat.reconcileGlobalObserverDigestOwner
import ai.openclaw.app.chat.reconcileSessionObserverProjectionOwner
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
  fun globalObserverEventsRequireTheSelectedAgent() {
    val running =
      ChatSessionEntry(
        key = "global",
        updatedAtMs = 100,
        hasActiveRun = true,
        activeRunIds = listOf("run-work"),
        status = "running",
      )
    val wrongOwner =
      SessionObserverDigest(
        sessionKey = "global",
        agentId = "main",
        runId = "run-work",
        revision = 1,
        updatedAt = 200,
        headline = "Wrong owner",
        health = "stuck",
      )
    val selectedOwner = wrongOwner.copy(agentId = "work", headline = "Selected owner")
    val missingOwner = wrongOwner.copy(agentId = null, headline = "Missing owner")

    val rejected = applySessionObserverDigest(listOf(running), wrongOwner, activeAgentId = "work")
    val ownerless =
      applySessionObserverDigest(
        rejected,
        missingOwner,
        activeAgentId = "work",
      )
    val disconnected =
      applySessionObserverDigest(
        listOf(running.copy(observerDigest = wrongOwner.copy(headline = "Last verified owner"))),
        missingOwner,
        activeAgentId = null,
      )
    val accepted = applySessionObserverDigest(ownerless, selectedOwner, activeAgentId = "work")

    assertNull(rejected.single().observerDigest)
    assertNull(ownerless.single().observerDigest)
    assertEquals("Last verified owner", disconnected.single().observerDigest?.headline)
    assertEquals("Selected owner", accepted.single().observerDigest?.headline)
  }

  @Test
  fun globalReconnectRejectsForeignAndStaleObserverDigests() {
    val current =
      SessionObserverDigest(
        sessionKey = "global",
        agentId = "work",
        runId = "run-work",
        revision = 4,
        updatedAt = 400,
        headline = "Current work status",
        health = "grinding",
      )
    val running =
      ChatSessionEntry(
        key = "global",
        updatedAtMs = 100,
        hasActiveRun = true,
        activeRunIds = listOf("run-work"),
        status = "running",
        observerDigest = current,
      )

    val foreign =
      applySessionObserverDigest(
        listOf(running),
        current.copy(
          agentId = "main",
          revision = 9,
          updatedAt = 900,
          headline = "Foreign status",
        ),
        activeAgentId = "work",
      )
    val replayed =
      applySessionObserverDigest(
        foreign,
        current.copy(
          revision = 3,
          updatedAt = 1_000,
          headline = "Replayed work status",
        ),
        activeAgentId = "work",
      )

    assertEquals("Current work status", replayed.single().observerDigest?.headline)
    assertEquals(4L, replayed.single().observerDigest?.revision)
  }

  @Test
  fun changingTheSelectedAgentClearsThePreviousGlobalDigest() {
    val previous =
      ChatSessionEntry(
        key = "global",
        updatedAtMs = 100,
        hasActiveRun = true,
        activeRunIds = listOf("run-main"),
        status = "running",
        observerDigest =
          SessionObserverDigest(
            sessionKey = "global",
            agentId = "main",
            runId = "run-main",
            revision = 4,
            updatedAt = 400,
            headline = "Main owner",
            health = "on-track",
          ),
      )

    val switched =
      reconcileGlobalObserverDigestOwner(
        listOf(previous),
        activeAgentId = "work",
        adoptOwnerless = false,
      )
    val ownerless =
      reconcileGlobalObserverDigestOwner(
        listOf(previous.copy(observerDigest = previous.observerDigest?.copy(agentId = null))),
        activeAgentId = "work",
        adoptOwnerless = false,
      )
    val disconnected =
      reconcileGlobalObserverDigestOwner(
        listOf(previous),
        activeAgentId = null,
        adoptOwnerless = false,
      )

    assertNull(switched.single().observerDigest)
    assertNull(ownerless.single().observerDigest)
    assertEquals("Main owner", disconnected.single().observerDigest?.headline)
  }

  @Test
  fun globalSessionProjectionRequiresMatchingOuterAndDigestOwners() {
    val projected =
      ChatSessionEntry(
        key = "global",
        updatedAtMs = 900,
        ownerAgentId = "work",
        status = "running",
        observerDigest =
          SessionObserverDigest(
            sessionKey = "global",
            agentId = "main",
            runId = "run-main",
            revision = 9,
            updatedAt = 900,
            headline = "Foreign owner",
            health = "stuck",
          ),
      )

    val mismatched = reconcileSessionObserverProjectionOwner(projected, ownerAgentId = "work")
    val legacy =
      reconcileSessionObserverProjectionOwner(
        projected.copy(observerDigest = projected.observerDigest?.copy(agentId = null)),
        ownerAgentId = "work",
      )

    assertNull(mismatched.observerDigest)
    assertEquals("running", mismatched.status)
    assertEquals("work", legacy.observerDigest?.agentId)

    val scopedLegacy =
      reconcileGlobalObserverDigestOwner(
        listOf(projected.copy(observerDigest = projected.observerDigest?.copy(agentId = null))),
        activeAgentId = "work",
      )
    assertEquals("work", scopedLegacy.single().observerDigest?.agentId)
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

    assertEquals("Needs approval", sessionListSubtitle(failed, fallback = "Work", nowMs = 1_000, activeRunLabel = "Working"))
    assertEquals(
      "Agent note",
      sessionListSubtitle(failed.copy(status = "running", lastRunError = null), fallback = "Work", nowMs = 1_000, activeRunLabel = "Working"),
    )
    assertEquals(
      "Waiting for a concurrency slot",
      sessionListSubtitle(
        failed.copy(agentStatus = null, status = "queued", lastRunError = null),
        fallback = "Work",
        nowMs = 1_000,
        activeRunLabel = "Working",
      ),
    )

    assertEquals(
      "Observer",
      sessionListSubtitle(failed.copy(agentStatus = null, status = "running", lastRunError = null), fallback = "Work", nowMs = 1_000, activeRunLabel = "Working"),
    )

    val finalDigest = digest(runId = null, revision = 2, updatedAt = 2_000, headline = "Finished", health = "done")
    val idle = ChatSessionEntry(key = "work", updatedAtMs = 2_000, lastReadAt = 1_999, observerDigest = finalDigest)
    assertEquals("Finished", sessionListSubtitle(idle, fallback = "Work", nowMs = 3_000, activeRunLabel = "Working"))
    assertEquals("Work", sessionListSubtitle(idle.copy(lastReadAt = 2_000), fallback = "Work", nowMs = 3_000, activeRunLabel = "Working"))
    assertEquals("Working", sessionListSubtitle(idle.copy(observerDigest = null, hasActiveRun = true), fallback = "Work", nowMs = 3_000, activeRunLabel = "Working"))
    assertEquals("Working", sessionListSubtitle(idle.copy(observerDigest = null, status = " RUNNING "), fallback = "Work", nowMs = 3_000, activeRunLabel = "Working"))
  }

  @Test
  fun subtitleHonorsLiveRunPrecedenceWithoutLosingQueuedOrFinalText() {
    for ((status, flag, expected) in listOf(
      Triple("running", false, "Thread"),
      Triple("running", null, "Working"),
      Triple("done", true, "Thread"),
      Triple("failed", true, "Thread"),
      Triple("killed", true, "Thread"),
      Triple("timeout", true, "Thread"),
      Triple("queued", false, "Thread"),
      Triple("queued", null, "Waiting for a concurrency slot"),
    )) {
      val row = ChatSessionEntry(key = "work", updatedAtMs = 500, status = status, hasActiveRun = flag)
      assertEquals("status=$status flag=$flag", expected, sessionListSubtitle(row, fallback = "Thread", nowMs = 1_000, activeRunLabel = "Working"))
    }
    val finished =
      ChatSessionEntry(
        key = "agent:main:work",
        updatedAtMs = 500,
        status = "done",
        hasActiveRun = true,
        observerDigest = digest(runId = "finished-run", revision = 1, updatedAt = 500, headline = "Finished", health = "done"),
        lastReadAt = 499,
      )
    assertEquals("Finished", sessionListSubtitle(finished, fallback = "Thread", nowMs = 1_000, activeRunLabel = "Working"))
    assertEquals("Finished", sessionListSubtitle(finished.copy(status = "queued", hasActiveRun = false), fallback = "Thread", nowMs = 1_000, activeRunLabel = "Working"))
    assertEquals("Waiting for a concurrency slot", sessionListSubtitle(finished.copy(status = "queued", hasActiveRun = true), fallback = "Thread", nowMs = 1_000, activeRunLabel = "Working"))
  }

  @Test
  fun inactiveSessionRejectsObserverEventsDespiteStaleRunMetadata() {
    for ((status, flag) in listOf("running" to false, "done" to true)) {
      val finished = digest(runId = "run-1", revision = 3, updatedAt = 500, headline = "Finished", health = "done")
      val row =
        ChatSessionEntry(
          key = finished.sessionKey,
          updatedAtMs = 500,
          hasActiveRun = flag,
          status = status,
          activeRunIds = listOf("run-1"),
          observerDigest = finished,
        )
      val late = digest(runId = "run-1", revision = 4, updatedAt = 600, headline = "Late work")
      assertEquals("status=$status flag=$flag", row, applySessionObserverDigest(listOf(row), late).single())
    }
  }

  @Test
  fun inactiveProjectionRetainsFinalDigestWhenActiveRunIdsClear() {
    val finished = digest(runId = "run-1", revision = 3, updatedAt = 500, headline = "Finished", health = "done")
    val prior =
      ChatSessionEntry(
        key = finished.sessionKey,
        updatedAtMs = 500,
        hasActiveRun = true,
        status = "running",
        activeRunIds = listOf("run-1"),
        observerDigest = finished,
      )
    for ((status, flag) in listOf("running" to false, "done" to true)) {
      val next = ChatSessionEntry(key = prior.key, updatedAtMs = 600, hasActiveRun = flag, status = status, activeRunIds = emptyList())
      val merged = mergeChatSessionEntry(prior, next)
      assertEquals("status=$status flag=$flag", finished, merged.observerDigest)
      assertEquals("Finished", sessionListSubtitle(merged, fallback = "Thread", nowMs = 1_000, activeRunLabel = "Working"))
    }
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
