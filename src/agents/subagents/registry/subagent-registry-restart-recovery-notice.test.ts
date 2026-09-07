import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import type { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import { restartRecoveryTestHarness } from "./subagent-registry-restart-recovery.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RecoveryParams = Parameters<typeof recoverInterruptedSubagentRow>[0];
type ReplaceRunParams = Parameters<RecoveryParams["replaceRun"]>[0];

const {
  mocks,
  childSessionKey,
  gatewayRuntime,
  dispatchAgent,
  replaceRun,
  clearAcceptedRecovery,
  clearPendingNotice,
  resumeAcceptedRecovery,
  warn,
  run,
  recover,
} = restartRecoveryTestHarness;

describe("subagent registry restart recovery notices", () => {
  beforeEach(() => restartRecoveryTestHarness.reset());

  it("attempts the resumption notice before releasing completion monitoring", async () => {
    const delivery = createDeferred<{ suppressed: boolean }>();
    vi.mocked(gatewayRuntime.sendRecoveryNotice).mockImplementationOnce(() => delivery.promise);
    const entry = run();

    const recovery = recover(entry);
    await vi.waitFor(() => expect(gatewayRuntime.sendRecoveryNotice).toHaveBeenCalledOnce());
    expect(entry.resumptionNotice).toEqual({
      idempotencyKey: expect.stringMatching(/^subagent-recovery:/),
    });
    expect(clearAcceptedRecovery).toHaveBeenCalledOnce();
    expect(resumeAcceptedRecovery).not.toHaveBeenCalled();
    expect(entry.execution.restartRecovery).toBeUndefined();

    delivery.reject(new Error("delivery unavailable"));
    await expect(recovery).resolves.toEqual({ status: "accepted" });

    expect(clearAcceptedRecovery).toHaveBeenCalledOnce();
    expect(resumeAcceptedRecovery).toHaveBeenCalledOnce();
    expect(entry.execution.restartRecovery).toBeUndefined();
    expect(entry.resumptionNotice).toEqual({
      idempotencyKey: expect.stringMatching(/^subagent-recovery:/),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not confirm resumption"),
      expect.objectContaining({ error: expect.any(Error) }),
    );

    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    };

    await expect(recover(entry)).resolves.toEqual({ status: "accepted" });

    expect(gatewayRuntime.sendRecoveryNotice).toHaveBeenCalledTimes(2);
    expect(clearPendingNotice).toHaveBeenCalledOnce();
    expect(clearAcceptedRecovery).toHaveBeenCalledOnce();
    expect(resumeAcceptedRecovery).toHaveBeenCalledTimes(2);
    expect(entry.execution.restartRecovery).toBeUndefined();
    expect(entry.resumptionNotice).toBeUndefined();
  });

  it("keeps non-announcing recovery silent", async () => {
    const entry = run({ expectsCompletionMessage: false });

    await expect(recover(entry)).resolves.toEqual({ status: "accepted" });

    expect(gatewayRuntime.sendRecoveryNotice).not.toHaveBeenCalled();
    expect(clearAcceptedRecovery).toHaveBeenCalledOnce();
    expect(resumeAcceptedRecovery).toHaveBeenCalledOnce();
  });

  it("retains notice debt when outbound delivery is suppressed", async () => {
    vi.mocked(gatewayRuntime.sendRecoveryNotice).mockResolvedValueOnce({ suppressed: true });
    const entry = run();

    await expect(recover(entry)).resolves.toEqual({ status: "accepted" });

    expect(clearAcceptedRecovery).toHaveBeenCalledOnce();
    expect(resumeAcceptedRecovery).toHaveBeenCalledOnce();
    expect(clearPendingNotice).not.toHaveBeenCalled();
    expect(entry.resumptionNotice).toEqual({
      idempotencyKey: expect.stringMatching(/^subagent-recovery:/),
    });
  });

  it("releases terminal cleanup after the resumption notice retry window", async () => {
    vi.mocked(gatewayRuntime.sendRecoveryNotice).mockResolvedValueOnce({ suppressed: true });
    const now = Date.now();
    const entry = run({
      resumptionNotice: { idempotencyKey: "subagent-recovery:notice-debt" },
      execution: {
        status: "terminal",
        startedAt: now - 180_000,
        endedAt: now - 120_000,
        outcome: { status: "ok" },
      },
    });

    await expect(recover(entry, { now })).resolves.toEqual({ status: "accepted" });

    expect(clearPendingNotice).toHaveBeenCalledOnce();
    expect(resumeAcceptedRecovery).toHaveBeenCalledOnce();
    expect(entry.resumptionNotice).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exhausted its resumption notice window"),
      expect.objectContaining({ runId: entry.runId }),
    );
  });

  it.each([
    { label: "confirmed running notice", terminal: false, suppressed: false },
    { label: "expired terminal notice debt", terminal: true, suppressed: true },
  ])(
    "preserves $label when its lifecycle retires during delivery",
    async ({ terminal, suppressed }) => {
      const now = Date.now();
      const pendingNotice = { idempotencyKey: "subagent-recovery:notice-debt" };
      const entry = run({
        resumptionNotice: pendingNotice,
        execution: terminal
          ? {
              status: "terminal",
              startedAt: now - 180_000,
              endedAt: now - 120_000,
              outcome: { status: "ok" },
            }
          : {
              status: "running",
              startedAt: now - 60_000,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            },
      });
      const delivery = createDeferred<{ suppressed: boolean }>();
      vi.mocked(gatewayRuntime.sendRecoveryNotice).mockImplementationOnce(() => delivery.promise);

      const recovery = recover(entry, { now });
      await vi.waitFor(() => expect(gatewayRuntime.sendRecoveryNotice).toHaveBeenCalledOnce());
      const notice = vi.mocked(gatewayRuntime.sendRecoveryNotice).mock.calls[0]![0];
      expect(notice.isCurrent?.()).toBe(true);
      rotateAgentEventLifecycleGeneration();
      expect(notice.isCurrent?.()).toBe(false);
      delivery.resolve({ suppressed });
      await recovery;

      expect(entry.resumptionNotice).toEqual(pendingNotice);
      expect(clearPendingNotice).not.toHaveBeenCalled();
      expect(resumeAcceptedRecovery).not.toHaveBeenCalled();
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );

  it("keeps notice debt from blocking a later restart recovery", async () => {
    vi.mocked(gatewayRuntime.sendRecoveryNotice)
      .mockRejectedValueOnce(new Error("delivery unavailable"))
      .mockRejectedValueOnce(new Error("delivery still unavailable"));
    const entry = run();
    const replacements: SubagentRunRecord[] = [];
    replaceRun.mockImplementation((params: ReplaceRunParams) => {
      const replacement = structuredClone(params.expected ?? entry);
      replacement.runId = params.nextRunId;
      replacement.execution = {
        status: "running",
        startedAt: Date.now(),
        restartRecovery: params.restartRecovery,
      };
      replacements.push(replacement);
      return true;
    });

    const getRun = (runId: string) => replacements.find((candidate) => candidate.runId === runId);
    await expect(recover(entry, { getRun })).resolves.toEqual({ status: "accepted" });
    const firstSuccessor = replacements[0]!;
    const firstRecoveryRunId = firstSuccessor.runId;
    expect(firstSuccessor.execution.restartRecovery).toBeUndefined();
    expect(firstSuccessor.resumptionNotice?.idempotencyKey).toBe(firstRecoveryRunId);
    expect(replaceRun.mock.calls[0]?.[0].restartRecovery).toMatchObject({
      phase: "accepted",
    });

    firstSuccessor.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
    rotateAgentEventLifecycleGeneration();
    mocks.entries[childSessionKey] = {
      sessionId: "session-id-2",
      updatedAt: Date.now() + 1_000,
      abortedLastRun: true,
    };
    await expect(recover(firstSuccessor, { getRun })).resolves.toEqual({ status: "accepted" });

    expect(dispatchAgent).toHaveBeenCalledTimes(2);
    expect(replacements).toHaveLength(2);
    expect(replacements[1]!.runId).not.toBe(firstRecoveryRunId);
    expect(replacements[1]!.execution.restartRecovery).toBeUndefined();
    expect(replacements[1]!.resumptionNotice).toBeUndefined();
    expect(replaceRun.mock.calls[1]?.[0].restartRecovery).toMatchObject({
      phase: "accepted",
    });
    expect(gatewayRuntime.sendRecoveryNotice).toHaveBeenCalledTimes(3);
  });
});
