/** Subscribed embedded tool lifecycles, including real QuickJS bridge coverage. */
import { getEventListeners } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createDiagnosticEmbeddedRunOwner } from "../logging/diagnostic-run-activity.js";
import { buildExecApprovalPendingToolResult } from "./bash-tools.exec-host-shared.js";
import { disposeAllCodeModeRuns } from "./code-mode-state.js";
import {
  addClientToolsToCodeModeCatalog,
  applyCodeModeCatalog,
  createCodeModeTools,
} from "./code-mode.js";
import {
  fakeTool,
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
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search.js";
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

  it.each(["context", "tool", "catalog"] as const)(
    "releases only the parked owner after %s abort without wait",
    async (signalSource) => {
      const owner = createSubscribedCodeModeHarness({ name: `parked-${signalSource}` });
      const survivor = createSubscribedCodeModeHarness({ name: `survivor-${signalSource}` });
      const toolAbortController = new AbortController();
      const controller =
        signalSource === "context" ? owner.runAbortController : toolAbortController;
      const code = 'setTimeout(() => {}, 60_000); await yield_control("pause"); return "done";';
      applyCodeModeCatalog(owner);
      applyCodeModeCatalog(survivor);

      try {
        const parked = resultDetails(
          await expectDefined(owner.tools[0], "owner exec").execute(
            "code-call-parked",
            { code },
            signalSource === "tool" ? toolAbortController.signal : undefined,
          ),
        );
        const other = resultDetails(
          await expectDefined(survivor.tools[0], "survivor exec").execute("code-call-survivor", {
            code,
          }),
        );
        for (const result of [parked, other]) {
          expect(result).toMatchObject({ status: "waiting", runId: expect.any(String) });
        }
        const ownerId = parked.runId as string;
        const survivorId = other.runId as string;
        const ownerState = expectDefined(testing.activeRuns.get(ownerId), "parked owner snapshot");
        const survivorState = expectDefined(
          testing.activeRuns.get(survivorId),
          "survivor snapshot",
        );
        const pending = expectDefined(
          ownerState.pending.find((entry) => entry.method === "sleep"),
          "owner timer",
        );
        const otherPending = expectDefined(
          survivorState.pending.find((entry) => entry.method === "sleep"),
          "survivor timer",
        );
        expect(pending.settled).toBeUndefined();
        expect(otherPending.settled).toBeUndefined();
        expect(ownerState.snapshotBytes.byteLength).toBeGreaterThan(0);
        expect(testing.resumingRunIds.size).toBe(0);

        // Both exec calls have returned; no wait is in flight to perform owner cleanup.
        if (signalSource === "catalog") {
          clearToolSearchCatalog(owner);
        } else {
          controller.abort(new Error("parked owner closed"));
        }
        expect([...testing.activeRuns.keys()]).toEqual([survivorId]);
        await expect(pending.promise).resolves.toMatchObject({ id: pending.id, ok: false });
        expect(testing.activeRuns.get(survivorId)).toBe(survivorState);
        expect(otherPending.settled).toBeUndefined();
      } finally {
        owner.dispose();
        survivor.dispose();
      }
    },
  );

  it.each(["complete", "context", "tool", "catalog"] as const)(
    "transfers parked ownership across refresh and repeated resumes before %s",
    async (close) => {
      const owner = createSubscribedCodeModeHarness({ name: `transfer-${close}` });
      applyCodeModeCatalog(owner);
      const exec = expectDefined(owner.tools[0], "owner exec");
      const wait = expectDefined(owner.tools[1], "owner wait");
      let controller = new AbortController();
      try {
        let result = resultDetails(
          await exec.execute(
            "transfer-exec",
            {
              code: `const timer = setTimeout(() => {}, 60_000);
                await yield_control("first");
                await yield_control("second");
                await yield_control("third");
                clearTimeout(timer);
                return "done";`,
            },
            controller.signal,
          ),
        );
        expect(result.status).toBe("waiting");
        const runId = result.runId as string;
        const initial = expectDefined(testing.activeRuns.get(runId), "initial snapshot");
        expect(applyCodeModeCatalog(owner).catalogReused).toBe(true);
        addClientToolsToCodeModeCatalog({
          ...owner,
          tools: [fakeTool("client_probe", "Client probe")],
        });
        expect(testing.activeRuns.get(runId)).toBe(initial);
        expect(exec.description).toContain("client_probe");

        for (let index = 0; index < 2; index += 1) {
          const previous = expectDefined(testing.activeRuns.get(runId), "previous snapshot");
          const staleClose = expectDefined(
            owner.catalogRef.onDispose?.values().next().value,
            "parked owner subscription",
          );
          controller = new AbortController();
          result = resultDetails(
            await wait.execute(`transfer-wait-${index}`, { runId }, controller.signal),
          );
          expect(result).toMatchObject({ status: "waiting", runId });
          const replacement = expectDefined(testing.activeRuns.get(runId), "replacement snapshot");
          expect(replacement).not.toBe(previous);
          staleClose();
          expect(testing.activeRuns.get(runId)).toBe(replacement);
          expect(getEventListeners(previous.ownerSignal, "abort")).toHaveLength(0);
          expect(previous.ownerSignal.aborted).toBe(true);
          expect(getEventListeners(replacement.ownerSignal, "abort")).toHaveLength(1);
          expect(owner.catalogRef.onDispose?.size).toBe(1);
        }

        const finalState = expectDefined(testing.activeRuns.get(runId), "final snapshot");
        const pending = finalState.pending;
        if (close === "complete") {
          expect(resultDetails(await wait.execute("transfer-complete", { runId }))).toMatchObject({
            status: "completed",
            value: "done",
          });
        } else if (close === "catalog") {
          clearToolSearchCatalog(owner);
        } else {
          (close === "context" ? owner.runAbortController : controller).abort();
        }
        expect(testing.activeRuns.size).toBe(0);
        expect(testing.resumingRunIds.size).toBe(0);
        await Promise.all(pending.map((entry) => entry.promise));
        expect(getEventListeners(finalState.ownerSignal, "abort")).toHaveLength(0);
        expect(finalState.ownerSignal.aborted).toBe(true);
        expect(owner.catalogRef.onDispose?.size ?? 0).toBe(0);
      } finally {
        clearToolSearchCatalog(owner);
        owner.dispose();
      }
    },
  );

  it.each(["exec", "wait"] as const)(
    "does not publish a snapshot after its catalog closes during %s",
    async (phase) => {
      // Worker startup must not consume the host budget before close_owner dispatches.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const owner = createSubscribedCodeModeHarness({ name: `close-during-${phase}` });
      const closeOwner = pluginToolWithExecute("close_owner", "Close the run catalog", async () => {
        clearToolSearchCatalog(owner);
        return jsonResult({ closed: true });
      });
      applyCodeModeCatalog({ ...owner, tools: [...owner.tools, closeOwner] });
      try {
        const execute = () =>
          expectDefined(owner.tools[0], "owner exec").execute("close-during-exec", {
            code: `${phase === "wait" ? 'await yield_control("initial");' : ""}
            await close_owner({});
            await yield_control("closed");
            return "unreachable";`,
          });
        let completion;
        if (phase === "wait") {
          const parked = resultDetails(await execute());
          expect(parked.status).toBe("waiting");
          completion = expectDefined(owner.tools[1], "owner wait").execute("close-during-wait", {
            runId: parked.runId,
          });
        } else {
          completion = execute();
        }
        expect(resultDetails(await completion)).toMatchObject({
          status: "failed",
          code: "aborted",
          telemetry: { catalogSize: 1, callCount: 1 },
        });
        expect(owner.catalogRef.current).toBeUndefined();
        expect(closeOwner.execute).toHaveBeenCalledOnce();
        expect(testing.activeRuns.size).toBe(0);
        expect(testing.resumingRunIds.size).toBe(0);
        expect(countActiveToolExecutions(owner.runId)).toBe(0);
      } finally {
        clearToolSearchCatalog(owner);
        owner.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("does not return a closed snapshot when owner abort races the wait deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const owner = createSubscribedCodeModeHarness({
      name: "abort-wait-deadline",
      timeoutMs: 1_500,
    });
    const started = createDeferred();
    const stalled = pluginToolWithExecute("stalled", "Await cancellation", async () => {
      started.resolve();
      return await new Promise<never>(() => {});
    });
    applyCodeModeCatalog({ ...owner, tools: [...owner.tools, stalled] });
    try {
      const execution = expectDefined(owner.tools[0], "owner exec").execute("deadline-exec", {
        code: "return await stalled({});",
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(1_500);
      const parked = resultDetails(await execution);
      expect(parked.status).toBe("waiting");
      const waiting = expectDefined(owner.tools[1], "owner wait").execute("deadline-wait", {
        runId: parked.runId,
      });
      vi.advanceTimersByTime(1_499);
      owner.runAbortController.abort();
      expect(resultDetails(await waiting)).toMatchObject({ status: "failed", code: "aborted" });
      expect(testing.activeRuns.size).toBe(0);
      expect(testing.resumingRunIds.size).toBe(0);
      expect(countActiveToolExecutions(owner.runId)).toBe(0);
    } finally {
      clearToolSearchCatalog(owner);
      owner.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    { kind: "explicit cancellation", close: "cancel" },
    { kind: "run-owner loss", close: "abort" },
    { kind: "snapshot expiry", close: "expire" },
    { kind: "gateway shutdown", close: "shutdown" },
    { kind: "catalog closure during wait", close: "catalog" },
  ] as const)(
    "settles an abort-ignoring subscribed tool exactly once after $kind",
    async ({ close }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const downstream = createDeferred();
      const started = createDeferred();
      const harness = createSubscribedCodeModeHarness({
        name: `closure-${close}`,
        timeoutMs: 2_000,
      });
      const target = pluginToolWithExecute("stalled_target", "Ignore cancellation", async () => {
        started.resolve();
        await downstream.promise;
        return jsonResult({ late: true });
      });
      const continuation = pluginToolWithExecute(
        "continue_after_target",
        "Continue the guest",
        async () => jsonResult({ continued: true }),
      );
      applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target, continuation] });

      try {
        const execution = expectDefined(harness.tools[0], "Code Mode exec test invariant").execute(
          `code-call-${close}`,
          {
            code: `const target = stalled_target({});
                try { await target; } catch (error) { return error.message; }
                return await continue_after_target({});`,
          },
        );
        await started.promise;
        await vi.advanceTimersByTimeAsync(2_000);
        const suspended = resultDetails(await execution);
        expect(suspended.status).toBe("waiting");
        expect(target.execute).toHaveBeenCalledOnce();
        expect(countActiveToolExecutions(harness.runId)).toBe(1);

        const parked = testing.activeRuns.get(suspended.runId as string);
        const pending = parked?.pending.find((entry) => entry.method === "callValue");
        expect(pending).toBeDefined();
        if (!parked || !pending) {
          throw new Error("expected one parked subscribed tool call");
        }
        const settlements = vi.fn();
        void pending.promise.then(settlements);
        const cancel = vi.spyOn(pending, "cancel");
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
        } else if (close === "catalog") {
          clearToolSearchCatalog(harness);
        } else {
          disposeAllCodeModeRuns();
        }

        const settlement = await pending.promise;
        expect(settlement).toMatchObject({ id: pending.id, ok: false });
        expect(settlement.ok ? "" : settlement.error).toMatch(/cancel|abort|expir|owner|shut/i);
        const result = resultDetails(await waiting);
        expect(result.status).not.toBe("waiting");
        if (close === "catalog") {
          expect(result).toMatchObject({
            status: "failed",
            code: "aborted",
            telemetry: suspended.telemetry,
          });
          expect(harness.catalogRef.current).toBeUndefined();
        }
        await vi.waitFor(() => expect(countActiveToolExecutions(harness.runId)).toBe(0));
        expect(settlements).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
        expect(harness.subscription.getItemLifecycle().activeCount).toBe(0);
        expect(testing.activeRuns.size).toBe(0);
        expect(testing.resumingRunIds.size).toBe(0);

        downstream.resolve();
        await Promise.resolve();
        expect(target.execute).toHaveBeenCalledOnce();
        expect(continuation.execute).not.toHaveBeenCalled();
        expect(settlements).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
      } finally {
        downstream.resolve();
        clearToolSearchCatalog(harness);
        harness.dispose();
        vi.useRealTimers();
      }
    },
  );
});
