import { afterEach, expect, test, vi } from "vitest";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
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
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementRetirement,
  WorkerSessionPlacementRetirementService,
  WorkerSessionPlacementStore,
} from "./worker-environments/placement-store.js";
import { resolveSessionWorkerPlacementMutationError } from "./worker-environments/session-placement-lifecycle.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function placementRecord(
  sessionId: string,
  state: "active" | "local",
  sessionKey = "agent:main:worker-session",
): WorkerSessionPlacementRecord {
  const identity = {
    sessionId,
    agentId: "main",
    sessionKey,
    executionMode: "worker-turn" as const,
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
  sessionKey = "agent:main:worker-session",
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
    sessionKey,
    executionMode: "worker-turn" as const,
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

test.each([
  { action: "fork" as const, allowed: true },
  { action: "restore" as const, allowed: false },
  { action: "rewind" as const, allowed: false },
  { action: "switch" as const, allowed: false },
])("stopped cloud placement only permits identity-preserving $action", ({ action, allowed }) => {
  for (const state of ["reclaimed", "failed"] as const) {
    const sessionId = `stopped-${state}-${action}`;
    const placement = terminalPlacementRecord(sessionId, state);
    const placementService = sequencedPlacementService([placement]);
    const error = resolveSessionWorkerPlacementMutationError({
      action,
      context: {
        workerEnvironmentService: { get: () => ({ state: "destroyed" }) } as never,
        workerSessionPlacementService: placementService,
      },
      key: placement.sessionKey,
      sessionId,
    });

    if (allowed) {
      expect(error).toBeUndefined();
    } else {
      expect(error?.message).toContain(`cannot ${action} while cloud worker placement is ${state}`);
    }
    expect(placementService.retireSessionPlacement).not.toHaveBeenCalled();
  }
});

async function beginClaimedTurn(params: {
  events: string[];
  onInterrupt?: () => void;
  owner?: Parameters<WorkerSessionPlacementStore["claimTurn"]>[0]["owner"];
  placementStore: WorkerSessionPlacementStore;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<() => void> {
  const claim = params.placementStore.claimTurn({
    sessionId: params.sessionId,
    agentId: "main",
    sessionKey: loadSessionEntry(params.sessionKey).canonicalKey ?? params.sessionKey,
    owner: params.owner ?? { kind: "local" },
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

test.each(["generation", "environment", "session key"] as const)(
  "sessions.delete rejects placement %s replacement across the runtime drain",
  async (change) => {
    await createSessionStoreDir();
    const sessionKey = "agent:main:worker-drain-race";
    const sessionId = "worker-drain-race";
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    let placement = placementRecord(sessionId, "active", sessionKey);
    const started = createDeferredCore<boolean>();
    const gate = createDeferredCore();
    const release = vi.fn();
    const reclaim = vi.fn();
    const deletion = directSessionReq(
      "sessions.delete",
      { key: sessionKey },
      {
        context: {
          workerSessionPlacementService: { getMany: () => new Map([[sessionId, placement]]) },
          workerPlacementDispatchService: { reclaim },
          workerEnvironmentService: createWorkerInferenceDrainService(() => {
            started.resolve(true);
            return { drained: gate.promise, hasWork: () => false, release };
          }),
        },
      },
    );
    try {
      expect(await Promise.race([started.promise, deletion.then(() => false)])).toBe(true);
      placement = {
        ...placement,
        ...(change === "generation"
          ? { generation: placement.generation + 1 }
          : change === "environment"
            ? { environmentId: "replacement-environment" }
            : { sessionKey: "agent:main:replacement" }),
      } as WorkerSessionPlacementRecord;
    } finally {
      gate.resolve();
    }
    expect(await deletion).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(reclaim).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
  },
);

test.each([
  ["discord:group:active-local-delete", "discord:group:active-local-delete"],
  ["agent:main:cron:placed-job", "agent:main:cron:placed-job:run:sess-active-local-delete"],
  ["agent:main:cron:adopted-job", "agent:main:cron:adopted-job:run:original-session-id"],
])("sessions.delete drains %s before placement retirement", async (sessionKey, placementKey) => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-active-local-delete";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
      [placementKey]: sessionStoreEntry(sessionId),
    },
  });
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const events: string[] = [];
  const cleanupAdmission = await beginClaimedTurn({
    events,
    placementStore,
    sessionId,
    sessionKey: placementKey,
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
    if (placementKey !== sessionKey) {
      expect(loadSessionEntry(placementKey).entry?.sessionId).toBe(sessionId);
    }
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
    terminalPlacementRecord(sessionId, "failed", loadSessionEntry(sessionKey).canonicalKey),
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
])("sessions.delete retires a $name placement after deleting its session", async (testCase) => {
  await createSessionStoreDir();
  const caseId = testCase.name.replaceAll(" ", "-");
  const sessionKey = `discord:group:${caseId}`;
  const sessionId = `sess-${caseId}`;
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const placement =
    testCase.state === "local"
      ? placementRecord(sessionId, "local", loadSessionEntry(sessionKey).canonicalKey)
      : terminalPlacementRecord(
          sessionId,
          testCase.state,
          loadSessionEntry(sessionKey).canonicalKey,
        );
  if ("withoutEnvironment" in testCase && placement.state === "failed") {
    placement.environmentId = null;
  }
  const placementService = sequencedPlacementService([placement], () => {
    expect(loadSessionEntry(sessionKey).entry).toBeUndefined();
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
    const cleanupAdmission = await beginClaimedTurn({
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
  const cleanupAdmission = await beginClaimedTurn({
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
    state: "local" as const,
  },
  {
    name: "incognito reset",
    sessionKey: "agent:main:dashboard:incognito-local-reset",
    incognito: true,
    state: "local" as const,
  },
  {
    name: "reclaimed cloud reset",
    sessionKey: "discord:group:reclaimed-reset",
    incognito: false,
    state: "reclaimed" as const,
  },
  {
    name: "failed cloud reset after worker destruction",
    sessionKey: "discord:group:destroyed-worker-reset",
    incognito: false,
    state: "failed" as const,
    environment: { state: "destroyed" },
  },
  {
    name: "failed cloud reset after proven bootstrap teardown",
    sessionKey: "discord:group:failed-worker-reset",
    incognito: false,
    state: "failed" as const,
    environment: { state: "failed", leaseId: null },
  },
])("sessions.reset retires the old placement before $name", async (testCase) => {
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
  const placement =
    testCase.state === "local"
      ? placementRecord(sessionId, "local")
      : terminalPlacementRecord(sessionId, testCase.state);
  const placementService = sequencedPlacementService([placement], () => {
    expect(loadSessionEntry(testCase.sessionKey).entry?.sessionId).toBe(sessionId);
  });

  const reset = await directSessionReq(
    "sessions.reset",
    { key: testCase.sessionKey },
    {
      context: {
        ...(testCase.state === "failed"
          ? { workerEnvironmentService: { get: () => testCase.environment } as never }
          : {}),
        workerSessionPlacementService: placementService,
      },
    },
  );

  if (!reset.ok) {
    throw new Error(`${testCase.name} failed: ${JSON.stringify(reset.error)}`);
  }
  expect(placementService.retireSessionPlacement).toHaveBeenCalledWith({
    status: "retirement-required",
    sessionId,
    expectedState: testCase.state,
    expectedGeneration: placement.generation,
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
      sessionKey: loadSessionEntry(sessionKey).canonicalKey ?? sessionKey,
      owner: { kind: "local" },
      claimId: `initial-${change}-claim`,
      runId: `initial-${change}-run`,
    });
    placementStore.releaseTurn(initialClaim);
    bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
      const canonicalKey = loadSessionEntry(sessionKey).canonicalKey ?? sessionKey;
      if (change === "generation") {
        placementStore.startDispatch({ sessionId, agentId: "main", sessionKey: canonicalKey });
      } else {
        placementStore.claimTurn({
          sessionId,
          agentId: "main",
          sessionKey: canonicalKey,
          owner: { kind: "local" },
          claimId: "racing-local-claim",
          runId: "racing-local-run",
        });
      }
    });
    const deletion = directSessionReq(
      "sessions.delete",
      { key: sessionKey },
      { context: { workerSessionPlacementService: placementStore } },
    );
    await expect(deletion).rejects.toThrow("changed before retirement");
    expect(loadSessionEntry(sessionKey).entry?.sessionId).toBe(sessionId);
    expect(await loadSeededTranscriptEvents({ sessionId, sessionKey, storePath })).toEqual(
      transcriptBefore,
    );
    expect(placementStore.get(sessionId)).toBeDefined();
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

test.each(["worker-turn", "remote-exec"] as const)(
  "sessions.delete safely reclaims an active %s placement before committing deletion",
  async (executionMode) => {
    const { storePath } = await createSessionStoreDir();
    await writeSessionStore({
      entries: { [REQUEST.sessionKey]: sessionStoreEntry(REQUEST.sessionId) },
    });
    const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
    const release = vi.fn();
    const harness = createHarness(placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      afterReconcile: () => {
        expect(loadSessionEntry(REQUEST.sessionKey).entry?.sessionId).toBe(REQUEST.sessionId);
        expect(release).not.toHaveBeenCalled();
      },
    });
    const active = await harness.service.dispatch({ ...REQUEST, executionMode });
    const events: string[] = [];
    const releaseTurn = await beginClaimedTurn({
      ...REQUEST,
      storePath,
      placementStore,
      events,
      owner: {
        kind: executionMode === "worker-turn" ? "worker" : "local",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const retireSessionPlacement = vi.fn((retirement: WorkerSessionPlacementRetirement) => {
      expect(loadSessionEntry(REQUEST.sessionKey).entry).toBeUndefined();
      expect(harness.environments.destroy).toHaveBeenCalledOnce();
      placementStore.retireSessionPlacement(retirement);
    });
    const deleted = await directSessionReq(
      "sessions.delete",
      { key: REQUEST.sessionKey },
      {
        context: {
          workerEnvironmentService: createWorkerInferenceDrainService(
            () => ({
              drained: Promise.resolve(),
              hasWork: () => false,
              release,
            }),
            harness.environments,
          ),
          workerPlacementDispatchService: harness.service,
          workerSessionPlacementService: { ...placementStore, retireSessionPlacement },
        },
      },
    );
    releaseTurn();
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(events).toEqual(["admission:interrupt", "claim:released"]);
    expect(harness.log.indexOf("workspace:reconcile")).toBeLessThan(
      harness.log.indexOf("teardown:destroy"),
    );
    expect(retireSessionPlacement).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(placementStore.get(REQUEST.sessionId)).toBeUndefined();
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(loadSessionEntry(REQUEST.sessionKey).entry).toBeUndefined();
  },
);

test.each(["worker-turn", "remote-exec"] as const)(
  "sessions.delete preserves unsynced %s work when final reconciliation fails",
  async (executionMode) => {
    await createSessionStoreDir();
    await writeSessionStore({
      entries: { [REQUEST.sessionKey]: sessionStoreEntry(REQUEST.sessionId) },
    });
    const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
    const harness = createHarness(placementStore, { verifyFails: true });
    await harness.service.dispatch({ ...REQUEST, executionMode });
    const forceDestroyEnvironment = vi.spyOn(harness.service, "forceDestroyEnvironment");
    const deleted = await directSessionReq(
      "sessions.delete",
      { key: REQUEST.sessionKey },
      {
        context: {
          workerEnvironmentService: {
            ...harness.environments,
            hasInferenceForSession: () => false,
            cancelInferenceForSession: () => [],
            resolveInferenceSessionForRunId: () => undefined,
          },
          workerPlacementDispatchService: harness.service,
          workerSessionPlacementService: placementStore,
        },
      },
    );
    expect(deleted).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(harness.log).toContain("workspace:reconcile");
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(forceDestroyEnvironment).not.toHaveBeenCalled();
    expect(loadSessionEntry(REQUEST.sessionKey).entry?.sessionId).toBe(REQUEST.sessionId);
    expect(placementStore.get(REQUEST.sessionId)).toMatchObject({
      state: "draining",
      executionMode,
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: null },
    ]);
  },
);

test("sessions.delete retains reclaimed placement when runtime cleanup fails before commit", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: { [REQUEST.sessionKey]: sessionStoreEntry(REQUEST.sessionId) },
  });
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const harness = createHarness(placementStore, {
    reconcileChanged: false,
    reconcileCommitsManifest: false,
  });
  await harness.service.dispatch(REQUEST);
  const reclaimed = await harness.service.reclaim(REQUEST);
  bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockRejectedValueOnce(
    new Error("runtime cleanup failed"),
  );
  await expect(
    directSessionReq(
      "sessions.delete",
      { key: REQUEST.sessionKey },
      {
        context: { workerSessionPlacementService: placementStore },
      },
    ),
  ).rejects.toThrow("runtime cleanup failed");
  expect(loadSessionEntry(REQUEST.sessionKey).entry?.sessionId).toBe(REQUEST.sessionId);
  expect(placementStore.get(REQUEST.sessionId)).toEqual(reclaimed);
});
