import { afterEach, expect, test, vi } from "vitest";
import { installSessionPlacementResetGuard } from "../agents/session-placement-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadSessionEntry } from "./session-utils.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementRetirementService,
} from "./worker-environments/placement-store.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();
let uninstallResetGuard: (() => void) | undefined;

afterEach(() => {
  uninstallResetGuard?.();
  uninstallResetGuard = undefined;
  closeOpenClawStateDatabaseForTest();
});

function placementRecord(
  sessionId: string,
  state: "active" | "local",
): WorkerSessionPlacementRecord {
  const identity = {
    sessionId,
    agentId: "main",
    sessionKey: "agent:main:worker-session",
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
  };
  if (state === "active") {
    return {
      ...identity,
      state,
      generation: 2,
      environmentId: "worker-environment",
      activeOwnerEpoch: 1,
      workspaceBaseManifestRef: "manifest-ref",
      remoteWorkspaceDir: "/workspace",
      workerBundleHash: "bundle-hash",
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
    };
  }
  return {
    ...identity,
    state,
    generation: 0,
    environmentId: null,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
  };
}

function terminalPlacementRecord(
  sessionId: string,
  state: "failed" | "reclaimed",
): WorkerSessionPlacementRecord {
  const terminalMetadata = {
    environmentId: "worker-environment",
    activeOwnerEpoch: 1,
    workspaceBaseManifestRef: "manifest-ref",
    remoteWorkspaceDir: "/workspace",
    workerBundleHash: "bundle-hash",
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
  };
  const identity = {
    sessionId,
    agentId: "main",
    sessionKey: "agent:main:worker-session",
    generation: 2,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
  };
  if (state === "failed") {
    return {
      ...identity,
      ...terminalMetadata,
      state,
      recoveryError: "worker recovery stopped",
    };
  }
  return {
    ...identity,
    ...terminalMetadata,
    state,
    recoveryError: null,
  };
}

function sequencedPlacementReader(
  records: readonly WorkerSessionPlacementRecord[],
): WorkerSessionPlacementReader {
  let readIndex = 0;
  return {
    getMany(sessionIds) {
      const record = records[Math.min(readIndex, records.length - 1)];
      readIndex += 1;
      const result = new Map<string, WorkerSessionPlacementRecord>();
      if (record && sessionIds.includes(record.sessionId)) {
        result.set(record.sessionId, record);
      }
      return result;
    },
  };
}

function sequencedPlacementService(
  records: readonly WorkerSessionPlacementRecord[],
  retire: WorkerSessionPlacementRetirementService["retireSessionPlacement"] = () => {},
) {
  return {
    ...sequencedPlacementReader(records),
    retireSessionPlacement: vi.fn(retire),
  };
}

test("sessions.reset rechecks worker placement inside the lifecycle fence", async () => {
  await seedActiveMainSession();
  let resetGuardReadCount = 0;
  uninstallResetGuard = installSessionPlacementResetGuard((sessionId) => {
    expect(sessionId).toBe("sess-main");
    resetGuardReadCount += 1;
    return resetGuardReadCount === 1 ? undefined : "cloud worker placement is active";
  });

  const reset = await directSessionReq("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(false);
  expect(reset.error?.message).toContain("cloud worker placement is active");
  expect(resetGuardReadCount).toBe(2);
  expect(loadSessionEntry("main").entry?.sessionId).toBe("sess-main");
  expect(embeddedRunMock.abortCalls).toEqual([]);
});

test("sessions.delete rechecks worker placement before destructive cleanup", async () => {
  await createSessionStoreDir();
  const sessionKey = "discord:group:worker-session";
  const sessionId = "sess-worker-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placementService = sequencedPlacementService([
    placementRecord(sessionId, "local"),
    placementRecord(sessionId, "active"),
  ]);

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      context: { workerSessionPlacementService: placementService },
    },
  );

  expect(deleted.ok).toBe(false);
  expect(deleted.error?.message).toContain("cloud worker placement is active");
  expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(placementService.retireSessionPlacement).not.toHaveBeenCalled();
});

test("sessions.delete rejects failed placement while its worker lease remains", async () => {
  await createSessionStoreDir();
  const sessionKey = "discord:group:failed-worker-session";
  const sessionId = "sess-failed-worker-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placementService = sequencedPlacementService([
    terminalPlacementRecord(sessionId, "failed"),
  ]);

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      context: {
        workerEnvironmentService: {
          get: () => ({ state: "failed", leaseId: "lease-1" }),
          resolveInferenceSessionForRunId: () => undefined,
        } as never,
        workerSessionPlacementService: placementService,
      },
    },
  );

  expect(deleted.ok).toBe(false);
  expect(deleted.error?.message).toContain("cloud worker placement is failed");
  expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(placementService.retireSessionPlacement).not.toHaveBeenCalled();
});

test.each([
  { name: "local", state: "local" as const },
  { name: "reclaimed", state: "reclaimed" as const },
  {
    name: "failed after proven bootstrap teardown",
    state: "failed" as const,
    environment: { state: "failed", leaseId: null },
  },
  {
    name: "failed after worker destruction",
    state: "failed" as const,
    environment: { state: "destroyed" },
  },
  {
    name: "failed before acquiring a worker",
    state: "failed" as const,
    withoutEnvironment: true,
  },
])("sessions.delete retires a $name placement after deleting its session", async (testCase) => {
  await createSessionStoreDir();
  const caseId = testCase.name.replaceAll(" ", "-");
  const sessionKey = `discord:group:${caseId}`;
  const sessionId = `sess-${caseId}`;
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement =
    testCase.state === "local"
      ? placementRecord(sessionId, "local")
      : terminalPlacementRecord(sessionId, testCase.state);
  if ("withoutEnvironment" in testCase && placement.state === "failed") {
    placement.environmentId = null;
  }
  const placementService = sequencedPlacementService([placement], () => {
    expect(loadSessionEntry(sessionKey).entry).toBeUndefined();
  });

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      context: {
        ...("environment" in testCase
          ? {
              workerEnvironmentService: {
                get: () => testCase.environment,
                hasInferenceForSession: () => false,
                resolveInferenceSessionForRunId: () => undefined,
              } as never,
            }
          : {}),
        workerSessionPlacementService: placementService,
      },
    },
  );

  expect(deleted.ok).toBe(true);
  expect(deleted.payload).toMatchObject({ ok: true, deleted: true });
  expect(loadSessionEntry(sessionKey).entry).toBeUndefined();
  expect(placementService.retireSessionPlacement).toHaveBeenCalledWith({
    sessionId,
    expectedState: placement.state,
    expectedGeneration: placement.generation,
  });
});

test("sessions.compaction.restore rechecks worker placement inside the lifecycle fence", async () => {
  await createSessionStoreDir();
  const sessionKey = "discord:group:worker-restore";
  const sessionId = "sess-worker-restore";
  const checkpointId = "checkpoint-worker-restore";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, {
        compactionCheckpoints: [
          {
            checkpointId,
            sessionKey,
            sessionId,
            createdAt: 1,
            reason: "manual",
            preCompaction: { sessionId },
            postCompaction: { sessionId },
          },
        ],
      }),
    },
  });
  const placementReader = sequencedPlacementReader([
    placementRecord(sessionId, "local"),
    placementRecord(sessionId, "active"),
  ]);

  const restored = await directSessionReq(
    "sessions.compaction.restore",
    { key: sessionKey, checkpointId },
    {
      context: { workerSessionPlacementService: placementReader },
    },
  );

  expect(restored.ok).toBe(false);
  expect(restored.error?.message).toContain("cloud worker placement is active");
  expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
  expect(embeddedRunMock.abortCalls).toEqual([]);
});
