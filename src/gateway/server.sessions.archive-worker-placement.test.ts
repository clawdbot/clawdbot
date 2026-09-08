import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function workerPlacement(params: {
  sessionId: string;
  sessionKey: string;
  state: WorkerSessionPlacementRecord["state"];
  agentId?: string;
  environmentId?: string | null;
}): WorkerSessionPlacementRecord {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? "main",
    state: params.state,
    generation: 2,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId:
      params.environmentId !== undefined
        ? params.environmentId
        : params.state === "local" || params.state === "requested"
          ? null
          : "worker-environment",
    activeOwnerEpoch: ["active", "draining", "reconciling", "reclaimed", "failed"].includes(
      params.state,
    )
      ? 1
      : null,
    workspaceBaseManifestRef:
      params.state === "local" ||
      params.state === "requested" ||
      params.state === "provisioning" ||
      params.state === "syncing"
        ? null
        : "manifest-ref",
    remoteWorkspaceDir:
      params.state === "local" ||
      params.state === "requested" ||
      params.state === "provisioning" ||
      params.state === "syncing"
        ? null
        : "/workspace",
    workerBundleHash:
      params.state === "local" || params.state === "requested" || params.state === "provisioning"
        ? null
        : "bundle-hash",
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: params.state === "failed" ? "worker recovery stopped" : null,
  } as WorkerSessionPlacementRecord;
}

function placementReader(current: () => WorkerSessionPlacementRecord | undefined) {
  return {
    getMany(sessionIds: readonly string[]) {
      const placement = current();
      return new Map(
        placement && sessionIds.includes(placement.sessionId)
          ? [[placement.sessionId, placement]]
          : [],
      );
    },
  };
}

test("sessions.patch reclaims the exact active cloud placement before archive metadata commits", async () => {
  const { storePath } = await createSessionStoreDir();
  const requestedKey = "archive-cloud-active";
  const sessionKey = `agent:main:${requestedKey}`;
  const sessionId = "session-archive-cloud-active";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const reclaimStarted = createDeferredCore();
  const reclaimGate = createDeferredCore();
  const reclaim = vi.fn(async () => {
    reclaimStarted.resolve();
    await reclaimGate.promise;
    placement = workerPlacement({ sessionId, sessionKey, state: "reclaimed" });
    return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
  });

  const archive = directSessionReq(
    "sessions.patch",
    { key: requestedKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  await reclaimStarted.promise;
  expect(reclaim).toHaveBeenCalledOnce();
  expect(reclaim).toHaveBeenCalledWith(
    { sessionId, sessionKey, agentId: "main" },
    expect.any(Function),
    expect.any(Function),
  );
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  reclaimGate.resolve();

  await expect(archive).resolves.toMatchObject({ ok: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
});

test.each(["rejected", "unavailable"] as const)(
  "sessions.patch leaves active placement unarchived and releases its drain when reclaim is %s",
  async (failure) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:archive-cloud-${failure}`;
    const sessionId = `session-archive-cloud-${failure}`;
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    const placement = workerPlacement({ sessionId, sessionKey, state: "active" });
    const release = vi.fn();
    const reclaim = vi.fn(async () => {
      throw new Error("provider reclaim rejected");
    });
    const workerPlacementDispatchService =
      failure === "rejected" ? { dispatch: vi.fn(), reclaim } : { dispatch: vi.fn() };

    const archived = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: sessionId },
      {
        context: {
          workerEnvironmentService: createWorkerInferenceDrainService(() => ({
            drained: Promise.resolve(),
            hasWork: () => false,
            release,
          })),
          workerSessionPlacementService: placementReader(() => placement),
          workerPlacementDispatchService,
        },
      },
    );

    expect(archived).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", retryable: true },
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(reclaim).toHaveBeenCalledTimes(failure === "rejected" ? 1 : 0);
  },
);

test("sessions.patch rejects a mismatched reclaimed identity without archiving", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-cloud-identity";
  const sessionId = "session-archive-cloud-identity";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const reclaim = vi.fn(async () =>
    workerPlacement({
      sessionId,
      sessionKey: "agent:main:wrong-session",
      state: "reclaimed",
    }),
  );

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(archived).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true },
  });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch rejects a reclaimed return when its authoritative placement stayed active", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-cloud-stale-reclaim";
  const sessionId = "session-archive-cloud-stale-reclaim";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const reclaim = vi.fn(async () => workerPlacement({ sessionId, sessionKey, state: "reclaimed" }));

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(archived).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true },
  });
  expect(reclaim).toHaveBeenCalledOnce();
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch rejects a placement identity changed during the runtime drain", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-cloud-fresh-placement";
  const sessionId = "session-archive-cloud-fresh-placement";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const drainGate = createDeferredCore();
  const drainStarted = vi.fn();
  const release = vi.fn();
  const reclaim = vi.fn();

  const archive = directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerEnvironmentService: createWorkerInferenceDrainService(() => {
          drainStarted();
          return { drained: drainGate.promise, hasWork: () => false, release };
        }),
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  await vi.waitFor(() => expect(drainStarted).toHaveBeenCalledOnce());
  placement = workerPlacement({
    sessionId,
    sessionKey: "agent:main:replacement-placement",
    state: "active",
  });
  drainGate.resolve();

  await expect(archive).resolves.toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true },
  });
  expect(reclaim).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test.each([
  { name: "requested", state: "requested" as const },
  { name: "provisioning", state: "provisioning" as const },
  { name: "syncing", state: "syncing" as const },
  { name: "starting", state: "starting" as const },
  { name: "draining", state: "draining" as const },
  { name: "reconciling", state: "reconciling" as const },
  {
    name: "failed with a live environment",
    state: "failed" as const,
    environmentState: "attached",
  },
  {
    name: "failed with cleanup still pending",
    state: "failed" as const,
    environmentState: "destroying",
  },
  { name: "failed with an unknown environment", state: "failed" as const },
])("sessions.patch rejects $name before cancellation or reclaim", async (testCase) => {
  const { storePath } = await createSessionStoreDir();
  const caseId = testCase.name.replaceAll(" ", "-");
  const sessionKey = `agent:main:archive-cloud-${caseId}`;
  const sessionId = `session-archive-cloud-${caseId}`;
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement = workerPlacement({ sessionId, sessionKey, state: testCase.state });
  const reclaim = vi.fn();
  embeddedRunMock.activeIds.add(sessionId);

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        ...(testCase.environmentState
          ? {
              workerEnvironmentService: {
                get: () => ({ state: testCase.environmentState, leaseId: "lease" }),
              },
            }
          : {}),
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(archived).toMatchObject({
    ok: false,
    error: {
      code: "UNAVAILABLE",
      retryable: testCase.state !== "failed",
      message: expect.stringContaining(`cloud worker placement is ${testCase.state}`),
    },
  });
  if (testCase.state === "failed") {
    expect(archived.error?.message).toContain("Stop cloud worker");
    expect(archived.error?.message).toContain("provider error");
  }
  expect(reclaim).not.toHaveBeenCalled();
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expectNoSessionQueueCleanup();
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test.each([
  { name: "local", state: "local" as const },
  { name: "reclaimed", state: "reclaimed" as const },
  { name: "failed after its environment is gone", state: "failed" as const, gone: true },
])("sessions.patch archives $name placement without reclaim", async (testCase) => {
  const { storePath } = await createSessionStoreDir();
  const caseId = testCase.name.replaceAll(" ", "-");
  const sessionKey = `agent:main:archive-cloud-${caseId}`;
  const sessionId = `session-archive-cloud-${caseId}`;
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement = workerPlacement({ sessionId, sessionKey, state: testCase.state });
  const reclaim = vi.fn();

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        ...(testCase.gone
          ? {
              workerEnvironmentService: {
                get: () => ({ state: "destroyed" }),
                cancelInferenceForSession: vi.fn(() => []),
                hasInferenceForSession: vi.fn(() => false),
                resolveInferenceSessionForRunId: vi.fn(),
              },
            }
          : {}),
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(archived).toMatchObject({ ok: true });
  expect(reclaim).not.toHaveBeenCalled();
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
});

test.each([
  { name: "reclaimed", state: "reclaimed" as const },
  { name: "failed after its environment is gone", state: "failed" as const, gone: true },
])("sessions.patch restores $name placement", async (testCase) => {
  const { storePath } = await createSessionStoreDir();
  const caseId = testCase.name.replaceAll(" ", "-");
  const sessionKey = `agent:main:restore-cloud-${caseId}`;
  const sessionId = `session-restore-cloud-${caseId}`;
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId, { archivedAt: 1 }) },
  });
  const placement = workerPlacement({ sessionId, sessionKey, state: testCase.state });

  const restored = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: false, expectedSessionId: sessionId },
    {
      context: {
        ...(testCase.gone
          ? {
              workerEnvironmentService: {
                get: () => ({ state: "destroyed" }),
                cancelInferenceForSession: vi.fn(() => []),
                hasInferenceForSession: vi.fn(() => false),
                resolveInferenceSessionForRunId: vi.fn(),
              },
            }
          : {}),
        workerSessionPlacementService: placementReader(() => placement),
      },
    },
  );

  expect(restored).toMatchObject({ ok: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch keeps restore blocked for an active cloud placement", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:restore-cloud-active";
  const sessionId = "session-restore-cloud-active";
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId, { archivedAt: 1 }) },
  });
  const placement = workerPlacement({ sessionId, sessionKey, state: "active" });

  const restored = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: false, expectedSessionId: sessionId },
    { context: { workerSessionPlacementService: placementReader(() => placement) } },
  );

  expect(restored).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBe(1);
});

test("sessions.patchMany isolates a reclaim failure and archives a later target in input order", async () => {
  const { storePath } = await createSessionStoreDir();
  const failedKey = "agent:main:archive-batch-reclaim-failed";
  const laterKey = "agent:main:archive-batch-reclaim-later";
  const failedSessionId = "session-batch-reclaim-failed";
  const laterSessionId = "session-batch-reclaim-later";
  await writeSessionStore({
    entries: {
      [failedKey]: sessionStoreEntry(failedSessionId),
      [laterKey]: sessionStoreEntry(laterSessionId),
    },
  });
  const placements = new Map([
    [
      failedSessionId,
      workerPlacement({ sessionId: failedSessionId, sessionKey: failedKey, state: "active" }),
    ],
    [
      laterSessionId,
      workerPlacement({ sessionId: laterSessionId, sessionKey: laterKey, state: "local" }),
    ],
  ]);
  const reclaim = vi.fn(async () => {
    throw new Error("reclaim failed");
  });

  const result = await directSessionReq<{
    outcomes: Array<{ error?: { code: string; retryable?: boolean }; key: string; ok: boolean }>;
  }>(
    "sessions.patchMany",
    {
      targets: [
        { key: failedKey, expectedSessionId: failedSessionId },
        { key: laterKey, expectedSessionId: laterSessionId },
      ],
      patch: { archived: true },
    },
    {
      context: {
        workerSessionPlacementService: {
          getMany: (sessionIds: readonly string[]) =>
            new Map(
              sessionIds.flatMap((sessionId) => {
                const placement = placements.get(sessionId);
                return placement ? [[sessionId, placement] as const] : [];
              }),
            ),
        },
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(result.payload?.outcomes).toEqual([
    {
      key: failedKey,
      ok: false,
      error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    },
    { key: laterKey, ok: true },
  ]);
  expect(reclaim).toHaveBeenCalledOnce();
  expect(loadSessionEntry({ storePath, sessionKey: failedKey })?.archivedAt).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: laterKey })?.archivedAt).toEqual(
    expect.any(Number),
  );
});
