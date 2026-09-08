// Browser tests cover agent.act.normalize plugin behavior.
import { describe, expect, it } from "vitest";
import { ACT_MAX_BATCH_DEPTH } from "../act-policy.js";
import { canonicalizeActTargetIds, normalizeActRequest } from "./agent.act.normalize.js";

const MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647;

describe("canonicalizeActTargetIds", () => {
  const canonical = "abcd1234";
  const tab = { targetId: canonical, suggestedTargetId: "sg-1", tabId: "tab-7", label: "Inbox" };

  it("rewrites every same-tab alias to the canonical targetId before dispatch", () => {
    for (const alias of ["abcd", "tab-7", "Inbox", "sg-1", canonical]) {
      const action = { kind: "click", ref: "1", targetId: alias } as const;
      expect(canonicalizeActTargetIds(action, tab)).toBeNull();
      expect(action.targetId).toBe(canonical);
    }
  });

  it("canonicalizes batch sub-action aliases recursively", () => {
    const action = {
      kind: "batch",
      targetId: "abcd",
      actions: [
        { kind: "click", ref: "1", targetId: "tab-7" },
        { kind: "batch", actions: [{ kind: "resize", width: 2, height: 2, targetId: "Inbox" }] },
      ],
    } satisfies Parameters<typeof canonicalizeActTargetIds>[0];
    expect(canonicalizeActTargetIds(action, tab, [tab])).toBeNull();
    expect(action.targetId).toBe(canonical);
    const [first, nested] = action.actions;
    expect(first?.targetId).toBe(canonical);
    if (nested?.kind !== "batch") {
      throw new Error("expected nested batch");
    }
    expect(nested.actions[0]?.targetId).toBe(canonical);
  });

  it("leaves an absent targetId unset so dispatch falls back to the request tab", () => {
    const action: Parameters<typeof canonicalizeActTargetIds>[0] = { kind: "click", ref: "1" };
    expect(canonicalizeActTargetIds(action, tab)).toBeNull();
    expect(action.targetId).toBeUndefined();
  });

  it("rejects ids that resolve to a different tab", () => {
    expect(canonicalizeActTargetIds({ kind: "click", ref: "1", targetId: "zzzz9999" }, tab)).toBe(
      "action targetId must match request targetId",
    );
    expect(
      canonicalizeActTargetIds(
        { kind: "batch", actions: [{ kind: "click", ref: "1", targetId: "zzzz9999" }] },
        tab,
      ),
    ).toBe("batched action targetId must match request targetId");
  });

  it("rejects a batched targetId prefix that is ambiguous across tabs", () => {
    expect(
      canonicalizeActTargetIds(
        { kind: "batch", actions: [{ kind: "click", ref: "1", targetId: "abcd" }] },
        tab,
        [tab, { targetId: "abcd9999" }],
      ),
    ).toBe("batched action targetId must match request targetId");
  });
});

describe("normalizeActRequest keyboard keys", () => {
  it.each([
    ["Esc", "Escape"],
    ["ESC", "Escape"],
    ["Return", "Enter"],
    ["Del", "Delete"],
    ["Ctrl+a", "Control+a"],
    ["Cmd+A", "Meta+A"],
    ["Ctrl+Shift+Esc", "Control+Shift+Escape"],
    ["Ctrl++", "Control++"],
  ])("normalizes the keyboard alias %s", (key, expected) => {
    expect(normalizeActRequest({ kind: "press", key })).toMatchObject({ key: expected });
  });

  it.each(["a", "A", "+", "Control++", "ControlOrMeta+a", "__proto__", "constructor"])(
    "preserves the existing keyboard contract for %s",
    (key) => {
      expect(normalizeActRequest({ kind: "press", key })).toMatchObject({ key });
    },
  );

  it("normalizes keyboard aliases inside nested batch actions", () => {
    expect(
      normalizeActRequest({
        kind: "batch",
        actions: [{ kind: "batch", actions: [{ kind: "press", key: "Ctrl+Esc" }] }],
      }),
    ).toMatchObject({
      kind: "batch",
      actions: [{ kind: "batch", actions: [{ kind: "press", key: "Control+Escape" }] }],
    });
  });
});

describe("normalizeActRequest numeric fields", () => {
  it("keeps structured numeric action options", () => {
    expect(
      normalizeActRequest({
        kind: "click",
        ref: "button-1",
        delayMs: 25,
        timeoutMs: 5000,
      }),
    ).toMatchObject({
      kind: "click",
      ref: "button-1",
      delayMs: 25,
      timeoutMs: 5000,
    });
  });

  it("parses decimal integer strings for action options", () => {
    expect(
      normalizeActRequest({
        kind: "wait",
        timeMs: "25",
        timeoutMs: "5000",
      }),
    ).toMatchObject({
      kind: "wait",
      timeMs: 25,
      timeoutMs: 5000,
    });
  });

  it("caps oversized action timeouts", () => {
    expect(
      normalizeActRequest({
        kind: "wait",
        text: "ready",
        timeoutMs: String(Number.MAX_SAFE_INTEGER),
      }),
    ).toMatchObject({
      kind: "wait",
      text: "ready",
      timeoutMs: MAX_SAFE_TIMEOUT_DELAY_MS,
    });
  });

  it("rejects loose integer tokens for action durations and timeouts", () => {
    expect(() =>
      normalizeActRequest({
        kind: "click",
        ref: "button-1",
        delayMs: "0x10",
      }),
    ).toThrow("delayMs must be a non-negative integer.");

    expect(() =>
      normalizeActRequest({
        kind: "wait",
        timeMs: "1e3",
      }),
    ).toThrow("timeMs must be a non-negative integer.");

    expect(() =>
      normalizeActRequest({
        kind: "hover",
        ref: "button-1",
        timeoutMs: "1000ms",
      }),
    ).toThrow("timeoutMs must be a positive integer.");
  });

  it("rejects fractional viewport dimensions before dispatch", () => {
    expect(() =>
      normalizeActRequest({
        kind: "resize",
        width: "800.5",
        height: 600,
      }),
    ).toThrow("resize requires positive width and height");
  });
});

describe("normalizeActRequest fill fields", () => {
  it("validates fill fields inside batch sub-actions", () => {
    expect(() =>
      normalizeActRequest({
        kind: "batch",
        actions: [{ kind: "fill", fields: [{ ref: "e1", value: "Neo", text: "unsupported" }] }],
      }),
    ).toThrow('fields[0] unsupported field key "text"');
  });
});

describe("normalizeActRequest batch nesting depth", () => {
  const buildNestedBatch = (depth: number): Record<string, unknown> => {
    let action: Record<string, unknown> = { kind: "click", ref: "1" };
    for (let i = 0; i < depth; i += 1) {
      action = { kind: "batch", actions: [action] };
    }
    return action;
  };

  it("normalizes batches nested up to the executor depth limit", () => {
    const normalized = normalizeActRequest(buildNestedBatch(ACT_MAX_BATCH_DEPTH + 1));
    expect(normalized).toMatchObject({ kind: "batch" });
  });

  it("rejects nesting past the depth limit with a clear error instead of overflowing the stack", () => {
    // A ~1MB JSON body fits tens of thousands of levels; without a depth bound the
    // recursive normalization throws RangeError before the action-count check runs.
    for (const depth of [ACT_MAX_BATCH_DEPTH + 2, 30_000]) {
      expect(() => normalizeActRequest(buildNestedBatch(depth))).toThrow(
        `batch nesting exceeds maximum depth of ${ACT_MAX_BATCH_DEPTH}`,
      );
    }
  });
});
