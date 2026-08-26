// Embedded run registry tests cover active run handles, queueing, abort
// ownership, and diagnostics.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  isReplyRunActiveForSessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
import { diagnosticLogger } from "../../logging/diagnostic.js";
import {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  isEmbeddedAgentRunAbortableForCompaction,
  isEmbeddedAgentRunHandleActive,
  retainEmbeddedAgentRunAbortabilityForRunId,
  setActiveEmbeddedRun,
  supersedeEmbeddedAgentRunByRunId,
} from "./runs.js";
import { createEmbeddedRunHandle, testing } from "./runs.test-support.js";

describe("embedded-agent runner run registry", () => {
  afterEach(() => {
    // Registry state is process-global so imported module instances can share
    // it; every test must reset both embedded and reply-run registries.
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticSessionStateForTest();
    setDiagnosticsEnabledForProcess(false);
    vi.restoreAllMocks();
  });

  it("aborts only compacting runs in compacting mode", () => {
    const abortCompacting = vi.fn();
    const abortNormal = vi.fn();

    setActiveEmbeddedRun(
      "session-compacting",
      createEmbeddedRunHandle({ isCompacting: true, abort: abortCompacting }),
    );

    setActiveEmbeddedRun("session-normal", createEmbeddedRunHandle({ abort: abortNormal }));

    const aborted = abortEmbeddedAgentRun(undefined, { mode: "compacting" });
    expect(aborted).toBe(true);
    expect(abortCompacting).toHaveBeenCalledTimes(1);
    expect(abortNormal).not.toHaveBeenCalled();
  });

  it("keeps queued reply operations out of compact abort checks", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-reply-run",
      resetTriggered: false,
    });

    expect(isEmbeddedAgentRunAbortableForCompaction("session-reply-run")).toBe(false);

    operation.setPhase("running");

    expect(isEmbeddedAgentRunAbortableForCompaction("session-reply-run")).toBe(true);
  });

  it("aborts every active run in all mode", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun(
      "session-a",
      createEmbeddedRunHandle({ isCompacting: true, abort: abortA }),
    );

    setActiveEmbeddedRun("session-b", createEmbeddedRunHandle({ abort: abortB }));

    const aborted = abortEmbeddedAgentRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("keeps finalizing runs active while rejecting abort requests", () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, isAbortable: false });
    const operation = createReplyOperation({
      sessionKey: "agent:main:finalizing",
      sessionId: "session-finalizing",
      resetTriggered: false,
    });
    const replyBackend = {
      kind: "embedded" as const,
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
    };
    operation.setPhase("running");
    operation.attachBackend(replyBackend);
    setActiveEmbeddedRun("session-finalizing", handle);

    expect(abortEmbeddedAgentRun("session-finalizing")).toBe(false);
    expect(abortEmbeddedAgentRun(undefined, { mode: "all" })).toBe(false);
    expect(isEmbeddedAgentRunAbortableForCompaction("session-finalizing")).toBe(true);
    expect(isEmbeddedAgentRunHandleActive("session-finalizing")).toBe(true);
    expect(operation.result).toBeNull();
    expect(abort).not.toHaveBeenCalled();

    clearActiveEmbeddedRun("session-finalizing", handle);
    operation.detachBackend(replyBackend);
    expect(abortEmbeddedAgentRun(undefined, { mode: "all" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    operation.complete();
    expect(isEmbeddedAgentRunHandleActive("session-finalizing")).toBe(false);
  });

  it("keeps frozen run ownership through forced in-process restart", () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, isAbortable: false });
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-finalizing",
      sessionId: "session-restart-finalizing",
      resetTriggered: false,
    });
    const replyBackend = {
      kind: "embedded" as const,
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
    };
    operation.setPhase("running");
    operation.attachBackend(replyBackend);
    setActiveEmbeddedRun("session-restart-finalizing", handle);

    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(false);
    expect(isEmbeddedAgentRunHandleActive("session-restart-finalizing")).toBe(true);
    expect(isReplyRunActiveForSessionId("session-restart-finalizing")).toBe(true);
    expect(operation.result).toBeNull();
    expect(abort).not.toHaveBeenCalled();

    clearActiveEmbeddedRun("session-restart-finalizing", handle);
    operation.detachBackend(replyBackend);
    operation.complete();
    expect(isEmbeddedAgentRunHandleActive("session-restart-finalizing")).toBe(false);
    expect(isReplyRunActiveForSessionId("session-restart-finalizing")).toBe(false);
  });

  it("binds abortability to the owning run id", () => {
    const finalizing = createEmbeddedRunHandle({
      abort: vi.fn(),
      isAbortable: false,
      runId: "run-finalizing",
    });
    setActiveEmbeddedRun("session-shared", finalizing);

    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("run-queued")).toBe(true);

    clearActiveEmbeddedRun("session-shared", finalizing);
    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(true);

    retainEmbeddedAgentRunAbortabilityForRunId("run-finalizing");
    setActiveEmbeddedRun("session-shared", finalizing);
    clearActiveEmbeddedRun("session-shared", finalizing);
    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(false);

    const queued = createEmbeddedRunHandle({ runId: "run-queued" });
    setActiveEmbeddedRun("session-shared", queued);

    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("run-queued")).toBe(true);

    clearEmbeddedAgentRunAbortabilityForRunId("run-finalizing");
    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(true);
  });

  it("supersedes an exact reply backend only after recording its terminal owner", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:cli-writer",
      sessionId: "session-cli-writer",
      resetTriggered: false,
    });
    const order: string[] = [];
    operation.attachBackend({
      kind: "cli",
      runId: "run-cli-writer",
      cancel: (reason) => order.push(`cancel:${reason}`),
    });

    expect(supersedeEmbeddedAgentRunByRunId("run-cli-writer", () => order.push("record"))).toBe(
      true,
    );
    expect(order).toEqual(["record", "cancel:superseded"]);
    expect(supersedeEmbeddedAgentRunByRunId("missing-run", vi.fn())).toBe(false);
  });

  it.each([
    {
      name: "stopped",
      configure: (handle: ReturnType<typeof createEmbeddedRunHandle>) => {
        handle.isStopped = () => true;
      },
    },
    {
      name: "aborted",
      configure: (handle: ReturnType<typeof createEmbeddedRunHandle>) => {
        handle.isAborted = () => true;
      },
    },
    {
      name: "non-abortable",
      configure: (handle: ReturnType<typeof createEmbeddedRunHandle>) => {
        handle.isAbortable = () => false;
      },
    },
  ])("does not supersede a $name exact embedded owner", ({ configure }) => {
    const cancel = vi.fn();
    const abort = vi.fn();
    const beforeCancel = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, runId: "run-terminal" });
    handle.cancel = cancel;
    configure(handle);
    setActiveEmbeddedRun("session-terminal", handle);

    expect(supersedeEmbeddedAgentRunByRunId("run-terminal", beforeCancel)).toBe(false);
    expect(beforeCancel).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("fails closed when an exact embedded lifecycle probe throws", () => {
    const warn = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const cancel = vi.fn();
    const beforeCancel = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "run-throwing" });
    handle.cancel = cancel;
    handle.isStopped = () => {
      throw new Error("probe failed");
    };
    setActiveEmbeddedRun("session-throwing", handle);

    expect(supersedeEmbeddedAgentRunByRunId("run-throwing", beforeCancel)).toBe(false);
    expect(beforeCancel).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lifecycle_check_failed"));
  });

  it("passes restart ownership to every aborted run", () => {
    const abort = vi.fn();
    setActiveEmbeddedRun("session-restart", createEmbeddedRunHandle({ abort }));

    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(true);
    expect(abort).toHaveBeenCalledWith("restart");
  });

  it("expires reply-owned stuck recovery as run_stalled instead of user abort", async () => {
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:reply-stuck",
      sessionId: "session-reply-stuck",
      resetTriggered: false,
    });
    cancel.mockImplementation(() => operation.complete());
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId: "session-reply-stuck",
      sessionKey: "agent:main:reply-stuck",
      reason: "stuck_recovery",
      forceClear: true,
    });

    expect(result).toEqual({ aborted: true, drained: true, forceCleared: false });
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(cancel).toHaveBeenCalledWith("superseded");
  });

  it("expires stuck recovery as run_stalled even with a live embedded handle", async () => {
    // The live-handle path is the common field case: the wedged run still owns
    // a registered handle, and its abort handler re-enters abortByUser. The
    // expiry must win the attribution race (run_stalled, not aborted_by_user).
    const operation = createReplyOperation({
      sessionKey: "agent:main:reply-stuck-live",
      sessionId: "session-reply-stuck-live",
      resetTriggered: false,
    });
    const handle = createEmbeddedRunHandle({
      abort: () => {
        operation.abortByUser();
      },
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
    });
    operation.setPhase("running");
    setActiveEmbeddedRun("session-reply-stuck-live", handle);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId: "session-reply-stuck-live",
      sessionKey: "agent:main:reply-stuck-live",
      reason: "stuck_recovery",
      forceClear: true,
      settleMs: 50,
    });

    expect(result.aborted).toBe(true);
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
  });

  it("claims shared restart ownership before invoking an attached handle", () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort });
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-owned",
      sessionId: "session-restart-owned",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
    });
    setActiveEmbeddedRun("session-restart-owned", handle);

    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("restart");
  });

  it.each(["all", "compacting"] as const)(
    "does not bypass frozen shared ownership through %s handle aborts",
    (mode) => {
      const abort = vi.fn();
      const handle = createEmbeddedRunHandle({ abort, isCompacting: true });
      const sessionId = `session-restart-frozen-${mode}`;
      const operation = createReplyOperation({
        sessionKey: `agent:main:restart-frozen-${mode}`,
        sessionId,
        resetTriggered: false,
      });
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        cancel: handle.abort,
        isStreaming: handle.isStreaming,
        isAbortable: handle.isAbortable,
        isCompacting: handle.isCompacting,
      });
      operation.freezeAbort();
      setActiveEmbeddedRun(sessionId, handle);

      expect(abortEmbeddedAgentRun(undefined, { mode, reason: "restart" })).toBe(false);
      expect(operation.result).toBeNull();
      expect(abort).not.toHaveBeenCalled();
    },
  );

  it("keeps shared restart ownership when the attached cancel callback throws", () => {
    const abort = vi.fn(() => {
      throw new Error("cancel failed");
    });
    const handle = createEmbeddedRunHandle({ abort });
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-throwing",
      sessionId: "session-restart-throwing",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
    });
    setActiveEmbeddedRun("session-restart-throwing", handle);

    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does not bypass retained terminal ownership through compacting handle aborts", () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, isCompacting: true });
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-failed-compacting",
      sessionId: "session-restart-failed-compacting",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
      isCompacting: handle.isCompacting,
    });
    operation.retainFailureUntilComplete();
    operation.fail("run_failed", new Error("terminal failure"));
    setActiveEmbeddedRun("session-restart-failed-compacting", handle);

    expect(abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" })).toBe(false);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(abort).not.toHaveBeenCalled();
  });

  it("records active run session files in diagnostic state for heartbeat recovery", () => {
    setDiagnosticsEnabledForProcess(true);
    const sessionFile = "/tmp/openclaw-run-registry-session.jsonl";
    const handle = createEmbeddedRunHandle();

    setActiveEmbeddedRun("session-file-diagnostics", handle, "agent:main:visible", sessionFile);

    expect(getDiagnosticSessionState({ sessionId: "session-file-diagnostics" }).sessionFile).toBe(
      sessionFile,
    );
  });
});
