/**
 * Integration test proving that sessions_yield produces a clean end_turn exit
 * with no pending tool calls, so the parent session is idle when subagent
 * results arrive.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import { isEmbeddedAgentRunActive, queueEmbeddedAgentMessageWithOutcome } from "./runs.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("sessions_yield orchestration", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("parent session is idle after yield — end_turn, no pendingToolCalls", async () => {
    const sessionId = "yield-parent-session";

    // Simulate an attempt where sessions_yield was called
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        sessionIdUsed: sessionId,
        yieldDetected: true,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      sessionId,
      runId: "run-yield-orchestration",
    });

    // 1. Run completed with end_turn (yield causes clean exit)
    expect(result.meta.stopReason).toBe("end_turn");

    // 2. No pending tool calls (yield is NOT a client tool call)
    expect(result.meta.pendingToolCalls).toBeUndefined();

    // 3. Parent session is IDLE (not in ACTIVE_EMBEDDED_RUNS)
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(false);

    // 4. Steer would fail (message delivery must take direct path, not steer)
    const queueResult = queueEmbeddedAgentMessageWithOutcome(sessionId, "subagent result");
    expect(queueResult.queued).toBe(false);
    if (queueResult.queued) {
      throw new Error("expected queue attempt to fail without an active run");
    }
    expect(queueResult.reason).toBe("no_active_run");
  });

  it("clientToolCalls takes precedence over yieldDetected", async () => {
    // Edge case: both flags set (shouldn't happen, but clientToolCalls wins)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        yieldDetected: true,
        clientToolCalls: [{ name: "hosted_tool", params: { arg: "value" } }],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-yield-vs-client-tool",
    });

    // clientToolCalls wins — tool_calls stopReason, pendingToolCalls populated
    expect(result.meta.stopReason).toBe("tool_calls");
    expect(result.meta.pendingToolCalls).toHaveLength(1);
    const hostedToolCall = expectDefined(result.meta.pendingToolCalls![0], "hosted tool call");
    expect(hostedToolCall.name).toBe("hosted_tool");
    expect(result.payloads).toBeUndefined();
  });

  it("preserves order across multiple client tool calls in one attempt (#52288)", async () => {
    // Regression: a turn that invokes three client tools must surface all
    // three through `pendingToolCalls`, in the order the LLM emitted them.
    // Pre-fix this slot was a single variable that only kept the last call.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        clientToolCalls: [
          { name: "create_graph", params: { nodes: ["a", "b"] } },
          { name: "activate_graph", params: {} },
          { name: "get_status", params: {} },
        ],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-multi-client-tool",
    });

    expect(result.meta.stopReason).toBe("tool_calls");
    expect(result.meta.pendingToolCalls).toHaveLength(3);
    expect(result.meta.pendingToolCalls!.map((c) => c.name)).toEqual([
      "create_graph",
      "activate_graph",
      "get_status",
    ]);
    const firstCall = expectDefined(result.meta.pendingToolCalls![0], "first pending tool call");
    expect(JSON.parse(firstCall.arguments)).toEqual({
      nodes: ["a", "b"],
    });
  });

  describe("yield with continuation evidence", () => {
    it("yield with accepted spawn — diagnostic suppressed", async () => {
      // Regression: a yielded turn with an accepted spawn must NOT emit the
      // diagnostic — the spawned subagent will produce results.
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          yieldDetected: true,
          assistantTexts: [],
          acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "child-key" }],
        }),
      );

      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        runId: "run-yield-accepted-spawn-suppressed",
      });

      // Accepted spawn is continuation evidence → no diagnostic payload
      expect(result.payloads).toBeUndefined();
      expect(result.meta.stopReason).toBe("end_turn");
      expect(result.meta.yielded).toBe(true);
    });

    it("yield with async started tool — diagnostic suppressed", async () => {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          yieldDetected: true,
          assistantTexts: [],
          toolMetas: [{ toolName: "my_async_tool", asyncStarted: true }],
        }),
      );

      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        runId: "run-yield-async-tool-suppressed",
      });

      // Async tool activity is continuation evidence → no diagnostic payload
      expect(result.payloads).toBeUndefined();
      expect(result.meta.stopReason).toBe("end_turn");
      expect(result.meta.yielded).toBe(true);
    });
  });

  it("normal attempt without yield has no stopReason override", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-no-yield",
    });

    // Neither clientToolCall nor yieldDetected → stopReason is undefined
    expect(result.meta.stopReason).toBeUndefined();
    expect(result.meta.pendingToolCalls).toBeUndefined();
  });

  it("emits diagnostic payload when yieldDetected has no continuation evidence", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        yieldDetected: true,
        assistantTexts: [],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-yield-no-continuation",
    });

    // yieldDetected without any continuation source → diagnostic payload
    expect(result.payloads).toHaveLength(1);
    const diagnosticPayload = expectDefined(result.payloads![0], "diagnostic payload");
    expect(diagnosticPayload.text).toBe(
      "⚠️ Turn yielded without a continuation source. Send a message to resume.",
    );
    // stopReason is still end_turn (yield semantics preserved)
    expect(result.meta.stopReason).toBe("end_turn");
    // No pending tool calls
    expect(result.meta.pendingToolCalls).toBeUndefined();
  });

  it("whitespace-only delivery text does not suppress diagnostic", async () => {
    // Normalized helpers filter whitespace-only text — yield still parks
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        yieldDetected: true,
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["   "],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-yield-whitespace-delivery",
    });

    // Whitespace-only delivery is not committed delivery → diagnostic emitted
    expect(result.payloads).toHaveLength(1);
    const wsPayload = expectDefined(result.payloads![0], "whitespace diagnostic payload");
    expect(wsPayload.text).toBe(
      "⚠️ Turn yielded without a continuation source. Send a message to resume.",
    );
  });

  it("empty spawn array does not suppress diagnostic", async () => {
    // An explicit empty spawn array is not a valid continuation
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        yieldDetected: true,
        assistantTexts: [],
        acceptedSessionSpawns: [],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-yield-empty-spawn",
    });

    expect(result.payloads).toHaveLength(1);
    const emptySpawnPayload = expectDefined(result.payloads![0], "empty spawn diagnostic payload");
    expect(emptySpawnPayload.text).toBe(
      "⚠️ Turn yielded without a continuation source. Send a message to resume.",
    );
  });
});
