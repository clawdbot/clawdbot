// Visible-reply loop detection tests.
//
// Covers the same patterns the existing tool-loop-detection tests cover
// but for the *visible text* and *plan payload* level: an agent can
// spiral in plain-text narration with intermittent `update_plan` calls
// that all rewrite the same plan, and the tool-level detector never
// fires because the tool calls themselves are varied.
import { describe, expect, it } from "vitest";
import {
  VISIBLE_REPLY_CRITICAL_THRESHOLD,
  VISIBLE_REPLY_WARNING_THRESHOLD,
  __test,
  detectVisibleReplyLoop,
  recordVisibleReply,
  type VisibleReplyRecord,
} from "./visible-loop-detection.js";

const { hashText, hashPlan, nearIdenticalRatio } = __test;

function makeHistory(
  entries: Array<{ text: string; plan?: Array<{ step: string; status: string }> }>,
): VisibleReplyRecord[] {
  return entries.map((e) => ({
    textHash: hashText(e.text),
    text: e.text,
    planHash: e.plan ? hashPlan(e.plan) : undefined,
    timestamp: Date.now(),
  }));
}

describe("detectVisibleReplyLoop", () => {
  it("returns stuck:false on empty history", () => {
    const result = detectVisibleReplyLoop([], "hello", undefined);
    expect(result.stuck).toBe(false);
  });

  it("returns stuck:false on varied visible replies", () => {
    const history = makeHistory([
      { text: "first reply" },
      { text: "second reply" },
      { text: "third reply" },
    ]);
    const result = detectVisibleReplyLoop(history, "fourth reply", undefined);
    expect(result.stuck).toBe(false);
  });

  it("fires warning when the same visible reply repeats >= warningThreshold times", () => {
    // The streak count includes the current turn, so warningThreshold (3)
    // requires 2 history entries + the current turn = 3 identical.
    const history = makeHistory([
      { text: "Confirmed: /TR writes to trip ledger" },
      { text: "Confirmed: /TR writes to trip ledger" },
    ]);
    const result = detectVisibleReplyLoop(
      history,
      "Confirmed: /TR writes to trip ledger",
      undefined,
    );
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.level).toBe("warning");
      expect(result.detector).toBe("same_visible_reply");
      expect(result.count).toBe(VISIBLE_REPLY_WARNING_THRESHOLD);
      expect(result.message).toMatch(/same visible reply/i);
    }
  });

  it("fires critical when the same visible reply repeats >= criticalThreshold times", () => {
    // The streak count includes the current turn, so criticalThreshold (5)
    // requires 4 history entries + the current turn = 5 identical.
    const history = makeHistory([
      { text: "Confirmed" },
      { text: "Confirmed" },
      { text: "Confirmed" },
      { text: "Confirmed" },
    ]);
    const result = detectVisibleReplyLoop(history, "Confirmed", undefined);
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.level).toBe("critical");
      expect(result.count).toBe(VISIBLE_REPLY_CRITICAL_THRESHOLD);
    }
  });

  it("fires warning on near-identical replies (the actual bug pattern)", () => {
    // The exact pattern Bhushan reported: I emitted
    //   "Confirmed: /TR already writes to trip ledger, /PR writes to personal ledger"
    // nine times in a row with minor edits to surrounding text. The
    // detector should catch this via the near-identical ratio check.
    const base =
      "Confirmed: /TR already writes to trip ledger, /PR writes to personal ledger. No rebuild needed.";
    const variants = [
      base,
      base + " The split is already correct.",
      base + " What's still missing is the weekly report.",
    ].map((text) => ({ text }));
    const history = makeHistory(variants);
    const result = detectVisibleReplyLoop(history, base + " Going.", undefined);
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.detector).toBe("same_visible_reply");
    }
  });

  it("fires warning when the same plan payload rewrites >= warningThreshold times", () => {
    const plan = [{ step: "step A", status: "in_progress" }];
    // 2 history entries + current turn = 3 identical plan rewrites, which
    // hits the warningThreshold of 3 (same-text semantics).
    const history = makeHistory([
      { text: "x", plan },
      { text: "y", plan },
    ]);
    const result = detectVisibleReplyLoop(history, "z", plan);
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.detector).toBe("same_plan_rewrite");
      expect(result.level).toBe("warning");
    }
  });

  it("fires critical when the same plan payload rewrites >= criticalThreshold times", () => {
    const plan = [{ step: "step A", status: "in_progress" }];
    const history = makeHistory([
      { text: "x", plan },
      { text: "y", plan },
      { text: "z", plan },
      { text: "w", plan },
    ]);
    const result = detectVisibleReplyLoop(history, "v", plan);
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.detector).toBe("same_plan_rewrite");
      expect(result.level).toBe("critical");
    }
  });

  it("does not fire when plan changes between turns", () => {
    const history = makeHistory([
      { text: "x", plan: [{ step: "step A", status: "completed" }] },
      {
        text: "y",
        plan: [
          { step: "step A", status: "completed" },
          { step: "step B", status: "in_progress" },
        ],
      },
    ]);
    const result = detectVisibleReplyLoop(history, "z", [{ step: "step B", status: "completed" }]);
    expect(result.stuck).toBe(false);
  });

  it("ignores empty visible text and only-empty plans", () => {
    const history = makeHistory([{ text: "" }, { text: "" }, { text: "" }]);
    const result = detectVisibleReplyLoop(history, "", []);
    expect(result.stuck).toBe(false);
  });

  it("respects custom thresholds", () => {
    const history = makeHistory([{ text: "same" }, { text: "same" }]);
    // 2 history + current = 3 identical, which is the default warning
    // threshold. With custom warning=10, this should NOT fire.
    const result = detectVisibleReplyLoop(history, "same", undefined, {
      enabled: true,
      warningThreshold: 10,
      criticalThreshold: 20,
    });
    expect(result.stuck).toBe(false);
  });

  it("is disabled when config.enabled is false", () => {
    const history = makeHistory([
      { text: "same" },
      { text: "same" },
      { text: "same" },
      { text: "same" },
      { text: "same" },
    ]);
    const result = detectVisibleReplyLoop(history, "same", undefined, { enabled: false });
    expect(result.stuck).toBe(false);
  });
});

describe("recordVisibleReply", () => {
  it("appends and trims to historySize", () => {
    const history: VisibleReplyRecord[] = [];
    for (let i = 0; i < 12; i += 1) {
      recordVisibleReply(history, `reply ${i}`, undefined, 8);
    }
    expect(history.length).toBe(8);
    expect(history[0]?.text).toBe("reply 4");
    expect(history[7]?.text).toBe("reply 11");
  });

  it("hashes the plan when supplied", () => {
    const history: VisibleReplyRecord[] = [];
    recordVisibleReply(history, "hi", [{ step: "x", status: "pending" }], 8);
    expect(history[0]?.planHash).toBe(hashPlan([{ step: "x", status: "pending" }]));
  });

  it("leaves planHash undefined when plan is empty", () => {
    const history: VisibleReplyRecord[] = [];
    recordVisibleReply(history, "hi", [], 8);
    expect(history[0]?.planHash).toBeUndefined();
  });
});

describe("nearIdenticalRatio", () => {
  it("returns ~1 for identical strings", () => {
    expect(nearIdenticalRatio("hello world", "hello world")).toBeGreaterThan(0.95);
  });

  it("returns high for the bug pattern with minor edits", () => {
    const a = "Confirmed: /TR already writes to trip ledger, /PR writes to personal ledger.";
    const b =
      "Confirmed: /TR already writes to trip ledger, /PR writes to personal ledger. The split is already correct.";
    expect(nearIdenticalRatio(a, b)).toBeGreaterThan(0.85);
  });

  it("returns low for unrelated strings", () => {
    expect(nearIdenticalRatio("hello world", "completely different text here")).toBeLessThan(0.5);
  });

  it("returns 0 for empty inputs", () => {
    expect(nearIdenticalRatio("", "hello")).toBe(0);
    expect(nearIdenticalRatio("hello", "")).toBe(0);
  });
});
