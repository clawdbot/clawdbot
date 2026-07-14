import { afterEach, expect, test } from "vitest";
import { installSessionPlacementResetGuard } from "../agents/session-placement-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadSessionEntry } from "./session-utils.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-store.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsTestHarness();
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
  const placementReader = sequencedPlacementReader([
    placementRecord(sessionId, "local"),
    placementRecord(sessionId, "active"),
  ]);

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      context: { workerSessionPlacementService: placementReader },
    },
  );

  expect(deleted.ok).toBe(false);
  expect(deleted.error?.message).toContain("cloud worker placement is active");
  expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
  expect(embeddedRunMock.abortCalls).toEqual([]);
});

test("sessions.delete rejects failed placement with unresolved worker ownership", async () => {
  await createSessionStoreDir();
  const sessionKey = "discord:group:failed-worker-session";
  const sessionId = "sess-failed-worker-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placementReader = sequencedPlacementReader([terminalPlacementRecord(sessionId, "failed")]);

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      context: { workerSessionPlacementService: placementReader },
    },
  );

  expect(deleted.ok).toBe(false);
  expect(deleted.error?.message).toContain("cloud worker placement is failed");
  expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
  expect(embeddedRunMock.abortCalls).toEqual([]);
});

test("sessions.delete allows reclaimed placement with no live worker owner", async () => {
  await createSessionStoreDir();
  const sessionKey = "discord:group:reclaimed-worker-session";
  const sessionId = "sess-reclaimed-worker-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placementReader = sequencedPlacementReader([
    terminalPlacementRecord(sessionId, "reclaimed"),
  ]);

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      context: { workerSessionPlacementService: placementReader },
    },
  );

  expect(deleted.ok).toBe(true);
  expect(deleted.payload).toMatchObject({ ok: true, deleted: true });
  expect(loadSessionEntry(sessionKey).entry).toBeUndefined();
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
