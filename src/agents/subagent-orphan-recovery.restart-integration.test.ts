// Restart-path proof against the real registry sweeper and SQLite session store.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveAgentIdFromSessionKey, resolveSessionStorePathCore } from "../config/sessions.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  consumeSessionWorkAdmissionHandoff,
  type SessionWorkAdmissionLease,
} from "../sessions/session-lifecycle-admission.js";
import { createRunningTaskRun } from "../tasks/detached-task-runtime.js";
import { findTaskByRunId } from "../tasks/task-registry.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { captureEnv } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "./subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagents/registry/subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagents/registry/subagent-registry-state.js";
import {
  createCanonicalSubagentRunFixture,
  createSubagentRegistryTestDeps,
  readSubagentSessionStore,
  writeSubagentSessionEntry,
} from "./subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagents/registry/subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
  testing,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";

function consumeRecoveryAdmission(payload: Record<string, unknown>): SessionWorkAdmissionLease {
  const sessionKey = String(payload.sessionKey);
  const sessionId = String(payload.expectedExistingSessionId);
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const scope = resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId });
  const admission = consumeSessionWorkAdmissionHandoff({
    handoffId: String(payload.internalRuntimeHandoffId),
    scope,
    identities: [sessionKey, sessionId],
    onInterrupt: () => undefined,
  });
  if (!admission) {
    throw new Error("expected recovery dispatch to consume its session admission handoff");
  }
  return admission;
}

async function acceptRecoveryDispatch(payload: Record<string, unknown>) {
  consumeRecoveryAdmission(payload).release();
  return {
    runId: String(payload.idempotencyKey),
    status: "accepted",
  };
}

const dispatchAgent = vi.fn(acceptRecoveryDispatch);
const gatewayRuntime: GatewayRecoveryRuntime = {
  dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
  waitForAgent: vi.fn(),
  sendRecoveryNotice: vi.fn(),
};

vi.mock("../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

function makeRunRecord(overrides: Partial<SubagentRunRecordOverrides>): SubagentRunRecord {
  return createCanonicalSubagentRunFixture(
    createSubagentRunRecord({
      runId: "run",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "restart-recoverable work",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
      ...overrides,
    }),
  );
}

describe("subagent orphan recovery — faithful restart path", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orphan-integ-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    setRuntimeConfigSnapshot({ session: { store: undefined } } as never);
    // Real registry wiring: only the delivery/announce/cleanup seams (true
    // external side effects) are recorded so completeSubagentRun runs in-process.
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      getGatewayRecoveryRuntime: () => gatewayRuntime,
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
    });
    dispatchAgent.mockReset();
    dispatchAgent.mockImplementation(acceptRecoveryDispatch);
  });

  afterEach(async () => {
    testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("finalizes a stale (>2h) aborted run instead of resuming it", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-aborted";
    const runId = "run-stale-aborted";
    const storePath = await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-stale-aborted",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-stale-aborted",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      createdAt: now - 3 * TWO_HOURS_MS,
      startedAt: now - 3 * TWO_HOURS_MS,
    });
    expect(
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: record.requesterSessionKey,
        scopeKind: "session",
        childSessionKey,
        runId,
        task: record.task,
        deliveryStatus: "pending",
        startedAt: record.execution.startedAt,
        lastEventAt: record.execution.startedAt,
      }),
    ).not.toBeNull();
    addSubagentRunForTests(record);

    await testing.sweepOnceForTests();

    const after = getSubagentRunByChildSessionKey(childSessionKey);
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(after?.execution.endedAt).toBeTypeOf("number");
    expect(after?.execution.outcome?.status).toBe("error");
    expect(findTaskByRunId(runId)).toMatchObject({
      status: "failed",
      endedAt: expect.any(Number),
      error: expect.stringContaining("stale aborted subagent run not resumed"),
    });

    resetTaskRegistryForTests({ persist: false });
    expect(findTaskByRunId(runId)).toMatchObject({ status: "failed" });
    await cleanupSessionStateForTest();
    const persistedSession = (await readSubagentSessionStore(storePath))[childSessionKey];
    expect(persistedSession).toMatchObject({
      status: "failed",
      endedAt: expect.any(Number),
    });
    expect(persistedSession?.abortedLastRun).toBeUndefined();
  });

  it("resumes a fresh (<2h) aborted run through the real recovery pass", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:fresh-aborted";
    const runId = "run-fresh-aborted";
    await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-fresh-aborted",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-fresh-aborted",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    addSubagentRunForTests(record);

    await testing.sweepOnceForTests();

    console.log(`[proof] fresh recovery: runtimeDispatches=${dispatchAgent.mock.calls.length}`);

    // Fresh aborted run passed the stale gate and reached the instance-owned dispatcher.
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(dispatchAgent.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: childSessionKey,
      lane: "subagent",
      deliver: false,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe(
      String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey),
    );
  });

  it("preserves an accepted response across a consumed-receipt write failure", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:consumed-write-failure";
    const runId = "run-consumed-write-failure";
    await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-consumed-write-failure",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-consumed-write-failure",
    });
    addSubagentRunForTests(
      makeRunRecord({
        runId,
        childSessionKey,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
      }),
    );

    let strictWriteCount = 0;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      getGatewayRecoveryRuntime: () => gatewayRuntime,
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
      persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
        strictWriteCount += 1;
        if (strictWriteCount === 3) {
          throw new Error("consumed receipt write failed");
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      },
    });

    await testing.sweepOnceForTests();

    expect(dispatchAgent).toHaveBeenCalledOnce();
    const acceptedKey = String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey);
    const successor = getSubagentRunByChildSessionKey(childSessionKey);
    expect(successor?.runId).toBe(acceptedKey);
    expect(successor?.execution.restartRecovery).toBeUndefined();
    expect(
      loadSubagentRegistryFromSqlite().get(acceptedKey)?.execution.restartRecovery,
    ).toBeUndefined();
  });

  it("never replays an attempted recovery after acceptance response loss and cold restore", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:lost-acceptance";
    const runId = "run-lost-acceptance";
    const storePath = await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-lost-acceptance",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-lost-acceptance",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      generation: 1,
      collect: true,
      outputSchema: { type: "object" },
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    addSubagentRunForTests(record);

    let acceptedKey = "";
    let acceptedAdmission: SessionWorkAdmissionLease | undefined;
    dispatchAgent.mockImplementationOnce(async (payload) => {
      acceptedKey = String(payload.idempotencyKey);
      acceptedAdmission = consumeSessionWorkAdmissionHandoff({
        handoffId: String(payload.internalRuntimeHandoffId),
        scope: storePath,
        identities: [childSessionKey, "sess-lost-acceptance"],
        onInterrupt: () => undefined,
      });
      expect(acceptedAdmission).toBeDefined();
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        execution: {
          restartRecovery: {
            sessionId: "sess-lost-acceptance",
            sessionMarker: `sess-lost-acceptance:${now}`,
            idempotencyKey: acceptedKey,
            phase: "attempted",
          },
        },
        swarmLaunchIdempotencyKey: acceptedKey,
        swarmLaunchPending: true,
      });
      throw new Error("response lost after gateway acceptance");
    });

    await testing.sweepOnceForTests();

    expect(acceptedKey).toMatch(/^subagent-recovery:[a-f0-9]{64}$/);
    let admissionReleased = false;
    void acceptedAdmission?.released.then(() => {
      admissionReleased = true;
    });
    await Promise.resolve();
    expect(admissionReleased).toBe(false);
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      execution: {
        restartRecovery: {
          sessionId: "sess-lost-acceptance",
          sessionMarker: `sess-lost-acceptance:${now}`,
          idempotencyKey: acceptedKey,
          phase: "consumed",
        },
      },
    });

    resetSubagentRegistryForTests({ persist: false });
    acceptedAdmission?.release();
    rotateAgentEventLifecycleGeneration();
    initSubagentRegistry();
    const restored = subagentRuns.get(runId);
    expect(restored?.execution.restartRecovery).toMatchObject({
      sessionMarker: `sess-lost-acceptance:${now}`,
      idempotencyKey: acceptedKey,
      phase: "consumed",
    });

    await testing.sweepOnceForTests();

    const dispatchedKeys = dispatchAgent.mock.calls.map(([payload]) =>
      String(payload.idempotencyKey),
    );
    expect(dispatchedKeys).toEqual([acceptedKey]);
    expect(subagentRuns.get(runId)).toMatchObject({
      execution: {
        status: "terminal",
        outcome: {
          status: "error",
          error: expect.stringContaining("retired Gateway lifecycle"),
        },
        restartRecovery: undefined,
        suppressSessionEffects: true,
      },
    });
    const preservedSession = (await readSubagentSessionStore(storePath))[childSessionKey];
    expect(preservedSession).toMatchObject({ abortedLastRun: true });
    expect(preservedSession?.status).toBeUndefined();
  });

  it("settles the accepted source before durable remap and clears the successor receipt", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:successor-write-failure";
    const runId = "run-successor-write-failure";
    const storePath = await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-successor-write-failure",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-successor-write-failure",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    addSubagentRunForTests(record);

    let strictWriteCount = 0;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      getGatewayRecoveryRuntime: () => gatewayRuntime,
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
      persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
        strictWriteCount += 1;
        if (strictWriteCount === 5) {
          throw new Error("successor write failed");
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      },
    });
    dispatchAgent.mockImplementationOnce(acceptRecoveryDispatch);

    await testing.sweepOnceForTests();

    const acceptedKey = String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey);
    expect(subagentRuns.get(runId)).toMatchObject({
      execution: {
        restartRecovery: {
          idempotencyKey: acceptedKey,
          phase: "accepted",
        },
      },
    });
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      execution: {
        restartRecovery: {
          idempotencyKey: acceptedKey,
          phase: "accepted",
        },
      },
    });
    expect(subagentRuns.has(acceptedKey)).toBe(false);
    expect(loadSubagentRegistryFromSqlite().has(acceptedKey)).toBe(false);
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });

    resetSubagentRegistryForTests({ persist: false });
    const callGatewayRequests = vi.fn(async (_request: CallGatewayOptions) => ({
      status: "pending",
    }));
    const callGateway = async <T = Record<string, unknown>>(
      request: CallGatewayOptions,
    ): Promise<T> => (await callGatewayRequests(request)) as unknown as T;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      callGateway,
      getGatewayRecoveryRuntime: () => gatewayRuntime,
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
    });
    initSubagentRegistry();
    await Promise.resolve();
    expect(
      callGatewayRequests.mock.calls.some(
        ([request]) =>
          request.method === "agent.wait" &&
          (request.params as { runId?: unknown } | undefined)?.runId === runId,
      ),
    ).toBe(false);
    expect(subagentRuns.get(runId)?.execution.restartRecovery).toMatchObject({
      idempotencyKey: acceptedKey,
      phase: "accepted",
    });
    await testing.sweepOnceForTests();

    expect(dispatchAgent.mock.calls.map(([payload]) => String(payload.idempotencyKey))).toEqual([
      acceptedKey,
    ]);
    const successor = getSubagentRunByChildSessionKey(childSessionKey);
    expect(successor?.runId).toBe(acceptedKey);
    expect(successor?.execution.restartRecovery).toBeUndefined();
    expect(
      loadSubagentRegistryFromSqlite().get(acceptedKey)?.execution.restartRecovery,
    ).toBeUndefined();
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: false,
    });
  });

  it("preserves a newer restart marker when cold-restoring a retired accepted receipt", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:retired-accepted";
    const runId = "run-retired-accepted";
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const storePath = await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-retired-accepted",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-retired-accepted",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      execution: {
        status: "interrupted",
        startedAt: now - 55_000,
        restartRecovery: {
          sessionId: "sess-retired-accepted",
          sessionMarker: "sess-retired-accepted:1",
          idempotencyKey: "subagent-recovery:retired-accepted",
          phase: "accepted",
          lifecycleGeneration: priorLifecycleGeneration,
        },
      },
    });
    addSubagentRunForTests(record);
    persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);

    resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      getGatewayRecoveryRuntime: () => gatewayRuntime,
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
    });
    initSubagentRegistry();
    await Promise.resolve();
    await testing.sweepOnceForTests();

    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(subagentRuns.get(runId)).toMatchObject({
      execution: {
        status: "terminal",
        outcome: {
          status: "error",
          error: expect.stringContaining("retired Gateway lifecycle"),
        },
      },
    });
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });
    const persisted = loadSubagentRegistryFromSqlite().get(runId);
    expect(persisted).toMatchObject({
      execution: {
        status: "terminal",
        suppressSessionEffects: true,
      },
    });
    expect(persisted?.execution.restartRecovery).toBeUndefined();

    resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    initSubagentRegistry();
    await Promise.resolve();
    await testing.sweepOnceForTests();

    const restoredAgain = subagentRuns.get(runId);
    expect(restoredAgain).toMatchObject({
      execution: {
        status: "terminal",
        suppressSessionEffects: true,
      },
    });
    expect(restoredAgain?.execution.restartRecovery).toBeUndefined();
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });
  });

  it("strict-remaps immediately when the accepted receipt write fails", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:accepted-write-failure";
    const runId = "run-accepted-write-failure";
    await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-accepted-write-failure",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-accepted-write-failure",
    });
    addSubagentRunForTests(
      makeRunRecord({
        runId,
        childSessionKey,
        generation: 1,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
      }),
    );

    let strictWriteCount = 0;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      getGatewayRecoveryRuntime: () => gatewayRuntime,
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
      persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
        strictWriteCount += 1;
        if (strictWriteCount === 4) {
          throw new Error("accepted receipt write failed");
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      },
    });
    dispatchAgent.mockImplementationOnce(acceptRecoveryDispatch);

    await testing.sweepOnceForTests();

    const acceptedKey = String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey);
    expect(subagentRuns.has(runId)).toBe(false);
    expect(subagentRuns.get(acceptedKey)).toMatchObject({
      runId: acceptedKey,
      execution: { status: "running", restartRecovery: undefined },
    });
    expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
    const persistedSuccessor = loadSubagentRegistryFromSqlite().get(acceptedKey);
    expect(persistedSuccessor).toMatchObject({
      runId: acceptedKey,
      execution: { status: "running" },
    });
    expect(persistedSuccessor?.execution.restartRecovery).toBeUndefined();
  });

  it("finalizes only a stale predecessor when a fresh generation shares its child session", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-generation";
    const staleRecord = makeRunRecord({
      runId: "run-stale-generation",
      childSessionKey,
      generation: 1,
      createdAt: now - 3 * 60 * 60 * 1_000,
      startedAt: now - 3 * 60 * 60 * 1_000,
      sessionStartedAt: now - 3 * 60 * 60 * 1_000,
    });
    const freshRecord = makeRunRecord({
      runId: "run-fresh-generation",
      childSessionKey,
      generation: 2,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      sessionStartedAt: now - 60_000,
    });
    for (const record of [staleRecord, freshRecord]) {
      expect(
        createRunningTaskRun({
          runtime: "subagent",
          sourceId: record.runId,
          ownerKey: record.requesterSessionKey,
          scopeKind: "session",
          childSessionKey,
          runId: record.runId,
          task: record.task,
          deliveryStatus: "pending",
          startedAt: record.execution.startedAt,
          lastEventAt: record.execution.startedAt,
        }),
      ).not.toBeNull();
    }
    addSubagentRunForTests(staleRecord);
    addSubagentRunForTests(freshRecord);

    await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-shared-generation",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-shared-generation",
    });
    await testing.sweepOnceForTests();

    const runs = listSubagentRunsForRequester("agent:main:main");
    const recoveredRunId = String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey);
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(runs.some((entry) => entry.runId === staleRecord.runId)).toBe(false);
    expect(runs).toContainEqual(expect.objectContaining({ runId: recoveredRunId }));
    expect(runs.find((entry) => entry.runId === recoveredRunId)?.execution.endedAt).toBeUndefined();
    expect(findTaskByRunId(staleRecord.runId)).toMatchObject({ status: "failed" });
    expect(findTaskByRunId(freshRecord.runId)).toMatchObject({ status: "running" });
  });
});
