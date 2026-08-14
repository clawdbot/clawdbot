import { afterEach, expect, test, vi } from "vitest";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import { loadSessionEntry } from "./session-utils.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  beforeResetHookMocks,
  beforeResetHookState,
  bundleMcpRuntimeMocks,
  directSessionReq,
  loadSeededTranscriptEvents,
  seedSessionTranscript,
  sessionStoreEntry,
  sessionHookMocks,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementRetirement,
  WorkerSessionPlacementRetirementService,
  WorkerSessionPlacementStore,
} from "./worker-environments/placement-store.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
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
      terminalReason: null,
      terminalAtMs: null,
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
    terminalReason: null,
    terminalAtMs: null,
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
      terminalReason: "worker recovery stopped",
      terminalAtMs: 2,
    };
  }
  return {
    ...identity,
    ...terminalMetadata,
    state,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
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

async function beginClaimedLocalTurn(params: {
  events: string[];
  onInterrupt?: () => void;
  placementStore: WorkerSessionPlacementStore;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<() => void> {
  const claim = params.placementStore.claimTurn({
    sessionId: params.sessionId,
    agentId: "main",
    sessionKey: params.sessionKey,
    owner: { kind: "local" },
    claimId: `${params.sessionId}-claim`,
    runId: `${params.sessionId}-run`,
  });
  let claimReleased = false;
  let releaseAdmission = () => {};
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, params.sessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      params.events.push("admission:interrupt");
      params.onInterrupt?.();
      params.placementStore.releaseTurn(claim);
      claimReleased = true;
      params.events.push("claim:released");
      releaseAdmission();
    },
  });
  releaseAdmission = admission.release;
  return () => {
    if (!claimReleased) {
      params.placementStore.releaseTurn(claim);
    }
    admission.release();
  };
}

test("sessions.reset rechecks worker placement inside the lifecycle fence", async () => {
  await seedActiveMainSession();
  const placementService = sequencedPlacementService([
    placementRecord("sess-main", "local"),
    placementRecord("sess-main", "active"),
  ]);
  const getWorkerEnvironment = vi.fn();

  const reset = await directSessionReq(
    "sessions.reset",
    { key: "main" },
    {
      context: {
        workerEnvironmentService: { get: getWorkerEnvironment } as never,
        workerSessionPlacementService: placementService,
      },
    },
  );

  expect(reset.ok).toBe(false);
  expect(reset.error?.message).toContain("cloud worker placement is active");
  expect(loadSessionEntry("main").entry?.sessionId).toBe("sess-main");
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(getWorkerEnvironment).not.toHaveBeenCalled();
  expect(placementService.retireSessionPlacement).not.toHaveBeenCalled();
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

test("sessions.delete drains an active local claim before placement retirement", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "discord:group:active-local-delete";
  const sessionId = "sess-active-local-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const events: string[] = [];
  const cleanupAdmission = await beginClaimedLocalTurn({
    events,
    placementStore,
    sessionId,
    sessionKey,
    storePath,
  });

  try {
    const deleted = await directSessionReq(
      "sessions.delete",
      { key: sessionKey },
      {
        context: {
          workerSessionPlacementService: {
            getMany: (sessionIds: readonly string[]) => placementStore.getMany(sessionIds),
            retireSessionPlacement: (retirement: WorkerSessionPlacementRetirement) => {
              expect(placementStore.get(sessionId)?.turnClaim).toBeNull();
              events.push("placement:retire");
              placementStore.retireSessionPlacement(retirement);
            },
          },
        },
      },
    );

    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(events).toEqual(["admission:interrupt", "claim:released", "placement:retire"]);
    expect(placementStore.get(sessionId)).toBeUndefined();
    expect(loadSessionEntry(sessionKey).entry).toBeUndefined();
  } finally {
    cleanupAdmission();
  }
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
  {
    name: "failed after missing durable environment",
    state: "failed" as const,
  },
])("sessions.delete retires a $name placement before deleting its session", async (testCase) => {
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
    expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
  });
  const getWorkerEnvironment = vi.fn(() =>
    "environment" in testCase ? testCase.environment : undefined,
  );

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      context: {
        workerEnvironmentService: {
          get: getWorkerEnvironment,
          hasInferenceForSession: () => false,
          resolveInferenceSessionForRunId: () => undefined,
        } as never,
        workerSessionPlacementService: placementService,
      },
    },
  );

  expect(deleted.ok).toBe(true);
  expect(deleted.payload).toMatchObject({ ok: true, deleted: true });
  expect(loadSessionEntry(sessionKey).entry).toBeUndefined();
  expect(placementService.retireSessionPlacement).toHaveBeenCalledWith({
    status: "retirement-required",
    sessionId,
    expectedState: placement.state,
    expectedGeneration: placement.generation,
  });
  if (placement.state === "failed" && placement.environmentId !== null) {
    expect(getWorkerEnvironment).toHaveBeenCalled();
  } else {
    expect(getWorkerEnvironment).not.toHaveBeenCalled();
  }
});

test("sessions.delete leaves the session intact when placement retirement fails", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "discord:group:retirement-failure";
  const sessionId = "sess-retirement-failure";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  await seedSessionTranscript({
    sessionId,
    sessionKey,
    storePath,
    messages: [{ role: "user", content: "keep this transcript" }],
  });
  const transcriptBefore = await loadSeededTranscriptEvents({
    sessionId,
    sessionKey,
    storePath,
  });
  embeddedRunMock.activeIds.add(sessionId);
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const events: string[] = [];
  const cleanupAdmission = await beginClaimedLocalTurn({
    events,
    placementStore,
    sessionId,
    sessionKey,
    storePath,
  });
  const placementService = {
    getMany: (sessionIds: readonly string[]) => placementStore.getMany(sessionIds),
    retireSessionPlacement: (
      retirement: Parameters<typeof placementStore.retireSessionPlacement>[0],
    ) => {
      expect(events).toEqual(["admission:interrupt", "claim:released"]);
      expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
      placementStore.startDispatch({ sessionId, agentId: "main", sessionKey });
      placementStore.retireSessionPlacement(retirement);
    },
  };

  try {
    await expect(
      directSessionReq(
        "sessions.delete",
        { key: sessionKey },
        { context: { workerSessionPlacementService: placementService } },
      ),
    ).rejects.toThrow(`Worker session placement ${sessionId} changed before retirement`);
    expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
    expect(await loadSeededTranscriptEvents({ sessionId, sessionKey, storePath })).toEqual(
      transcriptBefore,
    );
    expect(events).toEqual(["admission:interrupt", "claim:released"]);
    expect(placementStore.get(sessionId)).toMatchObject({ state: "requested", turnClaim: null });
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).not.toHaveBeenCalled();
  } finally {
    cleanupAdmission();
  }
});

test.each([
  {
    name: "ordinary reset",
    sessionKey: "discord:group:active-local-reset",
    incognito: false,
  },
  {
    name: "incognito reset",
    sessionKey: "agent:main:dashboard:incognito-active-local-reset",
    incognito: true,
  },
])(
  "sessions.reset drains an active local claim before $name placement retirement",
  async (testCase) => {
    await createSessionStoreDir();
    const sessionId = testCase.incognito
      ? await (async () => {
          const created = await directSessionReq<{ sessionId?: string }>("sessions.create", {
            agentId: "main",
            key: testCase.sessionKey,
            incognito: true,
          });
          if (!created.ok || !created.payload?.sessionId) {
            throw new Error(`incognito setup failed: ${JSON.stringify(created.error)}`);
          }
          return created.payload.sessionId;
        })()
      : "sess-active-local-reset";
    if (!testCase.incognito) {
      await writeSessionStore({
        entries: { [testCase.sessionKey]: sessionStoreEntry(sessionId) },
      });
    }
    const storePath = loadSessionEntry(testCase.sessionKey).storePath;
    const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
    const events: string[] = [];
    const cleanupAdmission = await beginClaimedLocalTurn({
      events,
      placementStore,
      sessionId,
      sessionKey: testCase.sessionKey,
      storePath,
    });

    try {
      const reset = await directSessionReq(
        "sessions.reset",
        { key: testCase.sessionKey },
        {
          context: {
            workerSessionPlacementService: {
              getMany: (sessionIds: readonly string[]) => placementStore.getMany(sessionIds),
              retireSessionPlacement: (retirement: WorkerSessionPlacementRetirement) => {
                expect(placementStore.get(sessionId)?.turnClaim).toBeNull();
                events.push("placement:retire");
                placementStore.retireSessionPlacement(retirement);
              },
            },
          },
        },
      );

      expect(reset.ok).toBe(true);
      expect(events).toEqual(["admission:interrupt", "claim:released", "placement:retire"]);
      expect(placementStore.get(sessionId)).toBeUndefined();
      expect(loadSessionEntry(testCase.sessionKey).entry === undefined).toBe(testCase.incognito);
    } finally {
      cleanupAdmission();
    }
  },
);

test("sessions.reset rechecks lifecycle ownership after draining before placement retirement", async () => {
  await createSessionStoreDir();
  const sessionKey = "discord:group:revoked-during-reset-drain";
  const sessionId = "sess-revoked-during-reset-drain";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const storePath = loadSessionEntry(sessionKey).storePath;
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const events: string[] = [];
  let lifecycleCurrent = true;
  const cleanupAdmission = await beginClaimedLocalTurn({
    events,
    onInterrupt: () => {
      lifecycleCurrent = false;
    },
    placementStore,
    sessionId,
    sessionKey,
    storePath,
  });
  const retireSessionPlacement = vi.fn((retirement: WorkerSessionPlacementRetirement) =>
    placementStore.retireSessionPlacement(retirement),
  );
  const { performGatewaySessionReset } = await import("./session-reset-service.js");

  try {
    await expect(
      performGatewaySessionReset({
        key: sessionKey,
        reason: "reset",
        commandSource: "gateway:agent",
        workerPlacementContext: {
          workerSessionPlacementService: {
            getMany: (sessionIds: readonly string[]) => placementStore.getMany(sessionIds),
            retireSessionPlacement,
          },
        },
        assertCurrent: () => {
          if (!lifecycleCurrent) {
            throw new Error("stale lifecycle after drain");
          }
        },
      }),
    ).rejects.toThrow("stale lifecycle after drain");
    expect(events).toEqual(["admission:interrupt", "claim:released"]);
    expect(retireSessionPlacement).not.toHaveBeenCalled();
    expect(placementStore.get(sessionId)).toMatchObject({ state: "local", turnClaim: null });
    expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).not.toHaveBeenCalled();
  } finally {
    cleanupAdmission();
  }
});

test.each([
  {
    name: "ordinary reset",
    sessionKey: "discord:group:local-reset",
    incognito: false,
  },
  {
    name: "incognito reset",
    sessionKey: "agent:main:dashboard:incognito-local-reset",
    incognito: true,
  },
])("sessions.reset retires the old local placement before $name", async (testCase) => {
  await createSessionStoreDir();
  const sessionId = testCase.incognito
    ? await (async () => {
        const created = await directSessionReq<{ sessionId?: string }>("sessions.create", {
          agentId: "main",
          key: testCase.sessionKey,
          incognito: true,
        });
        if (!created.ok || !created.payload?.sessionId) {
          throw new Error(`incognito setup failed: ${JSON.stringify(created.error)}`);
        }
        return created.payload.sessionId;
      })()
    : `sess-${testCase.name.replaceAll(" ", "-")}`;
  if (!testCase.incognito) {
    await writeSessionStore({
      entries: { [testCase.sessionKey]: sessionStoreEntry(sessionId) },
    });
  }
  const placementService = sequencedPlacementService([placementRecord(sessionId, "local")], () => {
    expect(loadSessionEntry(testCase.sessionKey).entry?.sessionId).toBe(sessionId);
  });

  const reset = await directSessionReq(
    "sessions.reset",
    { key: testCase.sessionKey },
    { context: { workerSessionPlacementService: placementService } },
  );

  if (!reset.ok) {
    throw new Error(`${testCase.name} failed: ${JSON.stringify(reset.error)}`);
  }
  expect(placementService.retireSessionPlacement).toHaveBeenCalledWith({
    status: "retirement-required",
    sessionId,
    expectedState: "local",
    expectedGeneration: 0,
  });
  expect(loadSessionEntry(testCase.sessionKey).entry === undefined).toBe(testCase.incognito);
});

test.each([
  {
    name: "ordinary reset",
    sessionKey: "discord:group:retirement-failure-reset",
    incognito: false,
  },
  {
    name: "incognito reset",
    sessionKey: "agent:main:dashboard:incognito-retirement-failure-reset",
    incognito: true,
  },
])(
  "sessions.reset leaves ownership untouched when placement retirement loses a generation race during $name",
  async (testCase) => {
    const { storePath } = await createSessionStoreDir();
    const sessionId = testCase.incognito
      ? await (async () => {
          const created = await directSessionReq<{ sessionId?: string }>("sessions.create", {
            agentId: "main",
            key: testCase.sessionKey,
            incognito: true,
          });
          if (!created.ok || !created.payload?.sessionId) {
            throw new Error(`incognito setup failed: ${JSON.stringify(created.error)}`);
          }
          return created.payload.sessionId;
        })()
      : "sess-retirement-failure-reset";
    if (!testCase.incognito) {
      await writeSessionStore({
        entries: { [testCase.sessionKey]: sessionStoreEntry(sessionId) },
      });
    }
    await seedSessionTranscript({
      sessionId,
      sessionKey: testCase.sessionKey,
      storePath,
      messages: [{ role: "user", content: "keep this reset transcript" }],
    });
    const entryBefore = structuredClone(loadSessionEntry(testCase.sessionKey).entry);
    const transcriptBefore = await loadSeededTranscriptEvents({
      sessionId,
      sessionKey: testCase.sessionKey,
      storePath,
    });
    const placement = placementRecord(sessionId, "local");
    const placementService = sequencedPlacementService([placement], () => {
      throw new Error("placement generation changed before retirement");
    });
    beforeResetHookState.hasBeforeResetHook = true;
    sessionHookMocks.triggerInternalHook.mockClear();
    beforeResetHookMocks.runBeforeReset.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockClear();
    embeddedRunMock.activeIds.add(sessionId);

    await expect(
      directSessionReq(
        "sessions.reset",
        { key: testCase.sessionKey },
        { context: { workerSessionPlacementService: placementService } },
      ),
    ).rejects.toThrow("placement generation changed before retirement");

    expect(loadSessionEntry(testCase.sessionKey).entry).toEqual(entryBefore);
    expect(
      await loadSeededTranscriptEvents({
        sessionId,
        sessionKey: testCase.sessionKey,
        storePath,
      }),
    ).toEqual(transcriptBefore);
    expect(placementService.getMany([sessionId]).get(sessionId)).toEqual(placement);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).not.toHaveBeenCalled();
  },
);

test.each(["generation", "claim"] as const)(
  "sessions.delete fences a placement %s change before deleting the session",
  async (change) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = `discord:group:retirement-${change}-race`;
    const sessionId = `sess-retirement-${change}-race`;
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    await seedSessionTranscript({
      sessionId,
      sessionKey,
      storePath,
      messages: [{ role: "user", content: `keep the ${change} race transcript` }],
    });
    const transcriptBefore = await loadSeededTranscriptEvents({
      sessionId,
      sessionKey,
      storePath,
    });
    embeddedRunMock.activeIds.add(sessionId);
    const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
    const initialClaim = placementStore.claimTurn({
      sessionId,
      agentId: "main",
      sessionKey,
      owner: { kind: "local" },
      claimId: `initial-${change}-claim`,
      runId: `initial-${change}-run`,
    });
    placementStore.releaseTurn(initialClaim);
    let reads = 0;
    const placementService = {
      getMany(sessionIds: readonly string[]) {
        reads += 1;
        if (reads === 3) {
          if (change === "generation") {
            placementStore.startDispatch({ sessionId, agentId: "main", sessionKey });
          } else {
            placementStore.claimTurn({
              sessionId,
              agentId: "main",
              sessionKey,
              owner: { kind: "local" },
              claimId: "racing-local-claim",
              runId: "racing-local-run",
            });
          }
        }
        return placementStore.getMany(sessionIds);
      },
      retireSessionPlacement: (retirement: WorkerSessionPlacementRetirement) =>
        placementStore.retireSessionPlacement(retirement),
    };

    const deletion = directSessionReq(
      "sessions.delete",
      { key: sessionKey },
      { context: { workerSessionPlacementService: placementService } },
    );
    if (change === "claim") {
      await expect(deletion).rejects.toThrow("changed before retirement");
    } else {
      await expect(deletion).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("placement is requested") },
      });
    }
    expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
    expect(await loadSeededTranscriptEvents({ sessionId, sessionKey, storePath })).toEqual(
      transcriptBefore,
    );
    expect(placementStore.get(sessionId)).toBeDefined();
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).not.toHaveBeenCalled();
  },
);

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
