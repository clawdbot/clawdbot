// Subagent registry persistence-resume tests cover restoring SQLite-backed child runs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { closeOpenClawStateDatabaseForTest as closeSeedStateDatabase } from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createSubagentRegistryTestDeps,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => "delivered" as const),
}));
vi.mock("../announce/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));
let mod: typeof import("./subagent-registry.test-helpers.js");
let callGatewayModule: typeof import("../../../gateway/call.js");
let agentEventsModule: typeof import("../../../infra/agent-events.js");
let registryStateDbModule: typeof import("../../../state/openclaw-state-db.js");

function activateRegistry() {
  const recoveryRuntime = {
    dispatchAgent: (params: Record<string, unknown>, timeoutMs?: number) =>
      callGatewayModule.callGateway({ method: "agent", params, timeoutMs }),
    waitForAgent: (params: Record<string, unknown>, timeoutMs?: number) =>
      callGatewayModule.callGateway({ method: "agent.wait", params, timeoutMs }),
    sendRecoveryNotice: vi.fn(),
  };
  mod.activateSubagentRegistry(() => ({ recoveryRuntime }) as never);
}

describe("subagent registry persistence resume", () => {
  let tempStateDir: string | null = null;

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./subagent-registry.test-helpers.js");
    callGatewayModule = await import("../../../gateway/call.js");
    agentEventsModule = await import("../../../infra/agent-events.js");
    registryStateDbModule = await import("../../../state/openclaw-state-db.js");
  });

  beforeEach(() => {
    announceSpy.mockClear();
    vi.mocked(callGatewayModule.callGateway).mockReset().mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    mod.testing.setDepsForTest({
      ...createSubagentRegistryTestDeps({
        callGateway: vi.mocked(callGatewayModule.callGateway),
        captureSubagentCompletionReply: vi.fn(async () => undefined),
      }),
    });
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.mocked(agentEventsModule.onAgentEvent)
      .mockReset()
      .mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    closeSeedStateDatabase();
    registryStateDbModule.closeOpenClawStateDatabaseForTest();
    mod.testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
  });

  it("resumes a persisted run from canonical SQLite state", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    const stateDir = tempStateDir;
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const run: SubagentRunRecord = {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:test",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
        requesterDisplayKey: "main",
        task: "do the thing",
        cleanup: "keep",
        createdAt: Date.now(),
        execution: { status: "running" },
        completion: { required: false },
        delivery: { status: "not_required" },
      };
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: run.childSessionKey,
        sessionId: "sess-test",
        defaultSessionId: "sess-test",
      });

      mod.initSubagentRegistry();
      activateRegistry();

      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      const announce = (announceSpy.mock.calls as unknown as Array<[unknown]>).at(-1)?.[0] as
        | {
            childRunId?: string;
            requesterOrigin?: { channel?: string; accountId?: string };
            outcome?: { status?: string };
          }
        | undefined;
      expect(announce).toMatchObject({
        childRunId: "run-1",
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
        outcome: { status: "ok" },
      });
      expect(mod.listSubagentRunsForRequester("agent:main:main")[0]).toMatchObject({
        childSessionKey: run.childSessionKey,
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
      });
    });
  });

  it("retries pending child delivery before a recovered requester-turn wake", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    const stateDir = tempStateDir;
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const run: SubagentRunRecord = {
        runId: "run-pending-delivery",
        requesterTurnRunId: "run-requester",
        childSessionKey: "agent:main:subagent:pending-delivery",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "deliver before waking requester",
        cleanup: "keep",
        createdAt: 100,
        endedReason: "subagent-complete",
        execution: {
          status: "terminal",
          startedAt: 110,
          endedAt: 200,
          outcome: { status: "ok" },
        },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "done", capturedAt: 200 },
        delivery: {
          status: "pending",
          payload: {
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            childSessionKey: "agent:main:subagent:pending-delivery",
            childRunId: "run-pending-delivery",
            task: "deliver before waking requester",
            startedAt: 110,
            endedAt: 200,
            outcome: { status: "ok" },
            expectsCompletionMessage: true,
          },
        },
        cleanupHandled: false,
      };
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: run.childSessionKey,
        sessionId: "sess-pending-delivery",
        defaultSessionId: "sess-pending-delivery",
      });

      mod.initSubagentRegistry();
      activateRegistry();

      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      expect(announceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ childRunId: "run-pending-delivery" }),
      );
    });
  });

  it("keeps restored recovery dormant until the Gateway lifecycle activates it", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    const stateDir = tempStateDir;
    const wakeRequester = vi.fn(async () => false);
    mod.testing.setDepsForTest({
      ...createSubagentRegistryTestDeps({
        callGateway: vi.mocked(callGatewayModule.callGateway),
        maybeWakeRequesterAfterAllChildrenSettled: wakeRequester,
      }),
    });

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const endedAt = Date.now();
      const yieldedRun: SubagentRunRecord = {
        runId: "run-hydrated-yield",
        taskRunId: "run-hydrated-yield",
        requesterTurnRunId: "run-requester",
        requesterTurnYielded: true,
        childSessionKey: "agent:main:subagent:hydrated-yield",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "wake only after lifecycle activation",
        cleanup: "keep",
        createdAt: endedAt - 1_000,
        endedReason: "subagent-complete",
        execution: {
          status: "terminal",
          startedAt: endedAt - 500,
          endedAt,
          outcome: { status: "ok" },
        },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "done", capturedAt: endedAt },
        delivery: { status: "delivered", deliveredAt: endedAt },
        cleanupHandled: true,
        cleanupCompletedAt: endedAt,
      };
      const queuedCollector: SubagentRunRecord = {
        runId: "run-hydrated-collector",
        childSessionKey: "agent:main:subagent:hydrated-collector",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "clean only after lifecycle activation",
        cleanup: "keep",
        createdAt: endedAt - 500,
        collect: true,
        swarmRequesterSessionKey: "agent:main:main",
        groupId: "hydrated-group",
        archiveAtMs: endedAt - 1,
        execution: {
          status: "terminal",
          startedAt: endedAt - 400,
          endedAt,
          outcome: { status: "error", error: "launch failed" },
        },
        completion: { required: true },
        delivery: { status: "pending" },
        collectorCompletion: { status: "failed" },
        collectorLaunchCleanupPending: true,
      };
      const runningRun: SubagentRunRecord = {
        runId: "run-hydrated-running",
        childSessionKey: "agent:main:subagent:hydrated-running",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "wait through the activated instance",
        cleanup: "keep",
        createdAt: endedAt,
        execution: { status: "running", startedAt: endedAt },
        completion: { required: false },
        delivery: { status: "not_required" },
      };
      saveSubagentRegistryToSqlite(
        new Map([
          [yieldedRun.runId, yieldedRun],
          [queuedCollector.runId, queuedCollector],
          [runningRun.runId, runningRun],
        ]),
      );
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: yieldedRun.childSessionKey,
        sessionId: "sess-hydrated-yield",
        defaultSessionId: "sess-hydrated-yield",
      });
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: queuedCollector.childSessionKey,
        sessionId: "sess-hydrated-collector",
        defaultSessionId: "sess-hydrated-collector",
        lifecycleRevision: "revision-hydrated-collector",
      });
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: runningRun.childSessionKey,
        sessionId: "sess-hydrated-running",
        defaultSessionId: "sess-hydrated-running",
      });

      mod.initSubagentRegistry();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(mod.getSubagentRunByRunId(yieldedRun.runId)).toBeDefined();
      expect(mod.getSubagentRunByRunId(queuedCollector.runId)).toBeDefined();
      expect(mod.getSubagentRunByRunId(runningRun.runId)).toBeDefined();
      expect(wakeRequester).not.toHaveBeenCalled();
      expect(callGatewayModule.callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.delete" }),
      );

      const recoveryRuntime = {
        dispatchAgent: vi.fn(),
        waitForAgent: vi.fn(async () => ({ status: "pending" })),
        sendRecoveryNotice: vi.fn(),
      };
      let firstLifecycleOpen = true;
      const resolveGatewayContext = vi.fn(() =>
        firstLifecycleOpen ? ({ recoveryRuntime } as never) : undefined,
      );
      mod.activateSubagentRegistry(resolveGatewayContext);
      mod.activateSubagentRegistry(resolveGatewayContext);

      await vi.waitFor(() => {
        expect(wakeRequester).toHaveBeenCalledOnce();
        expect(recoveryRuntime.waitForAgent).toHaveBeenCalledOnce();
      });
      expect(recoveryRuntime.dispatchAgent).not.toHaveBeenCalled();
      expect(callGatewayModule.callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "agent.wait" }),
      );

      firstLifecycleOpen = false;
      expect(resolveGatewayContext()).toBeUndefined();
      const replacementRuntime = {
        dispatchAgent: vi.fn(),
        waitForAgent: vi.fn(async () => ({ status: "pending" })),
        sendRecoveryNotice: vi.fn(),
      };
      const resolveReplacementContext = () => ({ recoveryRuntime: replacementRuntime }) as never;
      mod.activateSubagentRegistry(resolveReplacementContext);
      mod.activateSubagentRegistry(resolveReplacementContext);
      expect(wakeRequester).toHaveBeenCalledOnce();
      expect(recoveryRuntime.waitForAgent).toHaveBeenCalledOnce();
      expect(replacementRuntime.waitForAgent).not.toHaveBeenCalled();

      await mod.testing.runSweeperTickForTests();
      expect(callGatewayModule.callGateway).toHaveBeenCalledTimes(1);
      expect(callGatewayModule.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            expectedSessionId: "sess-hydrated-collector",
            expectedLifecycleRevision: "revision-hydrated-collector",
          }),
        }),
      );
    });
  });

  it("keeps dismissed terminal delivery dormant and TTL-eligible after restore", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    const stateDir = tempStateDir;
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const now = Date.now();
      const run: SubagentRunRecord = {
        runId: "run-dismissed-delivery",
        childSessionKey: "agent:main:subagent:dismissed-delivery",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "retain no delivery obligation",
        cleanup: "keep",
        createdAt: now - 10 * 60_000,
        endedReason: "subagent-complete",
        execution: {
          status: "terminal",
          startedAt: now - 9 * 60_000,
          endedAt: now - 8 * 60_000,
          outcome: { status: "ok" },
        },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "done", capturedAt: now - 8 * 60_000 },
        delivery: {
          status: "discarded",
          disposition: "intentional_non_delivery",
          dismissedAt: now - 6 * 60_000,
        },
        cleanupHandled: true,
        cleanupCompletedAt: now - 6 * 60_000,
      };
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      mod.initSubagentRegistry();
      await mod.testing.sweepOnceForTests();

      expect(announceSpy).not.toHaveBeenCalled();
      expect(mod.getSubagentRunByRunId(run.runId)).toBeUndefined();
    });
  });

  it.each([false, true])(
    "settles a restored steered requester turn (yielded: %s)",
    async (requesterYielded) => {
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
      const stateDir = tempStateDir;
      const wakeRequester = vi.fn(async () => false);
      mod.testing.setDepsForTest({
        ...createSubagentRegistryTestDeps({
          callGateway: vi.mocked(callGatewayModule.callGateway),
          maybeWakeRequesterAfterAllChildrenSettled: wakeRequester,
        }),
      });

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const endedAt = Date.now();
        const run: SubagentRunRecord = {
          runId: "run-steered",
          taskRunId: "run-original",
          requesterTurnRunId: "run-requester",
          ...(requesterYielded ? { requesterTurnYielded: true } : {}),
          childSessionKey: "agent:main:subagent:steered",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "deliver the steered result",
          cleanup: "keep",
          createdAt: endedAt - 1_000,
          endedReason: "subagent-complete",
          execution: {
            status: "terminal",
            startedAt: endedAt - 500,
            endedAt,
            outcome: { status: "ok" },
          },
          expectsCompletionMessage: true,
          completion: { required: true, resultText: "done", capturedAt: endedAt },
          delivery: { status: "delivered", deliveredAt: endedAt },
          cleanupHandled: true,
          cleanupCompletedAt: endedAt,
        };
        saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
        await writeSubagentSessionEntry({
          stateDir,
          agentId: "main",
          sessionKey: run.childSessionKey,
          sessionId: "sess-steered",
          defaultSessionId: "sess-steered",
        });

        mod.initSubagentRegistry();
        activateRegistry();

        const restored = mod.getSubagentRunByRunId(run.runId);
        expect(restored).toMatchObject({ runId: run.runId, taskRunId: run.taskRunId });
        expect(restored?.requesterTurnRunId).toBeUndefined();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.requesterTurnRunId).toBeUndefined();

        if (requesterYielded) {
          expect(restored?.requesterSettleWake).toMatchObject({
            batchRunIds: [run.runId],
            requesterYieldBatch: true,
            afterRequesterYield: true,
          });
          await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledOnce(), {
            timeout: 1_000,
            interval: 10,
          });
        } else {
          expect(restored?.requesterSettleWake).toBeUndefined();
          expect(wakeRequester).not.toHaveBeenCalled();
        }
      });
    },
  );
});
