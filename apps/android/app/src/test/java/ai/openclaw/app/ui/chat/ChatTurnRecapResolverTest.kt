package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ChatTurnRecapResolverTest {
  private val session = "agent:main:main"
  private val previousEndedAt = 900_000L
  private val runEndedAt = 1_000_000L

  private fun row(
    status: String,
    endedAt: Long? = null,
    runtimeMs: Long? = null,
    outputTokens: Long? = null,
  ): ChatSessionEntry =
    ChatSessionEntry(
      key = session,
      updatedAtMs = endedAt,
      status = status,
      endedAt = endedAt,
      runtimeMs = runtimeMs,
      outputTokens = outputTokens,
      hasRunMetadata = true,
    )

  private fun done(
    endedAt: Long,
    runtimeMs: Long? = 51_000L,
    outputTokens: Long? = null,
  ): ChatSessionEntry = row("done", endedAt, runtimeMs, outputTokens)

  @Test
  fun resolvesOnceAFreshTerminalStampLandsThenSticks() {
    val resolver = TurnRecapResolver()
    assertNull(resolver.resolve(session, true, done(previousEndedAt)))
    assertNull(resolver.resolve(session, false, done(previousEndedAt)))

    val terminal = done(runEndedAt, runtimeMs = 51_000L, outputTokens = 485L)
    val expected = TurnRecap(runtimeMs = 51_000L, outputTokens = 485L)
    assertEquals(expected, resolver.resolve(session, false, terminal))
    assertEquals(expected, resolver.resolve(session, false, terminal))
  }

  @Test
  fun rejectsPreviousTurnAndRegressedStamps() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt))

    assertNull(resolver.resolve(session, false, done(previousEndedAt)))
    assertNull(resolver.resolve(session, false, done(previousEndedAt - 5_000L)))
  }

  @Test
  fun expiresAnUnresolvedWatchInsteadOfMatchingALaterRun() {
    var nowMs = 1_000_000L
    val resolver = TurnRecapResolver { nowMs }
    resolver.resolve(session, true, done(previousEndedAt))
    assertNull(resolver.resolve(session, false, done(previousEndedAt)))

    nowMs += 31_000L
    assertNull(resolver.resolve(session, false, done(previousEndedAt)))
    assertNull(resolver.resolve(session, false, done(runEndedAt)))
  }

  @Test
  fun freshDoneWithoutRuntimeConsumesTheWatch() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt))

    assertNull(resolver.resolve(session, false, done(runEndedAt, runtimeMs = null)))
    assertNull(resolver.resolve(session, false, done(runEndedAt + 1_000L)))
  }

  @Test
  fun clearedRunStartBaselineIsStaleFree() {
    val resolver = TurnRecapResolver()
    assertNull(resolver.resolve(session, true, row(status = "running")))
    assertEquals(
      TurnRecap(runtimeMs = 2_000L, outputTokens = null),
      resolver.resolve(session, false, done(runEndedAt, runtimeMs = 2_000L)),
    )
  }

  @Test
  fun neverResolvesWithoutWatchingAnIndicator() {
    assertNull(TurnRecapResolver().resolve(session, false, done(runEndedAt)))
  }

  @Test
  fun consumesAWatchWhoseBaselineRowWasNeverObserved() {
    val resolver = TurnRecapResolver()
    assertNull(resolver.resolve(session, true, null))
    assertNull(resolver.resolve(session, false, done(previousEndedAt)))
    assertNull(resolver.resolve(session, false, done(runEndedAt)))
  }

  @Test
  fun adoptsTheFirstRowObservedMidWatchAsBaseline() {
    val resolver = TurnRecapResolver()
    assertNull(resolver.resolve(session, true, null))
    assertNull(resolver.resolve(session, true, done(previousEndedAt)))
    assertNull(resolver.resolve(session, false, done(previousEndedAt)))
    assertEquals(
      TurnRecap(runtimeMs = 6_000L, outputTokens = null),
      resolver.resolve(session, false, done(runEndedAt, runtimeMs = 6_000L)),
    )
  }

  @Test
  fun forfeitsWhenATerminalStampChangesMidWatch() {
    val resolver = TurnRecapResolver()
    assertNull(resolver.resolve(session, true, row(status = "running")))
    assertNull(resolver.resolve(session, true, done(previousEndedAt)))
    assertNull(resolver.resolve(session, false, done(previousEndedAt)))
    assertNull(resolver.resolve(session, false, done(runEndedAt, runtimeMs = 4_000L)))
  }

  @Test
  fun forfeitsAFailedTurnWhoseTerminalRacedTheIndicator() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, row(status = "running"))
    resolver.resolve(session, true, row(status = "failed", endedAt = runEndedAt))

    assertNull(resolver.resolve(session, false, row(status = "failed", endedAt = runEndedAt)))
    assertNull(resolver.resolve(session, false, done(runEndedAt + 60_000L)))
  }

  @Test
  fun freezesTheFirstRecapAgainstLaterUnwatchedTerminals() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt))
    val settled = resolver.resolve(session, false, done(runEndedAt, runtimeMs = 51_000L, outputTokens = 485L))

    assertNotNull(settled)
    assertEquals(settled, resolver.resolve(session, false, done(runEndedAt + 90_000L, runtimeMs = 7_000L, outputTokens = 42L)))
  }

  @Test
  fun settledRecapSticksOnlyWhileItsTranscriptAnchorIsNewest() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt), transcript("user-1"))
    val terminal = done(runEndedAt, runtimeMs = 51_000L, outputTokens = 485L)
    val expected = TurnRecap(runtimeMs = 51_000L, outputTokens = 485L)

    assertNull(
      resolver.resolve(session, false, terminal, transcript("assistant-tool")),
    )
    assertEquals(
      expected,
      resolver.resolve(session, false, terminal, transcript("assistant-1", completedEndedAt = runEndedAt)),
    )
    assertEquals(
      expected,
      resolver.resolve(session, false, terminal, transcript("assistant-1", completedEndedAt = runEndedAt)),
    )
    assertNull(
      resolver.resolve(
        session,
        false,
        terminal,
        transcript("assistant-2", completedEndedAt = runEndedAt + 1_000L),
      ),
    )
  }

  @Test
  fun emptyTranscriptWaitsForTheCompletedItemBeforeSettling() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt), transcript(null))
    val terminal = done(runEndedAt, runtimeMs = 2_000L)

    assertNull(resolver.resolve(session, false, terminal, transcript(null)))
    assertEquals(
      TurnRecap(runtimeMs = 2_000L, outputTokens = null),
      resolver.resolve(session, false, terminal, transcript("assistant-1", completedEndedAt = runEndedAt)),
    )
  }

  @Test
  fun newerContentAlreadyPresentWhenHistoryCompletesDropsTheRecap() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt), transcript("user-1"))
    val terminal = done(runEndedAt, runtimeMs = 2_000L)

    assertNull(
      resolver.resolve(
        session,
        false,
        terminal,
        transcript(
          newestItemId = "user-2",
          completedEndedAt = runEndedAt,
          completedNewestItemId = "assistant-1",
        ),
      ),
    )
  }

  @Test
  fun changedTerminalWhileWaitingForHistoryDestroysAttribution() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt), transcript("user-1"))
    assertNull(
      resolver.resolve(session, false, done(runEndedAt), transcript("user-1")),
    )

    assertNull(
      resolver.resolve(
        session,
        false,
        done(runEndedAt + 1_000L, runtimeMs = 9_000L),
        transcript("assistant-2", completedEndedAt = runEndedAt + 1_000L),
      ),
    )
  }

  @Test
  fun terminalWaitingForHistoryStillExpires() {
    var nowMs = 1_000_000L
    val resolver = TurnRecapResolver { nowMs }
    resolver.resolve(session, true, done(previousEndedAt), transcript("user-1"))
    assertNull(
      resolver.resolve(session, false, done(runEndedAt), transcript("user-1")),
    )

    nowMs += TURN_RECAP_SETTLE_WINDOW_MS + 1L
    assertNull(
      resolver.resolve(session, false, done(runEndedAt), transcript("assistant-1", completedEndedAt = runEndedAt)),
    )
  }

  @Test
  fun hidesTheRecapAsSoonAsTheNextIndicatorAppears() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt))
    assertNotNull(resolver.resolve(session, false, done(runEndedAt)))

    assertNull(resolver.resolve(session, true, done(runEndedAt)))
    assertNull(resolver.resolve(session, false, done(runEndedAt)))
  }

  @Test
  fun ignoresAStaleFailedRowThenResolvesAFreshDone() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, row(status = "failed", endedAt = previousEndedAt))

    assertNull(resolver.resolve(session, false, row(status = "failed", endedAt = previousEndedAt)))
    assertEquals(
      TurnRecap(runtimeMs = 3_000L, outputTokens = null),
      resolver.resolve(session, false, done(runEndedAt, runtimeMs = 3_000L)),
    )
  }

  @Test
  fun freshFailedRowConsumesTheWatch() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt))

    assertNull(resolver.resolve(session, false, row(status = "failed", endedAt = runEndedAt)))
    assertNull(resolver.resolve(session, false, done(runEndedAt + 1_000L)))
  }

  @Test
  fun leavingTheSessionAbandonsUnsettledButKeepsSettled() {
    val resolver = TurnRecapResolver()
    resolver.resolve(session, true, done(previousEndedAt))
    assertNull(resolver.resolve(session, false, done(previousEndedAt)))
    resolver.abandonActiveWatch(session)
    assertNull(resolver.resolve(session, false, done(runEndedAt)))

    resolver.resolve(session, true, done(previousEndedAt))
    val settled = resolver.resolve(session, false, done(runEndedAt))
    resolver.abandonActiveWatch(session)
    assertEquals(settled, resolver.resolve(session, false, done(runEndedAt + 1_000L)))
  }

  @Test
  fun everyNonDoneTerminalConsumesQuietly() {
    listOf("failed", "killed", "timeout").forEach { status ->
      val resolver = TurnRecapResolver()
      resolver.resolve(session, true, done(previousEndedAt))
      assertNull(resolver.resolve(session, false, row(status = status, endedAt = runEndedAt)))
      assertNull(resolver.resolve(session, false, done(runEndedAt + 1_000L)))
    }
  }

  @Test
  fun formatsZeroOneAndCompactTokenCounts() {
    assertEquals(TurnRecapTokenFormat(singular = false, count = "0"), turnRecapTokenFormat(0L))
    assertEquals(TurnRecapTokenFormat(singular = true, count = "1"), turnRecapTokenFormat(1L))
    assertEquals("1.2k", formatCompactTokenCount(1_234L))
    assertEquals("1M", formatCompactTokenCount(999_999L))
  }

  private fun transcript(
    newestItemId: String?,
    completedEndedAt: Long? = null,
    transcriptSessionKey: String? = session,
    completedNewestItemId: String? = newestItemId.takeIf { completedEndedAt != null },
  ): TurnRecapTranscriptState =
    TurnRecapTranscriptState(
      sessionKey = transcriptSessionKey,
      newestItemId = newestItemId,
      completedEndedAt = completedEndedAt,
      completedNewestItemId = completedNewestItemId,
    )
}
