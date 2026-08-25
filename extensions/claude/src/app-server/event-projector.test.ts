import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  ClaudeAppServerEventProjector,
  extractItemName,
  isToolItem,
  type ProjectorAccumulator,
} from "./event-projector.js";
import type { RpcNotification } from "./types.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const TURN_ID = "turn_test_001";

function emptyAcc(): ProjectorAccumulator {
  return {
    assistantTexts: [],
    toolMetas: [],
    reasoning: "",
    itemCount: 0,
    toolCalls: new Map(),
  };
}

function makeParams(
  onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void,
  reasoningCallbacks?: {
    onReasoningStream?: (payload: { text: string; isReasoningSnapshot?: boolean }) => void;
    onReasoningEnd?: () => void;
  },
): EmbeddedRunAttemptParams {
  return {
    runId: "run_test",
    onAgentEvent,
    ...reasoningCallbacks,
  } as unknown as EmbeddedRunAttemptParams;
}

function makeProjector(acc: ProjectorAccumulator): ClaudeAppServerEventProjector {
  return new ClaudeAppServerEventProjector(TURN_ID, acc, makeParams(), {
    runId: "run_test",
    agentId: "tank",
    sessionId: "s_1",
    sessionKey: "agent:tank:test",
    channelId: "discord",
  });
}

function makeProjectorWithCapture(acc: ProjectorAccumulator): {
  projector: ClaudeAppServerEventProjector;
  events: Array<{ stream: string; data: Record<string, unknown> }>;
} {
  const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const params = makeParams((event) => {
    events.push(event);
  });
  const projector = new ClaudeAppServerEventProjector(TURN_ID, acc, params, {
    runId: "run_test",
    agentId: "tank",
    sessionId: "s_1",
    sessionKey: "agent:tank:test",
    channelId: "discord",
  });
  return { projector, events };
}

function notif(method: string, params: Record<string, unknown>): RpcNotification {
  return { jsonrpc: "2.0", method, params } as RpcNotification;
}

// ── pure helpers ────────────────────────────────────────────────────────────

describe("isToolItem", () => {
  it.each(["dynamicToolCall", "toolCall", "mcpToolCall"])("recognizes %s", (type) => {
    expect(isToolItem({ type })).toBe(true);
  });

  it.each(["agentMessage", "plan", "file", "shell", "reasoning", ""])("rejects %s", (type) => {
    expect(isToolItem({ type })).toBe(false);
  });

  it("rejects items without a type field", () => {
    expect(isToolItem({})).toBe(false);
  });
});

describe("extractItemName", () => {
  it("prefers name over tool", () => {
    expect(extractItemName({ name: "primary", tool: "secondary" })).toBe("primary");
  });
  it("falls back to tool when name missing", () => {
    expect(extractItemName({ tool: "secondary" })).toBe("secondary");
  });
  it("returns undefined when both missing", () => {
    expect(extractItemName({ type: "agentMessage" })).toBeUndefined();
  });
});

// ── matchesTurn ─────────────────────────────────────────────────────────────

describe("matchesTurn", () => {
  it("matches by params.turnId", () => {
    const projector = makeProjector(emptyAcc());
    expect(projector.matchesTurn(notif("turn/completed", { turnId: TURN_ID }))).toBe(true);
  });

  it("matches by params.turn.id (nested)", () => {
    const projector = makeProjector(emptyAcc());
    expect(projector.matchesTurn(notif("turn/completed", { turn: { id: TURN_ID } }))).toBe(true);
  });

  it("rejects notifications for a different turn", () => {
    const projector = makeProjector(emptyAcc());
    expect(projector.matchesTurn(notif("turn/completed", { turnId: "other" }))).toBe(false);
  });

  it("rejects notifications without any turn identity", () => {
    const projector = makeProjector(emptyAcc());
    expect(projector.matchesTurn(notif("item/started", { item: {} }))).toBe(false);
  });
});

// ── processNotification: terminal outcomes ──────────────────────────────────

describe("processNotification (terminal)", () => {
  it("emits a completed outcome on turn/completed for the current turn", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    const outcome = projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed", items: [] },
      }),
    );
    expect(outcome).not.toBeNull();
    expect(outcome?.kind).toBe("completed");
    // C3: a normally-completed turn maps to a "stop" stop reason.
    expect(acc.stopReason).toBe("stop");
  });

  it("captures an 'aborted' stop reason on turn/completed with status=interrupted (C3)", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    const outcome = projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "interrupted", items: [] },
      }),
    );
    expect(outcome?.kind).toBe("completed");
    expect(acc.stopReason).toBe("aborted");
  });

  it("emits a failed outcome on turn/completed with status=failed", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    const outcome = projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "failed", error: { message: "boom" } },
      }),
    );
    expect(outcome?.kind).toBe("failed");
    if (outcome?.kind === "failed") {
      expect(outcome.error.message).toContain("boom");
    }
    // C3: a failed turn maps to an "error" stop reason.
    expect(acc.stopReason).toBe("error");
  });

  it("emits a failed outcome on turn/error", () => {
    const projector = makeProjector(emptyAcc());
    const outcome = projector.processNotification(
      notif("turn/error", { turnId: TURN_ID, error: { message: "timeout" } }),
    );
    expect(outcome?.kind).toBe("failed");
    if (outcome?.kind === "failed") {
      expect(outcome.error.message).toContain("timeout");
    }
  });

  it("returns null for notifications belonging to another turn", () => {
    const projector = makeProjector(emptyAcc());
    expect(
      projector.processNotification(notif("turn/completed", { turnId: "other-turn" })),
    ).toBeNull();
  });

  it("does not double-settle after a terminal notification", () => {
    const projector = makeProjector(emptyAcc());
    const first = projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed" },
      }),
    );
    expect(first?.kind).toBe("completed");
    const second = projector.processNotification(
      notif("turn/error", { turnId: TURN_ID, error: { message: "after-settle" } }),
    );
    expect(second).toBeNull();
  });

  it("respects external markSettled (e.g. idle-timeout path)", () => {
    const projector = makeProjector(emptyAcc());
    projector.markSettled();
    const outcome = projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed" },
      }),
    );
    expect(outcome).toBeNull();
  });
});

// ── processNotification: accumulator mutation ───────────────────────────────

describe("processNotification (accumulator)", () => {
  it("records tool start events into toolMetas + toolCalls", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: {
          type: "dynamicToolCall",
          id: "call_1",
          name: "image",
          arguments: { url: "https://example.com" },
        },
      }),
    );
    expect(acc.toolMetas).toEqual([{ toolName: "image" }]);
    expect(acc.toolCalls.get("call_1")?.name).toBe("image");
    expect(acc.toolCalls.get("call_1")?.isDynamic).toBe(true);
  });

  it("pairs tool completion onto the prior start record", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "call_a", name: "Read", arguments: { path: "x" } },
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: {
          type: "toolCall",
          id: "call_a",
          name: "Read",
          result: "file contents",
          status: "completed",
        },
      }),
    );
    const call = acc.toolCalls.get("call_a");
    expect(call?.result).toBe("file contents");
    expect(call?.isError).toBe(false);
    expect(acc.itemCount).toBe(1);
  });

  it("preserves contentItems payload on dynamic-tool completion", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "dynamicToolCall", id: "dyn_1", name: "vestige_search" },
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: {
          type: "dynamicToolCall",
          id: "dyn_1",
          name: "vestige_search",
          contentItems: [{ type: "inputText", text: "hits..." }],
          status: "completed",
        },
      }),
    );
    expect(acc.toolCalls.get("dyn_1")?.result).toEqual([{ type: "inputText", text: "hits..." }]);
  });

  it("flags errored tool completions via isError", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "fail_1", name: "Bash" },
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "fail_1", name: "Bash", status: "failed" },
      }),
    );
    expect(acc.toolCalls.get("fail_1")?.isError).toBe(true);
  });

  it("ignores items missing the item field entirely", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(notif("item/started", { turnId: TURN_ID }));
    expect(acc.toolMetas).toEqual([]);
    expect(acc.itemCount).toBe(0);
  });
});

// ── finalize: deltas folded into accumulator ────────────────────────────────

describe("finalize", () => {
  it("folds streamed text deltas into acc.assistantTexts when no item/completed arrives", () => {
    // Abnormal-settle salvage path: deltas arrive but the turn doesn't
    // formally complete (e.g. idle timeout). finalize() should still
    // recover the streamed text from textPartsByItemId.
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/agentMessage/delta", { turnId: TURN_ID, itemId: "msg_1", delta: "hello " }),
    );
    projector.processNotification(
      notif("item/agentMessage/delta", { turnId: TURN_ID, itemId: "msg_1", delta: "world" }),
    );
    projector.finalize();
    expect(acc.assistantTexts).toEqual(["hello world"]);
  });

  it("folds streamed reasoning deltas into acc.reasoning", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/reasoning/delta", { turnId: TURN_ID, delta: "thinking " }),
    );
    projector.processNotification(
      notif("item/reasoning/delta", { turnId: TURN_ID, delta: "step 2" }),
    );
    projector.finalize();
    expect(acc.reasoning).toBe("thinking step 2");
  });

  it("picks up agentMessage text from turn/completed when no deltas streamed", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [{ type: "agentMessage", text: "non-streaming reply" }],
        },
      }),
    );
    projector.finalize();
    expect(acc.assistantTexts).toEqual(["non-streaming reply"]);
  });

  it("is a no-op when no deltas streamed and no terminal text appeared", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.finalize();
    expect(acc.assistantTexts).toEqual([]);
    expect(acc.reasoning).toBe("");
  });
});

// ── onReasoningStream / onReasoningEnd (openclaw-q7i) ───────────────────────
//
// Regression coverage: the projector captured reasoning deltas into
// acc.reasoning for diagnostics but never called the onReasoningStream/
// onReasoningEnd callback pair that Discord/Slack/Telegram/etc. actually
// listen on for live rendering (codex's event-projector-reasoning.ts wires
// the same pair; the generic emitAgentEvent({stream: "reasoning"}) call has
// no confirmed consumer on the channel-delivery path). These pin that both
// callbacks fire with the contract codex established.
describe("onReasoningStream / onReasoningEnd", () => {
  it("streams each reasoning delta as an accumulated snapshot", () => {
    const acc = emptyAcc();
    const streamed: Array<{ text: string; isReasoningSnapshot?: boolean }> = [];
    const params = makeParams(undefined, { onReasoningStream: (p) => streamed.push(p) });
    const projector = new ClaudeAppServerEventProjector(TURN_ID, acc, params, {
      runId: "run_test",
      agentId: "tank",
      sessionId: "s_1",
      sessionKey: "agent:tank:test",
      channelId: "discord",
    });
    projector.processNotification(
      notif("item/reasoning/delta", { turnId: TURN_ID, delta: "thinking " }),
    );
    projector.processNotification(
      notif("item/reasoning/delta", { turnId: TURN_ID, delta: "step 2" }),
    );
    expect(streamed).toEqual([
      { text: "thinking ", isReasoningSnapshot: true },
      { text: "thinking step 2", isReasoningSnapshot: true },
    ]);
  });

  it("fires onReasoningEnd exactly once at turn/completed when reasoning streamed", () => {
    const acc = emptyAcc();
    let endCalls = 0;
    const params = makeParams(undefined, { onReasoningEnd: () => (endCalls += 1) });
    const projector = new ClaudeAppServerEventProjector(TURN_ID, acc, params, {
      runId: "run_test",
      agentId: "tank",
      sessionId: "s_1",
      sessionKey: "agent:tank:test",
      channelId: "discord",
    });
    projector.processNotification(
      notif("item/reasoning/delta", { turnId: TURN_ID, delta: "thinking" }),
    );
    projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed", items: [] },
      }),
    );
    expect(endCalls).toBe(1);
  });

  it("does not fire onReasoningEnd on a turn with no reasoning", () => {
    const acc = emptyAcc();
    let endCalls = 0;
    const params = makeParams(undefined, { onReasoningEnd: () => (endCalls += 1) });
    const projector = new ClaudeAppServerEventProjector(TURN_ID, acc, params, {
      runId: "run_test",
      agentId: "tank",
      sessionId: "s_1",
      sessionKey: "agent:tank:test",
      channelId: "discord",
    });
    projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed", items: [] },
      }),
    );
    expect(endCalls).toBe(0);
  });
});

// ── token usage (thread/tokenUsage/updated → acc.usage) ─────────────────────
//
// Regression coverage for openclaw-rw4: the app-server runtime never captured
// thread/tokenUsage/updated, so acc.usage stayed undefined, result.attemptUsage
// was never set, and /status reported 0/200k. These pin that the projector
// folds the latest token-usage notification into acc.usage at finalize().

describe("token usage", () => {
  it("captures camelCase tokenUsage.last and exposes it via finalize() → acc.usage", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("thread/tokenUsage/updated", {
        turnId: TURN_ID,
        tokenUsage: {
          last: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 300 },
        },
      }),
    );
    projector.finalize();
    // input is reported as the uncached remainder (1000 - 300 cache reads).
    expect(acc.usage).toEqual({ input: 700, output: 200, cacheRead: 300 });
  });

  it("normalizes snake_case aliases at the top level of the payload", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("thread/tokenUsage/updated", {
        turnId: TURN_ID,
        last: {
          input_tokens: 500,
          output_tokens: 80,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 40,
        },
      }),
    );
    projector.finalize();
    expect(acc.usage).toEqual({ input: 400, output: 80, cacheRead: 100, cacheWrite: 40 });
  });

  it("keeps the latest token-usage update when several arrive in a turn", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("thread/tokenUsage/updated", {
        turnId: TURN_ID,
        tokenUsage: { last: { inputTokens: 100, outputTokens: 10 } },
      }),
    );
    projector.processNotification(
      notif("thread/tokenUsage/updated", {
        turnId: TURN_ID,
        tokenUsage: { last: { inputTokens: 2500, outputTokens: 400 } },
      }),
    );
    projector.finalize();
    expect(acc.usage).toEqual({ input: 2500, output: 400 });
  });

  it("leaves acc.usage undefined when no token-usage notification arrives", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/agentMessage/delta", { turnId: TURN_ID, itemId: "m", delta: "hi" }),
    );
    projector.finalize();
    expect(acc.usage).toBeUndefined();
  });

  it("ignores a token-usage payload with no recognizable current-usage record", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("thread/tokenUsage/updated", { turnId: TURN_ID, tokenUsage: { cumulative: 42 } }),
    );
    projector.finalize();
    expect(acc.usage).toBeUndefined();
  });
});

// ── commentary-vs-final split ───────────────────────────────────────────────

describe("commentary vs final agentMessage split", () => {
  it("emits intermediate agentMessages as preamble and reserves the last for lastAssistant", () => {
    const acc = emptyAcc();
    const { projector, events } = makeProjectorWithCapture(acc);

    // 1. Intermediate prose: "Let me check..."
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "msg_1" },
      }),
    );
    projector.processNotification(
      notif("item/agentMessage/delta", {
        turnId: TURN_ID,
        itemId: "msg_1",
        delta: "Let me check.",
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "msg_1", text: "Let me check." },
      }),
    );

    // 2. Tool runs — this confirms msg_1 was intermediate, so it flushes
    //    as a preamble before tool start is emitted.
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "call_1", name: "Bash", arguments: { cmd: "ls" } },
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "call_1", name: "Bash", status: "completed" },
      }),
    );

    // 3. Final answer
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "msg_2" },
      }),
    );
    projector.processNotification(
      notif("item/agentMessage/delta", {
        turnId: TURN_ID,
        itemId: "msg_2",
        delta: "The answer is foo.",
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "msg_2", text: "The answer is foo." },
      }),
    );

    // 4. Turn completes — msg_2 is the final, no preamble for it.
    projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [
            { type: "agentMessage", id: "msg_1", text: "Let me check." },
            { type: "toolCall", id: "call_1", name: "Bash" },
            { type: "agentMessage", id: "msg_2", text: "The answer is foo." },
          ],
        },
      }),
    );
    projector.finalize();

    const preambleEvents = events.filter((e) => e.stream === "item" && e.data.kind === "preamble");
    expect(preambleEvents).toHaveLength(1);
    expect(preambleEvents[0]?.data.progressText).toBe("Let me check.");
    expect(preambleEvents[0]?.data.itemId).toBe("msg_1");

    // Final goes to assistantTexts/lastAssistant ONLY, never as preamble.
    expect(acc.assistantTexts).toEqual(["The answer is foo."]);
  });

  it("emits no preamble when the turn contains a single (final) agentMessage", () => {
    const acc = emptyAcc();
    const { projector, events } = makeProjectorWithCapture(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "msg_only" },
      }),
    );
    projector.processNotification(
      notif("item/agentMessage/delta", { turnId: TURN_ID, itemId: "msg_only", delta: "hi" }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "msg_only", text: "hi" },
      }),
    );
    projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed", items: [] },
      }),
    );
    projector.finalize();

    expect(events.filter((e) => e.stream === "item" && e.data.kind === "preamble")).toHaveLength(0);
    expect(acc.assistantTexts).toEqual(["hi"]);
  });

  it("flushes the held agentMessage when a second agentMessage starts (back-to-back commentary)", () => {
    const acc = emptyAcc();
    const { projector, events } = makeProjectorWithCapture(acc);
    projector.processNotification(
      notif("item/started", { turnId: TURN_ID, item: { type: "agentMessage", id: "a" } }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "a", text: "First note." },
      }),
    );
    projector.processNotification(
      notif("item/started", { turnId: TURN_ID, item: { type: "agentMessage", id: "b" } }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "b", text: "Final answer." },
      }),
    );
    projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed", items: [] },
      }),
    );
    projector.finalize();

    const preambles = events.filter((e) => e.stream === "item" && e.data.kind === "preamble");
    expect(preambles).toHaveLength(1);
    expect(preambles[0]?.data.progressText).toBe("First note.");
    expect(acc.assistantTexts).toEqual(["Final answer."]);
  });

  it("skips agentMessages already emitted as preambles when falling back to turn.items", () => {
    // Edge case the server's phase tagging exists to disambiguate, but
    // the projector also guards locally: a turn ending with intermediate
    // prose + tool and no follow-up reply. The positional fallback used
    // to pick "Let me check." from turn.items and re-deliver it as the
    // final reply, duplicating what the user already saw as a preamble.
    // With emittedPreambleItemIds tracking, the fallback now skips ids
    // we've already surfaced as preambles.
    const acc = emptyAcc();
    const { projector, events } = makeProjectorWithCapture(acc);

    projector.processNotification(
      notif("item/started", { turnId: TURN_ID, item: { type: "agentMessage", id: "msg_1" } }),
    );
    projector.processNotification(
      notif("item/agentMessage/delta", {
        turnId: TURN_ID,
        itemId: "msg_1",
        delta: "Let me check.",
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "msg_1", text: "Let me check." },
      }),
    );
    // Tool runs — flushes msg_1 as preamble.
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "call_1", name: "Bash" },
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "call_1", name: "Bash", status: "completed" },
      }),
    );
    // No follow-up agentMessage. Turn completes with msg_1 in items.
    projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [
            { type: "agentMessage", id: "msg_1", text: "Let me check." },
            { type: "toolCall", id: "call_1", name: "Bash" },
          ],
        },
      }),
    );
    projector.finalize();

    const preambles = events.filter((e) => e.stream === "item" && e.data.kind === "preamble");
    expect(preambles).toHaveLength(1);
    expect(preambles[0]?.data.progressText).toBe("Let me check.");
    // Critical: lastAssistant must be empty — we already surfaced this
    // text as a preamble, so re-delivering it as the final reply would
    // duplicate it in the channel.
    expect(acc.assistantTexts).toEqual([]);
  });

  it("prefers a server-tagged final_answer item over positional fallback", () => {
    // claude bridge >= 0.2.7 emits item/updated with phase: "final_answer"
    // for the trailing agentMessage of an end_turn assistant message.
    // When the projector's pendingAgentMessage path can't fire (e.g.
    // because event loss left textParts empty), the turn/completed
    // fallback should prefer the server-tagged item over the
    // positional last-agentMessage.
    const acc = emptyAcc();
    const { projector } = makeProjectorWithCapture(acc);

    // Two agentMessage blocks; the second was server-tagged final via
    // item/updated. Simulate item/completed for both but DON'T leave
    // either in pendingAgentMessage at turn/completed (by having a
    // trailing item/started after msg_2 that "would have" flushed it).
    projector.processNotification(
      notif("item/started", { turnId: TURN_ID, item: { type: "agentMessage", id: "msg_1" } }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "msg_1", text: "Let me check.", phase: "commentary" },
      }),
    );
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "call_1", name: "Bash" },
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "call_1", name: "Bash", status: "completed" },
      }),
    );
    projector.processNotification(
      notif("item/started", { turnId: TURN_ID, item: { type: "agentMessage", id: "msg_2" } }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: {
          type: "agentMessage",
          id: "msg_2",
          text: "The answer is foo.",
          phase: "commentary",
        },
      }),
    );
    // Server emits item/updated retagging msg_2 as final.
    projector.processNotification(
      notif("item/updated", {
        turnId: TURN_ID,
        item: {
          type: "agentMessage",
          id: "msg_2",
          text: "The answer is foo.",
          phase: "final_answer",
        },
      }),
    );
    // Simulate the pendingAgentMessage path missing (event ordering
    // anomaly): a stray item/started arrives flushing msg_2 as preamble.
    projector.processNotification(
      notif("item/started", { turnId: TURN_ID, item: { type: "reasoning", id: "thought_1" } }),
    );
    // Now turn.items snapshot includes both messages, both with phase
    // tags as the server emitted them.
    projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [
            { type: "agentMessage", id: "msg_1", text: "Let me check.", phase: "commentary" },
            { type: "toolCall", id: "call_1", name: "Bash" },
            {
              type: "agentMessage",
              id: "msg_2",
              text: "The answer is foo.",
              phase: "final_answer",
            },
          ],
        },
      }),
    );
    projector.finalize();

    // msg_2 must win — server tagged it final. msg_1 was already
    // emitted as preamble and is now in emittedPreambleItemIds.
    expect(acc.assistantTexts).toEqual(["The answer is foo."]);
  });
});

describe("bridge-owned tool calls (MCP-routed OpenClaw tools)", () => {
  it("treats an mcp__openclaw__* mcpToolCall as bridge-owned, not native", () => {
    // The regression. The bridge serves OpenClaw tools as an in-process MCP
    // server, so the CLI reports them as ordinary mcpToolCall items rather than
    // dynamicToolCall. Before the fix isDynamic was false here, so
    // recordToolCompletion's "native tools only" guard let AfterToolCall fire a
    // second time for a call dynamic-tools.ts had already reported.
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: {
          type: "mcpToolCall",
          id: "call_mcp_1",
          name: "mcp__openclaw__message",
          arguments: { action: "send" },
        },
      }),
    );
    expect(acc.toolCalls.get("call_mcp_1")?.isDynamic).toBe(true);
  });

  it("still treats a genuine native toolCall as native", () => {
    // Guards the fix against over-broadening: native tools must keep firing
    // AfterToolCall here, since nothing else fires it for them.
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "call_native", name: "Read", arguments: { path: "x" } },
      }),
    );
    expect(acc.toolCalls.get("call_native")?.isDynamic).toBe(false);
  });

  it("leaves a third-party MCP server's tool native", () => {
    // Only OUR loopback namespace is bridge-owned. A different MCP server's tool
    // is dispatched by the CLI, not by dynamic-tools.ts, so it must still fire.
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: {
          type: "mcpToolCall",
          id: "call_third_party",
          name: "mcp__othersrv__lookup",
          arguments: {},
        },
      }),
    );
    expect(acc.toolCalls.get("call_third_party")?.isDynamic).toBe(false);
  });

  it("keeps recognizing a plain dynamicToolCall", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "dynamicToolCall", id: "call_dyn", name: "image", arguments: {} },
      }),
    );
    expect(acc.toolCalls.get("call_dyn")?.isDynamic).toBe(true);
  });
});
