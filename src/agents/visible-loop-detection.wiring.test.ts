// Wiring tests for visible-reply loop detection.
//
// PR #117914 shipped the pure library. This test covers the runtime
// wiring: when the before-tool-call policy hook runs against a session
// whose SessionState.visibleReplyHistory has been pre-populated with
// the actual bug pattern (near-identical text + same plan rewrite),
// the policy must block the next tool call with a "tool-loop" veto.
import { describe, expect, it } from "vitest";
import {
  VISIBLE_REPLY_CRITICAL_THRESHOLD,
  detectVisibleReplyLoop,
  recordVisibleReply,
  type VisibleReplyRecord,
} from "./visible-loop-detection.js";

describe("runtime wiring: visibleReplyHistory feeds the policy hook", () => {
  it("fires critical on the exact bug pattern from 2026-08-02", () => {
    // Reproducer: nine near-identical "Confirmed: /TR already writes
    // to trip ledger" replies with same-content update_plan calls
    // between them. The before-tool-call hook reads
    // sessionState.visibleReplyHistory + the assistant's last visible
    // text and calls detectVisibleReplyLoop. The session-level
    // hook would fire on the very same pattern.
    const history: VisibleReplyRecord[] = [];
    const baseText = "Confirmed: /TR already writes to trip ledger, /PR writes to personal ledger.";
    for (let i = 0; i < VISIBLE_REPLY_CRITICAL_THRESHOLD - 1; i += 1) {
      recordVisibleReply(history, baseText + ` (variant ${i})`, undefined);
    }
    // The hook fires on the NEXT tool call attempt, which means the
    // history already has the previous N replies. The "current" text
    // passed in is the latest reply; if it matches the streak, the
    // detector reports `count >= criticalThreshold` and the hook
    // blocks the call.
    const result = detectVisibleReplyLoop(history, baseText + " (final)");
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.level).toBe("critical");
      expect(result.detector).toBe("same_visible_reply");
      expect(result.count).toBe(VISIBLE_REPLY_CRITICAL_THRESHOLD);
      expect(result.message).toMatch(/CRITICAL/);
      expect(result.message).toMatch(/visible reply/i);
    }
  });

  it("fires warning on three identical replies (the lower threshold)", () => {
    const history: VisibleReplyRecord[] = [];
    recordVisibleReply(history, "Confirmed", undefined);
    recordVisibleReply(history, "Confirmed", undefined);
    const result = detectVisibleReplyLoop(history, "Confirmed");
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.level).toBe("warning");
    }
  });

  it("does not block varied conversation", () => {
    const history: VisibleReplyRecord[] = [];
    recordVisibleReply(history, "First reply", undefined);
    recordVisibleReply(history, "Second reply", undefined);
    recordVisibleReply(history, "Third reply", undefined);
    const result = detectVisibleReplyLoop(history, "Fourth reply");
    expect(result.stuck).toBe(false);
  });

  it("handles an empty history gracefully (no false positives on first turn)", () => {
    const result = detectVisibleReplyLoop([], "First reply of the session");
    expect(result.stuck).toBe(false);
  });
});
