package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeStringResource
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale

internal data class TurnRecap(
  val runtimeMs: Long,
  val outputTokens: Long?,
)

internal data class TurnRecapTranscriptState(
  val sessionKey: String?,
  val newestItemId: String?,
  val completedEndedAt: Long?,
  val completedNewestItemId: String?,
)

internal data class TurnRecapTokenFormat(
  val singular: Boolean,
  val count: String,
)

/**
 * [baselineEndedAt] is the session row's endedAt when the working indicator appeared: the
 * previous run's terminal stamp, or null once the run-start patch cleared it. Only a row whose
 * endedAt moved past that baseline belongs to the run this pane watched. [settled] freezes the
 * first recap while [settledTranscriptItemId] still identifies the transcript's newest item.
 */
private data class TurnRecapWatch(
  var watching: Boolean,
  /** False until a session row was observed; without a baseline, a later terminal is ambiguous. */
  var baselineKnown: Boolean,
  var baselineEndedAt: Long?,
  /** A stamp changed while the claw was still up, so later stamps cannot be attributed safely. */
  var absorbedTerminal: Boolean,
  /** First idle render after the indicator cleared; canceled queued sends must expire promptly. */
  var settleStartedAt: Long?,
  var pendingTerminal: TurnRecap?,
  var pendingTerminalEndedAt: Long?,
  val settled: TurnRecap?,
  val settledTranscriptItemId: String?,
  val tracksTranscript: Boolean,
)

/**
 * Session rows have no run identity. The watched terminal normally arrives moments after the
 * indicator clears, so an unresolved watch expires after this window instead of matching an
 * unrelated later completion. An unrelated completion inside the window remains an accepted,
 * cosmetic ambiguity until the gateway supplies a terminal-row run id.
 */
internal const val TURN_RECAP_SETTLE_WINDOW_MS = 30_000L

internal class TurnRecapResolver(
  private val nowMs: () -> Long = System::currentTimeMillis,
) {
  private val watches = mutableMapOf<String, TurnRecapWatch>()

  /** Leaving before settlement destroys attribution; settled recaps remain until superseded. */
  fun abandonActiveWatch(sessionKey: String) {
    val watch = watches[sessionKey] ?: return
    if (watch.settled == null) watches.remove(sessionKey)
  }

  /**
   * Watches while the indicator is visible, then resolves the first fresh terminal row. Only a
   * clean `done` with runtime data produces a recap; every other fresh terminal consumes quietly.
   */
  fun resolve(
    sessionKey: String,
    indicatorVisible: Boolean,
    row: ChatSessionEntry?,
  ): TurnRecap? =
    resolveInternal(
      sessionKey = sessionKey,
      indicatorVisible = indicatorVisible,
      row = row,
      transcript = null,
    )

  fun resolve(
    sessionKey: String,
    indicatorVisible: Boolean,
    row: ChatSessionEntry?,
    transcript: TurnRecapTranscriptState,
  ): TurnRecap? =
    resolveInternal(
      sessionKey = sessionKey,
      indicatorVisible = indicatorVisible,
      row = row,
      transcript = transcript,
    )

  private fun resolveInternal(
    sessionKey: String,
    indicatorVisible: Boolean,
    row: ChatSessionEntry?,
    transcript: TurnRecapTranscriptState?,
  ): TurnRecap? {
    val watch = watches[sessionKey]
    val rowEndedAt = row?.endedAt
    if (indicatorVisible) {
      if (watch == null || !watch.watching) {
        watches[sessionKey] =
          TurnRecapWatch(
            watching = true,
            baselineKnown = row != null,
            baselineEndedAt = rowEndedAt,
            absorbedTerminal = false,
            settleStartedAt = null,
            pendingTerminal = null,
            pendingTerminalEndedAt = null,
            settled = null,
            settledTranscriptItemId = null,
            tracksTranscript = transcript != null,
          )
      } else if (!watch.baselineKnown) {
        if (row != null) {
          watch.baselineKnown = true
          watch.baselineEndedAt = rowEndedAt
        }
      } else if (rowEndedAt != null && rowEndedAt != watch.baselineEndedAt) {
        watch.baselineEndedAt = rowEndedAt
        watch.absorbedTerminal = true
      }
      return null
    }
    if (watch == null) {
      val restored = restoredTranscriptRecap(sessionKey, row, transcript) ?: return null
      watches[sessionKey] =
        TurnRecapWatch(
          watching = false,
          baselineKnown = true,
          baselineEndedAt = rowEndedAt,
          absorbedTerminal = false,
          settleStartedAt = null,
          pendingTerminal = null,
          pendingTerminalEndedAt = null,
          settled = restored,
          settledTranscriptItemId = transcript?.completedNewestItemId,
          tracksTranscript = true,
        )
      return restored
    }
    watch.watching = false
    watch.settled?.let { settled ->
      if (
        !watch.tracksTranscript ||
        transcript?.sessionKey != sessionKey ||
        watch.settledTranscriptItemId == transcript.newestItemId
      ) {
        return settled
      }
      // A newer transcript turn has replaced the content this recap summarized. Session rows do
      // not expose enough run identity to reposition it safely, so discard it.
      watches.remove(sessionKey)
      return null
    }
    if (watch.absorbedTerminal || !watch.baselineKnown) {
      // Attribution is ambiguous, so fail quiet instead of freezing another run's numbers.
      watches.remove(sessionKey)
      return null
    }
    if (watch.settleStartedAt == null) {
      watch.settleStartedAt = nowMs()
    } else if (nowMs() - checkNotNull(watch.settleStartedAt) > TURN_RECAP_SETTLE_WINDOW_MS) {
      watches.remove(sessionKey)
      return null
    }
    val isStale =
      rowEndedAt == null ||
        (watch.baselineEndedAt != null && rowEndedAt <= checkNotNull(watch.baselineEndedAt))
    if (isStale) {
      // No watched terminal yet. Stamps never regress, so <= stays stale until the bounded expiry.
      return null
    }
    // Any fresh non-success concludes the watch. Waiting past it could attach a later unrelated
    // success to this turn.
    val runtimeMs = row.runtimeMs
    if (row.status != "done" || runtimeMs == null) {
      watches.remove(sessionKey)
      return null
    }
    val terminal = TurnRecap(runtimeMs = runtimeMs, outputTokens = row.outputTokens)
    if (watch.pendingTerminalEndedAt != null && watch.pendingTerminalEndedAt != rowEndedAt) {
      // Session rows have no run id. Once another terminal replaces the candidate, attribution is
      // gone even if a history refresh completes inside the settlement window.
      watches.remove(sessionKey)
      return null
    }
    if (
      watch.tracksTranscript &&
      (
        transcript?.sessionKey != sessionKey ||
          transcript.completedEndedAt != rowEndedAt
      )
    ) {
      // The terminal session row can arrive before the terminal-triggered chat.history snapshot.
      // Keep waiting so its final item becomes the recap anchor, not an intermediate tool row.
      watch.pendingTerminal = terminal
      watch.pendingTerminalEndedAt = rowEndedAt
      return null
    }
    if (watch.tracksTranscript && transcript?.newestItemId != transcript?.completedNewestItemId) {
      // Newer transcript content already superseded the completed snapshot before this pane could
      // settle it, so there is no safe recap attribution left to display.
      watches.remove(sessionKey)
      return null
    }
    watches.remove(sessionKey)
    val settled = watch.pendingTerminal ?: terminal
    watches[sessionKey] =
      watch.copy(
        settled = settled,
        settledTranscriptItemId = transcript?.completedNewestItemId,
      )
    return settled
  }

  private fun restoredTranscriptRecap(
    sessionKey: String,
    row: ChatSessionEntry?,
    transcript: TurnRecapTranscriptState?,
  ): TurnRecap? {
    val endedAt = row?.endedAt ?: return null
    val runtimeMs = row.runtimeMs ?: return null
    if (row.status != "done" || transcript?.sessionKey != sessionKey) return null
    if (transcript.completedEndedAt != endedAt) return null
    if (transcript.newestItemId == null || transcript.newestItemId != transcript.completedNewestItemId) return null
    return TurnRecap(runtimeMs = runtimeMs, outputTokens = row.outputTokens)
  }
}

@Composable
internal fun localizedChatOutputTokens(count: Long): String {
  val locale = LocalConfiguration.current.locales[0]
  val format = turnRecapTokenFormat(count, locale)
  return if (format.singular) {
    nativeStringResource("1 token")
  } else {
    nativeStringResource("\$count tokens", format.count)
  }
}

internal fun turnRecapTokenFormat(
  count: Long,
  locale: Locale = Locale.getDefault(),
): TurnRecapTokenFormat = TurnRecapTokenFormat(singular = count == 1L, count = formatCompactTokenCount(count, locale))

internal fun formatCompactTokenCount(
  count: Long,
  locale: Locale = Locale.getDefault(),
): String {
  val decimalFormat =
    NumberFormat.getNumberInstance(locale).apply {
      isGroupingUsed = false
      minimumFractionDigits = 0
      maximumFractionDigits = 1
      roundingMode = RoundingMode.HALF_UP
    }

  fun decimal(value: Double): String = decimalFormat.format(value)

  fun millions(): String {
    val value = decimal(count / 1_000_000.0)
    return nativeString("\${decimal(count / 1_000_000.0)}M", value)
  }

  return when {
    count >= 1_000_000L -> {
      millions()
    }

    count >= 1_000L -> {
      val thousands = decimal(count / 1_000.0)
      if (count >= 999_950L) millions() else nativeString("\${thousands}k", thousands)
    }

    else -> {
      count.toString()
    }
  }
}
