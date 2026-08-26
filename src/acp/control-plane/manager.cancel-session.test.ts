/** Tests ACP manager cancellation of active turns and idle sessions. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
      const taskDetail = asOptionalRecord(requireTaskByRunId("run-1").detail);
      const instanceId = typeof taskDetail?.instanceId === "string" ? taskDetail.instanceId : "";
      expect(instanceId).not.toBe("");

      await manager.cancelSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        reason: "manual-cancel",
        expectedRunId: "run-1",
        expectedInstanceId: instanceId,
        expectedOwnerKey: "agent:main:main",
      });
      await runPromise;

      expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
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

  it("does not cancel a replacement active turn", async () => {
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
      let releaseRun: (() => void) | undefined;
      runtimeState.runTurn.mockImplementation(async function* () {
        enteredRun = true;
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        yield { type: "done" as const, stopReason: "end_turn" };
      });
      const manager = new AcpSessionManager();
      const runPromise = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "replacement task",
        mode: "prompt",
        requestId: "run-current",
      });
      await vi.waitFor(() => expect(enteredRun).toBe(true), { interval: 1 });
      const taskDetail = asOptionalRecord(requireTaskByRunId("run-current").detail);
      const instanceId = typeof taskDetail?.instanceId === "string" ? taskDetail.instanceId : "";
      expect(instanceId).not.toBe("");

      await expect(
        manager.cancelSession({
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:child-1",
          reason: "foreign-owner-cancel",
          expectedRunId: "run-current",
          expectedInstanceId: instanceId,
          expectedOwnerKey: "agent:main:other",
        }),
      ).rejects.toThrow("ACP task owner could not be verified.");
      expect(runtimeState.cancel).not.toHaveBeenCalled();

      await expect(
        manager.cancelSession({
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:child-1",
          reason: "stale-task-cancel",
          expectedRunId: "run-current",
          expectedInstanceId: "instance-from-prior-turn",
          expectedOwnerKey: "agent:main:main",
        }),
      ).rejects.toThrow("ACP task is no longer the active run.");
      expect(runtimeState.cancel).not.toHaveBeenCalled();

      releaseRun?.();
      await runPromise;
    });
  });
});
