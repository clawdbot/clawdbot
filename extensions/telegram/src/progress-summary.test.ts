import { describe, expect, it } from "vitest";
import {
  createTelegramProgressSummaryTracker,
  formatTelegramProgressSummaryLine,
} from "./progress-summary.js";

describe("formatTelegramProgressSummaryLine", () => {
  it("renders all three lanes plus elapsed, mirroring Discord content", () => {
    expect(
      formatTelegramProgressSummaryLine(
        { reasoningSteps: 3, commentaryNotes: 2, toolCalls: 4 },
        21_000,
      ),
    ).toBe("🧠 3 thoughts · 💬 2 notes · 🛠️ 4 tool calls · ⏱️ 21s");
  });

  it("uses singular nouns for a count of one", () => {
    expect(
      formatTelegramProgressSummaryLine(
        { reasoningSteps: 1, commentaryNotes: 1, toolCalls: 1 },
        1_000,
      ),
    ).toBe("🧠 1 thought · 💬 1 note · 🛠️ 1 tool call · ⏱️ 1s");
  });

  it("omits lanes with a zero count", () => {
    expect(
      formatTelegramProgressSummaryLine(
        { reasoningSteps: 0, commentaryNotes: 0, toolCalls: 2 },
        5_400,
      ),
    ).toBe("🛠️ 2 tool calls · ⏱️ 5s");
  });

  it("returns undefined when there is nothing to summarize (no degenerate elapsed-only line)", () => {
    expect(
      formatTelegramProgressSummaryLine(
        { reasoningSteps: 0, commentaryNotes: 0, toolCalls: 0 },
        9_000,
      ),
    ).toBeUndefined();
  });

  it("floors elapsed at 1 second", () => {
    expect(
      formatTelegramProgressSummaryLine({ reasoningSteps: 0, commentaryNotes: 0, toolCalls: 1 }, 0),
    ).toBe("🛠️ 1 tool call · ⏱️ 1s");
  });

  it("rounds elapsed to the nearest second", () => {
    expect(
      formatTelegramProgressSummaryLine(
        { reasoningSteps: 0, commentaryNotes: 0, toolCalls: 1 },
        21_600,
      ),
    ).toBe("🛠️ 1 tool call · ⏱️ 22s");
  });
});

describe("createTelegramProgressSummaryTracker", () => {
  it("counts a window reasoning burst once when closed by a tool call", () => {
    const t = createTelegramProgressSummaryTracker();
    t.noteReasoningActivity();
    t.noteReasoningActivity(); // same burst, deltas
    t.noteToolCall();
    expect(t.counts()).toEqual({ reasoningSteps: 1, commentaryNotes: 0, toolCalls: 1 });
  });

  it("counts a trailing open burst at the summary flush (counts())", () => {
    const t = createTelegramProgressSummaryTracker();
    t.noteReasoningActivity();
    t.noteToolCall();
    t.noteReasoningActivity(); // trailing burst, no end event
    expect(t.counts()).toEqual({ reasoningSteps: 2, commentaryNotes: 0, toolCalls: 1 });
  });

  it("closes a burst on an explicit reasoning-end event", () => {
    const t = createTelegramProgressSummaryTracker();
    t.noteReasoningActivity();
    t.closeReasoningBurst();
    t.closeReasoningBurst(); // idempotent, no double count
    expect(t.counts()).toEqual({ reasoningSteps: 1, commentaryNotes: 0, toolCalls: 0 });
  });

  it("keeps one burst open across re-fires of the same note id", () => {
    const t = createTelegramProgressSummaryTracker();
    t.noteCommentary("a", "first");
    t.noteCommentary("a", "first (delta)");
    t.noteCommentary("b", "second");
    expect(t.counts()).toEqual({ reasoningSteps: 0, commentaryNotes: 2, toolCalls: 0 });
  });

  it("counts same-id commentary notes separated by tool boundaries as N, not 1 (D3)", () => {
    const t = createTelegramProgressSummaryTracker();
    // The anthropic core re-uses the turn-local id "commentary-0" for EVERY note
    // in a turn; a tool follows each note, so each note's burst closes at its tool
    // before the next opens. An id-Set dedup collapsed these to 1 — the D3 bug.
    t.noteCommentary("commentary-0", "about to run date");
    t.noteToolCall();
    t.noteCommentary("commentary-0", "about to list files");
    t.noteToolCall();
    t.noteCommentary("commentary-0", "about to run uptime");
    t.noteToolCall();
    expect(t.counts()).toEqual({ reasoningSteps: 0, commentaryNotes: 3, toolCalls: 3 });
  });

  it("a tool call closes an open commentary burst (counts it once)", () => {
    const t = createTelegramProgressSummaryTracker();
    t.noteCommentary("commentary-0", "narration");
    t.noteToolCall();
    expect(t.counts()).toEqual({ reasoningSteps: 0, commentaryNotes: 1, toolCalls: 1 });
  });

  it("dedupes id-less commentary by repeated text but counts new text", () => {
    const t = createTelegramProgressSummaryTracker();
    t.noteCommentary(undefined, "note");
    t.noteCommentary(undefined, "note");
    t.noteCommentary(undefined, "another");
    expect(t.counts()).toEqual({ reasoningSteps: 0, commentaryNotes: 2, toolCalls: 0 });
  });

  it("ignores empty/whitespace id-less commentary", () => {
    const t = createTelegramProgressSummaryTracker();
    t.noteCommentary(undefined, "   ");
    t.noteCommentary();
    expect(t.hasActivity()).toBe(false);
    expect(t.counts()).toEqual({ reasoningSteps: 0, commentaryNotes: 0, toolCalls: 0 });
  });

  it("hasActivity reflects an open burst before it is counted", () => {
    const t = createTelegramProgressSummaryTracker();
    expect(t.hasActivity()).toBe(false);
    t.noteReasoningActivity();
    expect(t.hasActivity()).toBe(true);
  });

  it("produces a faithful end-to-end deepseek-style summary (2 bursts closed by tools + trailing)", () => {
    const t = createTelegramProgressSummaryTracker();
    // burst 1 → tool → burst 2 → tool → trailing burst flushed at summary
    t.noteReasoningActivity();
    t.noteToolCall();
    t.noteReasoningActivity();
    t.noteToolCall();
    t.noteReasoningActivity();
    const line = formatTelegramProgressSummaryLine(t.counts(), 21_000);
    expect(line).toBe("🧠 3 thoughts · 🛠️ 2 tool calls · ⏱️ 21s");
  });
});
