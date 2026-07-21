package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatWorkingIndicatorTest {
  @Test
  fun stanceSelectionIsDeterministicForRunAndSalt() {
    val first = pickWorkingClawStance("run-123", salt = 42)

    repeat(20) {
      assertEquals(first, pickWorkingClawStance("run-123", salt = 42))
    }
  }

  @Test
  fun stanceSelectionUsesConfiguredWeights() {
    val key = "run-weight-check"
    val hash = workingClawHash(key)
    val counts = mutableMapOf<WorkingClawStance, Int>()

    repeat(1_000) { bucket ->
      val stance = pickWorkingClawStance(key, salt = hash xor bucket)
      counts[stance] = counts.getOrDefault(stance, 0) + 1
    }

    assertEquals(660, counts[WorkingClawStance.Default])
    assertEquals(200, counts[WorkingClawStance.Southpaw])
    assertEquals(50, counts[WorkingClawStance.Flurry])
    assertEquals(40, counts[WorkingClawStance.Spin])
    assertEquals(30, counts[WorkingClawStance.Shadowbox])
    assertEquals(20, counts[WorkingClawStance.Backflip])
  }

  @Test
  fun phraseStrideVisitsEveryPhraseWithoutAdjacentRepeats() {
    val indexes = (0L until 19L).map { bucket -> workingPhraseIndex("run-phrase", bucket) }

    assertEquals(19, indexes.toSet().size)
    indexes.zipWithNext().forEach { (previous, next) -> assertNotEquals(previous, next) }
    assertNotEquals(indexes.last(), workingPhraseIndex("run-phrase", 19L))
  }

  @Test
  fun phraseWaitsThirtySecondsAndRotatesEveryFortyFive() {
    assertEquals(null, workingPhraseIndexForElapsed("run-phrase", WORKING_PHRASE_SHOW_AFTER_MS - 1L))
    val first = workingPhraseIndexForElapsed("run-phrase", WORKING_PHRASE_SHOW_AFTER_MS)
    assertEquals(first, workingPhraseIndexForElapsed("run-phrase", WORKING_PHRASE_SHOW_AFTER_MS + 44_999L))
    assertNotEquals(first, workingPhraseIndexForElapsed("run-phrase", WORKING_PHRASE_SHOW_AFTER_MS + 45_000L))
  }

  @Test
  fun compactDurationClampsToOneSecond() {
    assertEquals("1s", formatChatDurationCompact(0L))
    assertEquals("1m 30s", formatChatDurationCompact(90_000L))
    assertTrue(formatChatDurationCompact(3_600_000L).startsWith("1h"))
  }

  @Test
  fun provisionalRunAdoptsAuthoritativeIdentityWithoutChangingLocalStart() {
    val tracker = ChatWorkingRunTracker("agent:main:main")
    val provisional = requireNotNull(tracker.resolve(indicatorVisible = true, session = null, nowElapsedMs = 5_000L))

    val authoritative =
      requireNotNull(
        tracker.resolve(
          indicatorVisible = true,
          session =
            ChatSessionEntry(
              key = "agent:main:main",
              updatedAtMs = 6_000L,
              status = "running",
              startedAt = 4_000L,
              activeRunIds = listOf("run-1"),
            ),
          nowElapsedMs = 6_000L,
        ),
      )

    assertEquals(provisional.key, authoritative.key)
    assertEquals(5_000L, authoritative.observedAtElapsedMs)
    assertEquals("run-1", authoritative.authoritativeRunId)
    assertEquals(4_000L, authoritative.authoritativeStartedAtMs)
  }

  @Test
  fun authoritativeReplacementGetsANewRunIdentity() {
    val tracker = ChatWorkingRunTracker("agent:main:main")
    val first =
      requireNotNull(
        tracker.resolve(
          indicatorVisible = true,
          session =
            ChatSessionEntry(
              key = "agent:main:main",
              updatedAtMs = 1L,
              status = "running",
              startedAt = 1_000L,
              activeRunIds = listOf("run-1"),
            ),
          nowElapsedMs = 7_000L,
        ),
      )
    val replacement =
      requireNotNull(
        tracker.resolve(
          indicatorVisible = true,
          session =
            ChatSessionEntry(
              key = "agent:main:main",
              updatedAtMs = 2L,
              status = "running",
              startedAt = 2_000L,
              activeRunIds = listOf("run-2"),
            ),
          nowElapsedMs = 9_000L,
        ),
      )

    assertEquals("run-1", first.key)
    assertEquals("run-2", replacement.key)
    assertEquals(9_000L, replacement.observedAtElapsedMs)
    assertEquals(2_000L, replacement.authoritativeStartedAtMs)
  }
}
