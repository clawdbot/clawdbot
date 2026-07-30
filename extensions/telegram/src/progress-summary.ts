// Post-turn collapse summary for the Telegram progress window.
//
// Mirrors Discord's collapse-summary line (extensions/discord/src/monitor/
// message-handler.process.ts `buildProgressSummaryLine`): when the ephemeral
// progress draft collapses at end-of-turn, Discord posts a one-line activity
// digest like `🧠 3 thoughts · 💬 2 notes · 🛠️ 4 tool calls · ⏱️ 21s`.
//
// Telegram had no equivalent (conformance discrepancy #4). This tracks the same
// turn-activity counters channel-side (Discord also tallies these in its handler,
// not in core) and formats the same content. The only divergence is the line
// prefix: Discord wraps the line in its `-#` small-text syntax, which Telegram
// markdown has no analog for, so the Telegram line is emitted plain.

type TelegramProgressSummaryCounters = {
  reasoningSteps: number;
  commentaryNotes: number;
  toolCalls: number;
};

// Tracks turn activity for the collapse summary. The summary reflects ONLY what
// actually streamed to the progress window — never durable-delivered items
// (per the user's spec: "only summarize messages that ACTUALLY streamed").
// So there is deliberately no durable-reasoning counter: in rv (/reasoning on)
// thoughts persist as standalone messages and must NOT feed the bar, or the bar
// would show even though nothing streamed to the window. A reasoning "burst" is
// counted once at whichever boundary arrives first — the reasoning-end event,
// the next tool call, or the summary flush — because some models (e.g. deepseek)
// do not emit a reliable thinking_end per burst, so counting on the end event
// alone undercounts.
type TelegramProgressSummaryTracker = {
  /** A reasoning delta arrived; opens (or keeps open) the current burst. */
  noteReasoningActivity(): void;
  /** Reasoning-end fired; close and count the current burst if one is open. */
  closeReasoningBurst(): void;
  /**
   * A window-rendered tool call started: it is the boundary for any open
   * reasoning/commentary burst, so close+count those first, then count one tool.
   * Callers count the tool only when it is suppressed (window-rendered); under
   * verbose the tool persists durably and they close the bursts directly instead
   * (closeReasoningBurst/closeCommentaryBurst) without calling this.
   */
  noteToolCall(): void;
  /**
   * A commentary/preamble note arrived for the window. Opens (or keeps open) a
   * commentary burst — it is NOT counted here. The burst is counted once when it
   * closes at the next boundary (tool start, reasoning-end, a different note, or
   * the summary flush). Counting per-burst rather than per-id is deliberate: the
   * anthropic core tags every note in a turn with the SAME turn-local id
   * ("commentary-0"), so an id-Set dedup collapsed a multi-tool turn's notes to
   * one (D3). A tool follows each note in a tool-using turn, closing its burst
   * before the next note opens => N notes.
   */
  noteCommentary(itemId?: string, text?: string): void;
  /** Close and count the current commentary burst if one is open. */
  closeCommentaryBurst(): void;
  /** Snapshot of the current counters (closes any open bursts into the tally). */
  counts(): TelegramProgressSummaryCounters;
  /** True when there is at least one thought, note, or tool call to summarize. */
  hasActivity(): boolean;
};

export function createTelegramProgressSummaryTracker(): TelegramProgressSummaryTracker {
  let reasoningSteps = 0;
  let commentaryNotes = 0;
  let toolCalls = 0;
  let reasoningBurstOpen = false;
  // One open commentary burst at a time (mirrors Discord's windowCommentaryOpen /
  // closePendingWindowCommentary). A re-fire of the SAME note (same id, or prefix
  // growth of the same id-less streamed text) keeps the burst open; a different
  // note with no intervening boundary closes the previous burst before opening
  // the new one.
  let commentaryBurstOpen = false;
  let openCommentaryItemId: string | undefined;
  let openCommentaryText = "";

  const closeReasoningBurst = () => {
    if (reasoningBurstOpen) {
      reasoningBurstOpen = false;
      reasoningSteps += 1;
    }
  };

  const closeCommentaryBurst = () => {
    if (commentaryBurstOpen) {
      commentaryBurstOpen = false;
      openCommentaryItemId = undefined;
      openCommentaryText = "";
      commentaryNotes += 1;
    }
  };

  return {
    noteReasoningActivity() {
      reasoningBurstOpen = true;
    },
    closeReasoningBurst,
    noteToolCall() {
      closeReasoningBurst();
      closeCommentaryBurst();
      toolCalls += 1;
    },
    noteCommentary(itemId?: string, text?: string) {
      const trimmed = text?.trim();
      if (!trimmed) {
        return;
      }
      const id = itemId?.trim() || undefined;
      if (commentaryBurstOpen) {
        const sameNote = openCommentaryItemId
          ? id === openCommentaryItemId
          : !id &&
            (trimmed === openCommentaryText ||
              trimmed.startsWith(openCommentaryText) ||
              openCommentaryText.startsWith(trimmed));
        if (sameNote) {
          openCommentaryText = trimmed;
          return;
        }
        // A different note arrived with no intervening boundary: close the
        // previous burst before opening the new one.
        closeCommentaryBurst();
      }
      commentaryBurstOpen = true;
      openCommentaryItemId = id;
      openCommentaryText = trimmed;
    },
    closeCommentaryBurst,
    counts() {
      closeReasoningBurst();
      closeCommentaryBurst();
      return { reasoningSteps, commentaryNotes, toolCalls };
    },
    hasActivity() {
      return (
        reasoningBurstOpen ||
        commentaryBurstOpen ||
        reasoningSteps > 0 ||
        commentaryNotes > 0 ||
        toolCalls > 0
      );
    },
  };
}

// Formats the collapse-summary line. Returns undefined when there is nothing to
// summarize (no thoughts, notes, or tool calls) so a degenerate "⏱️ Ns"-only
// line is never emitted. Content and ordering mirror Discord exactly.
export function formatTelegramProgressSummaryLine(
  counters: TelegramProgressSummaryCounters,
  elapsedMs: number,
): string | undefined {
  const { reasoningSteps, commentaryNotes, toolCalls } = counters;
  if (reasoningSteps <= 0 && commentaryNotes <= 0 && toolCalls <= 0) {
    return undefined;
  }
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  const parts = [
    ...(reasoningSteps > 0
      ? [`🧠 ${reasoningSteps} thought${reasoningSteps === 1 ? "" : "s"}`]
      : []),
    ...(commentaryNotes > 0
      ? [`💬 ${commentaryNotes} note${commentaryNotes === 1 ? "" : "s"}`]
      : []),
    ...(toolCalls > 0 ? [`🛠️ ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`] : []),
    `⏱️ ${seconds}s`,
  ];
  return parts.join(" · ");
}
