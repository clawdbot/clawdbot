// Subagent registry persistence-resume tests cover restoring SQLite-backed child runs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isPathInside } from "../../../infra/path-guards.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { listOpenClawAgentDatabasesForTest as listSeedAgentDatabases } from "../../../state/openclaw-agent-db.js";
import "./subagent-registry.mocks.shared.js";
import { closeOpenClawStateDatabaseForTest as closeSeedStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  createSubagentRegistryTestDeps,
  gateSubagentRequesterSettlement,
  settleSubagentRegistryPersistenceWork,
  withSubagentRegistryPersistenceState,
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
let registryDepsModule: typeof import("./subagent-registry-deps.js");
let registrySessionCleanupModule: typeof import("../../../test-utils/session-state-cleanup.js");
let registryAgentDbModule: typeof import("../../../state/openclaw-agent-db.js");
let registryStateDbModule: typeof import("../../../state/openclaw-state-db.js");

function listFixtureAgentDatabases(listDatabases: typeof listSeedAgentDatabases, stateDir: string) {
  return listDatabases().filter((database) => isPathInside(stateDir, database.path));
}

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

function createOrphanedRequiredDelivery(
  status: "pending" | "suspended" | "in_progress",
): SubagentRunRecord {
  const now = Date.now();
  const runId = `run-orphan-${status}-delivery`;
  const childSessionKey = `agent:main:subagent:orphan-${status}-delivery`;
  const terminalReply = { disposition: "visible" as const, text: "durable final reply" };
  return {
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "deliver after restart",
    cleanup: "delete",
    createdAt: now - 100,
    expectsCompletionMessage: true,
    cleanupHandled: false,
    execution: {
      status: "terminal",
      startedAt: now - 50,
      endedAt: now,
      outcome: { status: "ok" },
    },
    completion: {
      required: true,
      resultText: "canonical final reply",
      capturedAt: now,
      terminalReply,
    },
    delivery: {
      status,
      ...(status === "suspended" ? { suspendedAt: now, suspendedReason: "expiry" as const } : {}),
      ...(status === "in_progress"
        ? { disposition: "session_queued" as const, queueId: "queue-1" }
        : {}),
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey,
        childRunId: runId,
        task: "deliver after restart",
        startedAt: now - 50,
        endedAt: now,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        terminalReply,
      },
    },
  };
}

describe("subagent registry persistence resume", () => {
  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./subagent-registry.test-helpers.js");
    callGatewayModule = await import("../../../gateway/call.js");
    agentEventsModule = await import("../../../infra/agent-events.js");
    registryStateDbModule = await import("../../../state/openclaw-state-db.js");
    registryDepsModule = await import("./subagent-registry-deps.js");
    registryAgentDbModule = await import("../../../state/openclaw-agent-db.js");
    registrySessionCleanupModule = await import("../../../test-utils/session-state-cleanup.js");
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

  const withRegistryState = <T>(stateDir: string, run: () => Promise<T>) =>
    withSubagentRegistryPersistenceState(
      {
        stateDir,
        resetRegistry: () => mod.resetSubagentRegistryForTests({ persist: false }),
        resetDeps: () => mod.testing.setDepsForTest(),
        closeDatabases: async () => {
          // The resumed registry owns a separate agent-DB cache after resetModules.
          // Agent cleanup releases leases through state DB writes, so close state DBs last.
          await registrySessionCleanupModule.cleanupSessionStateForTest({ stateDir });
          expect(
            listFixtureAgentDatabases(listSeedAgentDatabases, stateDir),
            "seed agent handles closed before fixture removal",
          ).toEqual([]);
          expect(
            listFixtureAgentDatabases(
              registryAgentDbModule.listOpenClawAgentDatabasesForTest,
              stateDir,
            ),
            "post-reset agent handles closed before fixture removal",
          ).toEqual([]);
          closeSeedStateDatabase();
          registryStateDbModule.closeOpenClawStateDatabaseForTest();
        },
      },
      run,
    );

  it.each([
    { name: "announcing", expectsCompletionMessage: true },
    { name: "nonannouncing", expectsCompletionMessage: false },
    { name: "unspecified completion" },
    { name: "collector", expectsCompletionMessage: false, collect: true },
  ])("preserves the registered parent turn through SQLite reopen: $name", async (options) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    await withRegistryState(stateDir, async () => {
      vi.mocked(callGatewayModule.callGateway).mockImplementation(() => new Promise(() => {}));
      const { name, ...registration } = options;
      const childSessionKey = "agent:main:subagent:parent-association";
      mod.registerSubagentRun({
        runId: "child-parent-association",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterTurnRunId: "  parent-turn  ",
        requesterDisplayKey: "main",
        task: name,
        cleanup: "keep",
        ...registration,
      });
      const expected = {
        requesterTurnRunId: "parent-turn",
        completion: { required: registration.expectsCompletionMessage === true },
        delivery: {
          status: registration.expectsCompletionMessage === false ? "not_required" : "pending",
        },
      };
      const registered = mod.getSubagentRunByChildSessionKey(childSessionKey);
      expect(registered).toMatchObject(expected);
      expect(registered?.expectsCompletionMessage).toBe(registration.expectsCompletionMessage);
      registryStateDbModule.closeOpenClawStateDatabaseForTest();
      const restored = loadSubagentRegistryFromSqlite().get("child-parent-association");
      expect(restored).toMatchObject(expected);
      expect(restored?.expectsCompletionMessage).toBe(registration.expectsCompletionMessage);
    });
  });

  it("resumes a persisted run from canonical SQLite state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    await withRegistryState(stateDir, async () => {
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
      await settleSubagentRegistryPersistenceWork();
      expect(
        listFixtureAgentDatabases(listSeedAgentDatabases, stateDir),
        "seed session write acquired an agent handle",
      ).toHaveLength(1);
      expect(
        listFixtureAgentDatabases(
          registryAgentDbModule.listOpenClawAgentDatabasesForTest,
          stateDir,
        ),
        "resumed completion timing acquired a post-reset agent handle",
      ).toHaveLength(1);
    });
  });

  it.each([
    { label: "successful", status: "ok" as const },
    { label: "timed-out", status: "timeout" as const },
  ])("retries pending $label child delivery after restart", async ({ label, status }) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    await withRegistryState(stateDir, async () => {
      const runId = `run-pending-${label}-delivery`;
      const childSessionKey = `agent:main:subagent:pending-${label}-delivery`;
      const run: SubagentRunRecord = {
        runId,
        requesterTurnRunId: "run-requester",
        childSessionKey,
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
          outcome: { status },
        },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "done", capturedAt: 200 },
        delivery: {
          status: "pending",
          payload: {
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            childSessionKey,
            childRunId: runId,
            task: "deliver before waking requester",
            startedAt: 110,
            endedAt: 200,
            outcome: { status },
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
        sessionId: `sess-pending-${label}-delivery`,
        defaultSessionId: `sess-pending-${label}-delivery`,
      });

      mod.initSubagentRegistry();
      activateRegistry();

      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      expect(announceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ childRunId: runId, outcome: { status } }),
      );
      expect(mod.getSubagentRunByRunId(runId)?.execution.outcome).toEqual({ status });
    });
  });

  it("replays one required completion after restart without the child session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    await withRegistryState(stateDir, async () => {
      const run = createOrphanedRequiredDelivery("pending");
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      const settlement = gateSubagentRequesterSettlement(
        registryDepsModule.subagentRegistryDeps.maybeWakeRequesterAfterAllChildrenSettled,
      );
      mod.testing.setDepsForTest({
        ...registryDepsModule.subagentRegistryDeps,
        maybeWakeRequesterAfterAllChildrenSettled: settlement.run,
      });
      try {
        mod.initSubagentRegistry();
        activateRegistry();
        await vi.waitFor(
          () =>
            expect(settlement.run, "replay reached requester settlement").toHaveBeenCalledOnce(),
          {
            timeout: 5_000,
            interval: 10,
          },
        );
        expect(announceSpy, "replayed announcement delivered").toHaveBeenCalledOnce();
        expect(
          loadSubagentRegistryFromSqlite().get(run.runId),
          "delivered row awaits real settlement",
        ).toMatchObject({
          delivery: { status: "delivered" },
          requesterSettleWake: { retireAfterSettle: true },
        });
        expect(announceSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            childSessionKey: run.childSessionKey,
            childRunId: run.runId,
            requesterSessionKey: "agent:main:main",
            roundOneReply: "canonical final reply",
            terminalReply: run.completion?.terminalReply,
            outcome: { status: "ok" },
          }),
        );
        await settlement.release();
        expect(settlement.run).toHaveBeenCalledOnce();
        expect(
          loadSubagentRegistryFromSqlite().has(run.runId),
          "settlement retired delivered row",
        ).toBe(false);
        await settleSubagentRegistryPersistenceWork();

        mod.resetSubagentRegistryForTests({ persist: false });
        mod.initSubagentRegistry();
        activateRegistry();
        await settleSubagentRegistryPersistenceWork();
        expect(announceSpy, "retired completion is not replayed again").toHaveBeenCalledOnce();
      } finally {
        await settlement.release();
      }
    });
  });

  it.each([
    { status: "suspended" as const, disposition: undefined, queueId: undefined },
    { status: "in_progress" as const, disposition: "session_queued" as const, queueId: "queue-1" },
  ])("retains $status required delivery with its owner after restart", async (expected) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    await withRegistryState(stateDir, async () => {
      const run = createOrphanedRequiredDelivery(expected.status);
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      mod.initSubagentRegistry();
      activateRegistry();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(announceSpy).not.toHaveBeenCalled();
      expect(loadSubagentRegistryFromSqlite().get(run.runId)?.delivery).toMatchObject({
        status: expected.status,
        ...(expected.disposition ? { disposition: expected.disposition } : {}),
        ...(expected.queueId ? { queueId: expected.queueId } : {}),
      });
    });
  });

  it("keeps restored recovery dormant until the Gateway lifecycle activates it", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    const wakeRequester = vi.fn(async () => false);
    mod.testing.setDepsForTest({
      ...createSubagentRegistryTestDeps({
        callGateway: vi.mocked(callGatewayModule.callGateway),
        maybeWakeRequesterAfterAllChildrenSettled: wakeRequester,
      }),
    });

    await withRegistryState(stateDir, async () => {
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
      const gatewayContext = {
        recoveryRuntime,
        resolveGatewayContext: vi.fn(),
      };
      gatewayContext.resolveGatewayContext.mockImplementation(() =>
        firstLifecycleOpen ? (gatewayContext as never) : undefined,
      );
      const resolveGatewayContext = vi.fn(() => gatewayContext as never);
      mod.activateSubagentRegistry(resolveGatewayContext);
      mod.activateSubagentRegistry(resolveGatewayContext);
      const restoredRun = mod.getSubagentRunByRunId(runningRun.runId);
      expect(restoredRun).toBeDefined();
      const restoredGatewayContextResolver = getGatewayContextResolver(restoredRun!);
      expect(restoredGatewayContextResolver).toBeDefined();
      expect(restoredGatewayContextResolver).not.toBe(resolveGatewayContext);
      expect(restoredGatewayContextResolver?.()).toBe(gatewayContext);

      await vi.waitFor(() => {
        expect(wakeRequester).toHaveBeenCalledOnce();
        expect(recoveryRuntime.waitForAgent).toHaveBeenCalledOnce();
      });
      expect(recoveryRuntime.dispatchAgent).not.toHaveBeenCalled();
      expect(callGatewayModule.callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "agent.wait" }),
      );

      firstLifecycleOpen = false;
      expect(resolveGatewayContext()).toBe(gatewayContext);
      expect(gatewayContext.resolveGatewayContext()).toBeUndefined();
      expect(restoredGatewayContextResolver?.()).toBeUndefined();
      const replacementRuntime = {
        dispatchAgent: vi.fn(),
        waitForAgent: vi.fn(async () => ({ status: "pending" })),
        sendRecoveryNotice: vi.fn(),
      };
      const resolveReplacementContext = () => ({ recoveryRuntime: replacementRuntime }) as never;
      mod.activateSubagentRegistry(resolveReplacementContext);
      mod.activateSubagentRegistry(resolveReplacementContext);
      expect(getGatewayContextResolver(restoredRun!)).toBe(restoredGatewayContextResolver);
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
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    await withRegistryState(stateDir, async () => {
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
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
      const wakeRequester = vi.fn(async () => false);
      mod.testing.setDepsForTest({
        ...createSubagentRegistryTestDeps({
          callGateway: vi.mocked(callGatewayModule.callGateway),
          maybeWakeRequesterAfterAllChildrenSettled: wakeRequester,
        }),
      });

      await withRegistryState(stateDir, async () => {
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
        const nonannouncing: SubagentRunRecord[] = [];
        for (const collect of [false, true]) {
          nonannouncing.push({
            ...run,
            runId: `run-nonannouncing-${collect}`,
            taskRunId: `run-nonannouncing-${collect}`,
            childSessionKey: `agent:main:subagent:nonannouncing-${collect}`,
            expectsCompletionMessage: false,
            requesterTurnYielded: undefined,
            collect,
            completion: { required: false, resultText: "quiet result", capturedAt: endedAt },
            delivery: { status: "not_required" },
            ...(collect ? { collectorCompletion: { status: "done" } } : {}),
          });
        }
        saveSubagentRegistryToSqlite(
          new Map([run, ...nonannouncing].map((entry) => [entry.runId, entry])),
        );
        for (const entry of [run, ...nonannouncing]) {
          await writeSubagentSessionEntry({
            stateDir,
            agentId: "main",
            sessionKey: entry.childSessionKey,
            sessionId: `sess-${entry.runId}`,
            defaultSessionId: `sess-${entry.runId}`,
          });
        }

        mod.initSubagentRegistry();
        activateRegistry();

        const restored = mod.getSubagentRunByRunId(run.runId);
        expect(restored).toMatchObject({ runId: run.runId, taskRunId: run.taskRunId });
        expect(restored?.requesterTurnRunId).toBeUndefined();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.requesterTurnRunId).toBeUndefined();
        for (const sibling of nonannouncing) {
          expect(mod.getSubagentRunByRunId(sibling.runId)).toMatchObject({
            requesterTurnRunId: "run-requester",
            delivery: { status: "not_required" },
          });
          expect(mod.getSubagentRunByRunId(sibling.runId)?.requesterSettleWake).toBeUndefined();
        }

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
