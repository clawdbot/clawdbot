import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForDiagnosticEventsDrained } from "../../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
} from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticModelStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import { logSessionStateChange, startDiagnosticHeartbeat } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./execute.js";
import { wrapPreparedCliRunWithTestAdmission } from "./execute.test-support.js";

afterEach(() => {
  resetDiagnosticStateForTest();
  vi.useRealTimers();
});

it.each(["embedded_run", "model_call"] as const)(
  "keeps a CLI background task alive through %s recovery and releases its allowance on clear",
  async (activeWorkKind) => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(Date.parse("2026-08-04T00:00:00Z"));
    const recoverStuckSession = vi.fn();
    startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
    const context = buildPreparedCliRunContext({
      runId: "background-run",
      sessionId: "background-session",
      sessionKey: "agent:main:background",
      agentId: "main",
      model: "fixture-model",
      config: { plugins: { enabled: false } },
      timeoutMs: 1_800_000,
      backend: {
        command: process.execPath,
        sessionMode: "none",
        reliability: { watchdog: { fresh: { minMs: 180_000, maxMs: 180_000 } } },
      },
    });
    context.backendResolved.bundleMcp = false;
    const started = createDeferred<number>();
    const clear = createDeferred();
    const cleared = createDeferred<number>();
    const finish = createDeferred();
    context.executionTarget = {
      kind: "plugin",
      async *execute() {
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "background-agent", task_type: "local_agent" }],
        };
        started.resolve(Date.now());
        await clear.promise;
        yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
        cleared.resolve(Date.now());
        await finish.promise;
        yield { type: "result", subtype: "success", result: "background completed" };
      },
    };
    const owner = createDiagnosticEmbeddedRunOwner(context.params);
    context.params.diagnosticOwner = owner;
    logSessionStateChange({ ...context.params, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...context.params, owner });
    if (activeWorkKind === "model_call") {
      markDiagnosticModelStartedForTest({ ...context.params, model: context.modelId });
    }
    const run = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context);
    try {
      const startedAt = await started.promise;
      await vi.advanceTimersByTimeAsync(390_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();
      expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
        activeWorkKind,
        activeBackendLivenessDeadlineAtMs: startedAt + BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
        lastProgressAgeMs: 390_000,
      });

      clear.resolve();
      const clearedAt = await cleared.promise;
      expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
        activeBackendLivenessDeadlineAtMs: clearedAt + 180_000,
        lastProgressAgeMs: 0,
      });
      finish.resolve();
      await expect(run).resolves.toMatchObject({ text: "background completed" });
      await waitForDiagnosticEventsDrained();
      expect(
        getDiagnosticSessionActivitySnapshot(context.params).activeBackendLivenessDeadlineAtMs,
      ).toBeUndefined();
    } finally {
      clear.resolve();
      finish.resolve();
      await Promise.allSettled([run]);
      closeDiagnosticEmbeddedRunOwner(owner);
    }
  },
);
