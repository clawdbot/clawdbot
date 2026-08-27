/** Subscribed embedded tool lifecycles, including real QuickJS bridge coverage. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createDiagnosticEmbeddedRunOwner } from "../logging/diagnostic-run-activity.js";
import { buildExecApprovalPendingToolResult } from "./bash-tools.exec-host-shared.js";
import { disposeAllCodeModeRuns } from "./code-mode-state.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { prepareEmbeddedAttemptStream } from "./embedded-agent-runner/run/attempt-stream-prepare.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { clearActiveEmbeddedRun } from "./embedded-agent-runner/runs.js";
import {
  createStubSessionHarness,
  emitAssistantTextDeltaAndEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { countActiveToolExecutions } from "./embedded-agent-subscribe.handlers.tools.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

function createSubscribedCodeModeHarness(params: {
  name: string;
  onBlockReplyFlush?: () => Promise<void>;
  onToolResult?: EmbeddedRunAttemptParams["onToolResult"];
  onBlockReply?: EmbeddedRunAttemptParams["onBlockReply"];
  onPartialReply?: EmbeddedRunAttemptParams["onPartialReply"];
  timeoutMs?: number;
}) {
  const runId = `run-code-mode-${params.name}`;
  const sessionId = `session-code-mode-${params.name}`;
  const sessionKey = `agent:main:${params.name}`;
  const config = {
    tools: { codeMode: { enabled: true, timeoutMs: params.timeoutMs ?? 1_500 } },
  } as never;
  const catalogRef = createToolSearchCatalogRef();
  const runAbortController = new AbortController();
  const { session, emit } = createStubSessionHarness();
  const activeSession = Object.assign(session, {
    agent: { hasQueuedMessages: () => false },
    isStreaming: false,
    messages: [],
    pendingMessageCount: 0,
  });
  const stream = prepareEmbeddedAttemptStream({
    attempt: {
      config,
      runId,
      sessionId,
      sessionKey,
      onToolResult: params.onToolResult,
      onPartialReply: params.onPartialReply,
      blockReplyBreak: "message_end",
    } as never,
    activeSession: activeSession as never,
    hookRunner: undefined as never,
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    diagnosticOwner: createDiagnosticEmbeddedRunOwner({ sessionId, sessionKey, runId }),
    clientToolCallSlots: [],
    toolSearchTargetTranscriptProjections: [],
    isReplaySafeTool: () => false,
    runAbortController,
    abortRun: () => runAbortController.abort(),
    markExternalAbort: () => undefined,
    getRunState: () => ({
      aborted: runAbortController.signal.aborted,
      promptError: undefined,
      timedOut: false,
      yieldDetected: false,
    }),
    hasDeliveredSourceReply: () => false,
    markSourceReplyDelivered: () => undefined,
    onBlockReply: params.onBlockReply,
    onBlockReplyFlush: params.onBlockReplyFlush,
    sandboxSessionKey: sessionKey,
    builtinToolNames: new Set(),
    replaySafeToolNames: new Set(),
  });
  const context = {
    config,
    runtimeConfig: config,
    sessionId,
    sessionKey,
    runId,
    catalogRef,
    abortSignal: runAbortController.signal,
    executeTool: stream.toolSearchCatalogExecutor,
  };
  return {
    ...context,
    emit,
    tools: createCodeModeTools(context),
    runAbortController,
    subscription: stream.subscription,
    dispose: () => {
      stream.subscription.unsubscribe();
      clearActiveEmbeddedRun(sessionId, stream.queueHandle, sessionKey);
    },
  };
}

describe("Code Mode subscribed bridge lifecycle", () => {
  afterEach(() => resetCodeModeTestState());

  it.each([
    { approval: "unavailable", outcome: "recovery" },
    { approval: "unavailable", outcome: "error" },
    { approval: "pending", outcome: "recovery" },
    { approval: "pending", outcome: "rejected-notice" },
  ] as const)(
    "preserves $outcome delivery after a nested $approval approval notice",
    async ({ approval, outcome }) => {
      const onToolResult = vi.fn();
      const onPartialReply = vi.fn();
      const onBlockReply = vi.fn();
      const harness = createSubscribedCodeModeHarness({
        name: `approval-${approval}-${outcome}`,
        onToolResult,
        onPartialReply,
        onBlockReply,
      });
      let unavailable = approval === "unavailable";
      const shell = pluginToolWithExecute("exec", "Run shell", async () =>
        buildExecApprovalPendingToolResult({
          host: "gateway",
          command: "review weekly pull requests",
          cwd: "/tmp/work",
          warningText: "",
          approvalId: "12345678-1234-1234-1234-123456789012",
          approvalSlug: "12345678",
          expiresAtMs: Date.now() + 60_000,
          initiatingSurface: { kind: "disabled", channel: "discord", channelLabel: "Discord" },
          sentApproverDms: false,
          unavailableReason: unavailable ? "initiating-platform-disabled" : null,
        }),
      );
      const browser = pluginToolWithExecute("browser", "Read pull requests", async () =>
        jsonResult({ pullRequests: [123] }),
      );
      // Exercise the executor used by hidden Code Mode calls without a worker-startup deadline.
      const callNestedTool = (tool: typeof shell, toolCallId: string) =>
        harness.executeTool({
          tool,
          toolName: tool.name,
          source: "openclaw",
          sourceName: "fixture-plugin",
          toolCallId,
          parentToolCallId: `code-${toolCallId}`,
          input: {},
          acceptResultBeforeProjection: async (result) => result,
        });

      try {
        await callNestedTool(shell, "approval");
        expect(onToolResult).toHaveBeenCalledOnce();
        expect(onToolResult.mock.calls[0]?.[0].text).toContain(
          approval === "pending" ? "/approve 12345678" : "not configured on Discord",
        );

        if (outcome === "rejected-notice") {
          unavailable = true;
          onToolResult.mockRejectedValueOnce(new Error("notice delivery failed"));
          await callNestedTool(shell, "unavailable");
          expect(onToolResult).toHaveBeenCalledTimes(2);
        }

        const answer = "I found PR #123 in last week's channel messages.";
        if (outcome !== "error") {
          const recovered = await callNestedTool(browser, "recovery");
          expect(recovered.details).toEqual({ pullRequests: [123] });
          expect(browser.execute).toHaveBeenCalledOnce();
          harness.emit({ type: "message_start", message: { role: "assistant", content: [] } });
          emitAssistantTextDeltaAndEnd({ emit: harness.emit, text: answer });
        } else {
          harness.emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "rate limit exceeded",
            },
          });
        }
        harness.emit({ type: "agent_end", messages: [], willRetry: false });
        await harness.subscription.waitForPendingEvents();

        const payloads = buildEmbeddedRunPayloads({
          assistantTexts: harness.subscription.assistantTexts,
          lastAssistant: harness.subscription.getCurrentAttemptAssistant(),
          lastToolError: harness.subscription.getLastToolError(),
          sessionKey: harness.sessionKey,
          didSendDeterministicApprovalPrompt:
            harness.subscription.didSendDeterministicApprovalPrompt(),
        });
        if (approval === "pending") {
          expect(onPartialReply).not.toHaveBeenCalled();
          expect(onBlockReply).not.toHaveBeenCalled();
          expect(payloads).not.toContainEqual(expect.objectContaining({ text: answer }));
          if (outcome === "recovery") {
            expect(payloads).toEqual([]);
          }
        } else if (outcome === "recovery") {
          expect(onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: answer }));
          expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([answer]);
          expect(payloads).toEqual([expect.objectContaining({ text: answer })]);
        } else {
          expect(payloads).toEqual([
            expect.objectContaining({ isError: true, text: expect.stringMatching(/rate limit/i) }),
          ]);
        }
      } finally {
        harness.dispose();
      }
    },
  );

  it("starts a subscribed nested tool without re-entering its outer presentation flush", async () => {
    const blockReplyFlush = createDeferred();
    const onBlockReplyFlush = vi.fn(() => blockReplyFlush.promise);
    const harness = createSubscribedCodeModeHarness({ name: "circular-flush", onBlockReplyFlush });
    const target = pluginToolWithExecute("release_flush", "Release the pending reply", async () => {
      blockReplyFlush.resolve();
      return jsonResult({ released: true });
    });
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });

    try {
      const result = resultDetails(
        await expectDefined(harness.tools[0], "Code Mode exec test invariant").execute(
          "code-call-circular-flush",
          { code: "return await release_flush({});" },
        ),
      );

      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(result.value).toEqual({ released: true });
      expect(target.execute).toHaveBeenCalledOnce();
      expect(onBlockReplyFlush).not.toHaveBeenCalled();
      expect(harness.subscription.getItemLifecycle()).toMatchObject({
        startedCount: 1,
        completedCount: 1,
        activeCount: 0,
      });
      expect(countActiveToolExecutions(harness.runId)).toBe(0);
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      blockReplyFlush.resolve();
      harness.dispose();
    }
  });

  it("settles subscribed nested dispatch exactly once across repeated exec and wait turns", async () => {
    const blockReplyFlush = createDeferred();
    const onBlockReplyFlush = vi.fn(() => blockReplyFlush.promise);
    const harness = createSubscribedCodeModeHarness({
      name: "repeated-lifecycle",
      onBlockReplyFlush,
    });
    const target = pluginToolWithExecute("finish_stage", "Finish one suspended stage", async () => {
      blockReplyFlush.resolve();
      return jsonResult({ finished: true });
    });
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });

    try {
      for (let stage = 0; stage < 2; stage += 1) {
        const suspended = resultDetails(
          await expectDefined(harness.tools[0], "Code Mode exec test invariant").execute(
            `code-call-stage-${stage}`,
            { code: 'await yield_control("pause"); return await finish_stage({});' },
          ),
        );
        expect(suspended).toMatchObject({ status: "waiting", reason: "yield" });

        const completed = resultDetails(
          await expectDefined(harness.tools[1], "Code Mode wait test invariant").execute(
            `code-wait-stage-${stage}`,
            { runId: suspended.runId },
          ),
        );
        expect(completed).toMatchObject({ status: "completed", value: { finished: true } });
        expect(countActiveToolExecutions(harness.runId)).toBe(0);
      }

      expect(target.execute).toHaveBeenCalledTimes(2);
      expect(onBlockReplyFlush).not.toHaveBeenCalled();
      expect(harness.subscription.getItemLifecycle()).toMatchObject({
        startedCount: 2,
        completedCount: 2,
        activeCount: 0,
      });
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      blockReplyFlush.resolve();
      harness.dispose();
    }
  });

  it("preserves the initiating sessions_yield result across its run-owner handoff", async () => {
    const harness = createSubscribedCodeModeHarness({ name: "yield-handoff" });
    const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
    const target = pluginToolWithExecute(
      "sessions_yield",
      "Hand off the current turn",
      async () => {
        harness.runAbortController.abort(handoffReason);
        return jsonResult({ status: "yielded" });
      },
    );
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });

    try {
      const result = resultDetails(
        await expectDefined(harness.tools[0], "Code Mode exec test invariant").execute(
          "code-call-yield-handoff",
          { code: "return await sessions_yield({});" },
        ),
      );

      expect(result).toMatchObject({ status: "completed", value: { status: "yielded" } });
      expect(target.execute).toHaveBeenCalledOnce();
      expect(countActiveToolExecutions(harness.runId)).toBe(0);
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it.each([
    { kind: "explicit cancellation", close: "cancel" },
    { kind: "run-owner loss", close: "abort" },
    { kind: "snapshot expiry", close: "expire" },
    { kind: "gateway shutdown", close: "shutdown" },
  ] as const)(
    "settles an abort-ignoring subscribed tool exactly once after $kind",
    async ({ close }) => {
      const downstream = createDeferred();
      const harness = createSubscribedCodeModeHarness({
        name: `closure-${close}`,
        timeoutMs: 2_000,
      });
      const target = pluginToolWithExecute("stalled_target", "Ignore cancellation", async () => {
        await downstream.promise;
        return jsonResult({ late: true });
      });
      applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });

      try {
        const suspended = resultDetails(
          await expectDefined(harness.tools[0], "Code Mode exec test invariant").execute(
            `code-call-${close}`,
            {
              code: `const target = stalled_target({});
                await yield_control("pause");
                try { return await target; } catch (error) { return error.message; }`,
            },
          ),
        );
        expect(suspended.status).toBe("waiting");
        await vi.waitFor(() => expect(target.execute).toHaveBeenCalledOnce());
        expect(countActiveToolExecutions(harness.runId)).toBe(1);

        const parked = testing.activeRuns.get(suspended.runId as string);
        const pending = parked?.pending.find((entry) => entry.method === "callValue");
        expect(pending).toBeDefined();
        if (!parked || !pending) {
          throw new Error("expected one parked subscribed tool call");
        }
        const settlements = vi.fn();
        void pending.promise.then(settlements);
        const waiting = expectDefined(harness.tools[1], "Code Mode wait test invariant").execute(
          `code-wait-${close}`,
          { runId: suspended.runId },
        );

        if (close === "cancel") {
          pending.cancel?.();
        } else if (close === "abort") {
          harness.runAbortController.abort(new Error("run owner closed"));
        } else if (close === "expire") {
          parked.expiresAt = Date.now() - 1;
          testing.removeExpiredRuns();
        } else {
          disposeAllCodeModeRuns();
        }

        const settlement = await pending.promise;
        expect(settlement).toMatchObject({ id: pending.id, ok: false });
        expect(settlement.ok ? "" : settlement.error).toMatch(/cancel|abort|expir|owner|shut/i);
        expect(resultDetails(await waiting).status).not.toBe("waiting");
        await vi.waitFor(() => expect(countActiveToolExecutions(harness.runId)).toBe(0));
        expect(settlements).toHaveBeenCalledOnce();
        expect(harness.subscription.getItemLifecycle().activeCount).toBe(0);
        expect(testing.activeRuns.size).toBe(0);

        downstream.resolve();
        await Promise.resolve();
        expect(target.execute).toHaveBeenCalledOnce();
        expect(settlements).toHaveBeenCalledOnce();
      } finally {
        downstream.resolve();
        harness.dispose();
      }
    },
  );
});
