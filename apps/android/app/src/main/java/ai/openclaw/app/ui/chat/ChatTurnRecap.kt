package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeStringResource
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
    if (watch == null) return null
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
}

@Composable
internal fun ChatTurnRecapRow(recap: TurnRecap) {
  val duration = formatLocalizedChatDurationCompact(recap.runtimeMs.coerceAtLeast(1_000L))
  val tokens =
    recap.outputTokens?.let { count ->
      val format = turnRecapTokenFormat(count)
      if (format.singular) {
        nativeStringResource("1 token")
      } else {
        nativeStringResource("\$count tokens", format.count)
      }
    }
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(7.dp),
  ) {
    WorkingClawIcon(runKey = "turn-recap", color = ClawTheme.colors.primary, parked = true)
    Text(
      text = nativeStringResource("Done in \$duration", duration),
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textMuted,
    )
    tokens?.let {
      Text(text = nativeStringResource("·"), style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
      Text(text = it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}

internal fun turnRecapTokenFormat(count: Long): TurnRecapTokenFormat = TurnRecapTokenFormat(singular = count == 1L, count = formatCompactTokenCount(count))

internal fun formatCompactTokenCount(count: Long): String {
  fun decimal(value: Double): String = String.format(Locale.US, "%.1f", value).removeSuffix(".0")

  fun millions(): String {
    val value = decimal(count / 1_000_000.0)
    return nativeString("\${decimal(count / 1_000_000.0)}M", value)
  }

  return when {
    count >= 1_000_000L -> millions()
    count >= 1_000L -> {
      val thousands = decimal(count / 1_000.0)
      if (thousands == "1000") millions() else nativeString("\${thousands}k", thousands)
    }
    else -> count.toString()
  }
}
