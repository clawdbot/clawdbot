/** Tests ACP manager cancellation of active turns and idle sessions. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  extractStatesFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
  mockCallArg,
} from "./manager.test-helpers.js";

describe("AcpSessionManager cancelSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("preempts every turn before its queued actor callback starts", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: "agent:codex:acp:child-1",
        parentSessionKey: "agent:main:main",
      });

      let releaseBlockingCancel: (() => void) | undefined;
      runtimeState.ensureSession.mockImplementation(async (input) => {
        await new Promise<void>((resolve) => {
          releaseBlockingCancel = resolve;
        });
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        };
      });

      const manager = new AcpSessionManager();
      const blockingCancel = manager.cancelSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        reason: "hold-actor",
      });
      await vi.waitFor(
        () => {
          expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
        },
        { interval: 1 },
      );

      const queueTurn = (requestId: string) =>
        manager
          .runTurn({
            provenance: "system",
            cfg: baseCfg,
            sessionKey: "agent:codex:acp:child-1",
            text: "cancel while queued",
            mode: "prompt",
            requestId,
          })
          .then(
            () => ({ status: "resolved" as const }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
      const runOutcomes = Promise.all([
        queueTurn("run-cancel-before-actor-start-1"),
        queueTurn("run-cancel-before-actor-start-2"),
      ]);

      await manager.cancelSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        reason: "manual-cancel",
      });
      const outcomes = await Promise.race([
        runOutcomes,
        new Promise<{ status: "pending" }[]>((resolve) => {
          setTimeout(() => resolve([{ status: "pending" }]), 100);
        }),
      ]);

      releaseBlockingCancel?.();
      await blockingCancel;
      await vi.waitFor(
        () => {
          expect(manager.getObservabilitySnapshot().turns.queueDepth).toBe(0);
        },
        { interval: 1 },
      );

      expect(outcomes).toHaveLength(2);
      expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
      expect(runtimeState.runTurn).not.toHaveBeenCalled();
      expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(runtimeState.cancel), {
        reason: "hold-actor",
      });
    });
  });

  it("preempts a turn while its runtime handle is still initializing", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: "agent:codex:acp:child-1",
        parentSessionKey: "agent:main:main",
      });

      let ensureStarted = false;
      let releaseEnsure: (() => void) | undefined;
      runtimeState.ensureSession.mockImplementation(async (input) => {
        ensureStarted = true;
        await new Promise<void>((resolve) => {
          releaseEnsure = resolve;
        });
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        };
      });

      let releaseRun: (() => void) | undefined;
      runtimeState.runTurn.mockImplementation(async function* () {
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        yield { type: "done" as const };
      });

      const manager = new AcpSessionManager();
      const events: AcpRuntimeEvent[] = [];
      const runPromise = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "cancel during setup",
        mode: "prompt",
        requestId: "run-cancel-during-setup",
        onEvent: (event) => {
          events.push(event);
        },
      });
      let runSettled = false;
      void runPromise.then(
        () => {
          runSettled = true;
        },
        () => {
          runSettled = true;
        },
      );
      await vi.waitFor(
        () => {
          expect(ensureStarted).toBe(true);
        },
        { interval: 1 },
      );

      const cancelPromise = manager.cancelSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        reason: "manual-cancel",
      });
      const cancelOutcome = await Promise.race([
        cancelPromise.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => {
          setTimeout(() => resolve("pending"), 100);
        }),
      ]);

      releaseEnsure?.();
      await vi.waitFor(
        () => {
          expect(runSettled || runtimeState.runTurn.mock.calls.length > 0).toBe(true);
        },
        { interval: 1 },
      );
      if (runtimeState.runTurn.mock.calls.length > 0) {
        releaseRun?.();
      }
      await runPromise;
      await cancelPromise;

      expect(cancelOutcome).toBe("pending");
      expect(runtimeState.runTurn).not.toHaveBeenCalled();
      expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(runtimeState.cancel), {
        reason: "manual-cancel",
      });
      expect(events.at(-1)).toEqual({
        type: "done",
        status: "cancelled",
        stopReason: "manual-cancel",
      });
      expectRecordFields(requireTaskByRunId("run-cancel-during-setup"), {
        status: "cancelled",
      });
      const states = extractStatesFromUpserts();
      expect(states).toContain("idle");
      expect(states).not.toContain("error");
    });
  });

  it("preempts an active turn on cancel and returns to idle state", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: "agent:codex:acp:child-1",
        parentSessionKey: "agent:main:main",
      });

      let enteredRun = false;
      runtimeState.runTurn.mockImplementation(async function* (input: { signal?: AbortSignal }) {
        enteredRun = true;
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            resolve();
            return;
          }
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "done" as const, stopReason: "cancel" };
      });

      const manager = new AcpSessionManager();
      const events: AcpRuntimeEvent[] = [];
      const runPromise = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "long task",
        mode: "prompt",
        requestId: "run-1",
        onEvent: (event) => {
          events.push(event);
        },
      });
      await vi.waitFor(
        () => {
          expect(enteredRun).toBe(true);
        },
        { interval: 1 },
      );

      const queueTurn = (requestId: string) =>
        manager
          .runTurn({
            provenance: "system",
            cfg: baseCfg,
            sessionKey: "agent:codex:acp:child-1",
            text: "queued after active turn",
            mode: "prompt",
            requestId,
          })
          .then(
            () => ({ status: "resolved" as const }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
      const queuedOutcomes = Promise.all([queueTurn("run-queued-2"), queueTurn("run-queued-3")]);

      await manager.cancelSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        reason: "manual-cancel",
      });
      await runPromise;
      const outcomes = await queuedOutcomes;

      expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
      expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
      expectRecordFields(mockCallArg(runtimeState.cancel), {
        reason: "manual-cancel",
      });
      expectRecordFields(requireTaskByRunId("run-1"), {
        ownerKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child-1",
        status: "cancelled",
      });
      expect(events.at(-1)).toEqual({
        type: "done",
        status: "cancelled",
        stopReason: "cancel",
      });
      const states = extractStatesFromUpserts();
      expect(states).toContain("running");
      expect(states).toContain("idle");
      expect(states).not.toContain("error");
    });
  });
});
