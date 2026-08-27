/** Real QuickJS bridge coverage for subscribed embedded tool lifecycles. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createDiagnosticEmbeddedRunOwner } from "../logging/diagnostic-run-activity.js";
import { disposeAllCodeModeRuns } from "./code-mode-state.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { prepareEmbeddedAttemptStream } from "./embedded-agent-runner/run/attempt-stream-prepare.js";
import { clearActiveEmbeddedRun } from "./embedded-agent-runner/runs.js";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { countActiveToolExecutions } from "./embedded-agent-subscribe.handlers.tools.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

function createSubscribedCodeModeHarness(params: {
  name: string;
  onBlockReplyFlush?: () => Promise<void>;
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
  const { session } = createStubSessionHarness();
  const activeSession = Object.assign(session, {
    agent: { hasQueuedMessages: () => false },
    isStreaming: false,
    messages: [],
    pendingMessageCount: 0,
  });
  const stream = prepareEmbeddedAttemptStream({
    attempt: { config, runId, sessionId, sessionKey } as never,
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
    onBlockReply: undefined,
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
