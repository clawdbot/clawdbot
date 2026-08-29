import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  initializeManagedWorktreeTestRepository,
  materializeManagedWorktreeFixture,
} from "../agents/worktrees/service.test-support.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";
import {
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function recoveryWorkerPlacement(params: {
  sessionId: string;
  sessionKey: string;
  state: WorkerSessionPlacementRecord["state"];
  generation?: number;
}): WorkerSessionPlacementRecord {
  return {
    ...params,
    agentId: "main",
    generation: params.generation ?? 2,
    turnClaim: null,
    environmentId: params.state === "local" || params.state === "requested" ? null : "worker-env",
  } as WorkerSessionPlacementRecord;
}

function recoveryPlacementReader(current: () => WorkerSessionPlacementRecord | undefined) {
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

async function seedRecoverableSession(params: {
  sourceKey: string;
  sourceSessionId: string;
  storePath: string;
  overrides?: Parameters<typeof sessionStoreEntry>[1];
}) {
  await writeSessionStore({
    entries: {
      [params.sourceKey]: sessionStoreEntry(params.sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: `cycle-${params.sourceSessionId}`,
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
        ...params.overrides,
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: params.sourceSessionId,
    sessionKey: params.sourceKey,
    storePath: params.storePath,
    messages: [{ role: "user", content: "recover the interrupted cloud workspace" }],
  });
}

test("sessions.recover settles its active placement before archiving a real session-owned worktree", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sourceKey = "agent:main:dashboard:recovery-cloud-active";
  const sourceSessionId = "recovery-cloud-active-source";
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("gateway test state directory is unavailable");
  }
  const repoRoot = await initializeManagedWorktreeTestRepository(dir);
  const worktree = await materializeManagedWorktreeFixture({
    env: process.env,
    name: "recovery-cloud-active",
    now: Date.now(),
    ownerKind: "session",
    ownerId: sourceKey,
    repoRoot,
    stateDir,
  });
  const unsyncedPath = path.join(worktree.path, "unsynced.txt");
  await fs.writeFile(unsyncedPath, "preserve local work\n");
  await seedRecoverableSession({
    sourceKey,
    sourceSessionId,
    storePath,
    overrides: {
      spawnedCwd: worktree.path,
      worktree: {
        id: worktree.id,
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
        canonicalWorkspaceDir: repoRoot,
      },
    },
  });

  let placement = recoveryWorkerPlacement({
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    state: "active",
  });
  const reclaimStarted = createDeferredCore();
  const reclaimGate = createDeferredCore();
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements: {
      get: () => placement,
      waitForTurnClaimRelease: vi.fn(async () => {}),
    },
    loadSessionRuntime: async () => ({
      managedWorktrees,
      resolveCanonicalSessionEntryFromStoreKeys,
      resolveGatewaySessionStoreTargetWithStore,
    }),
    revokeSessionAuthority: vi.fn(),
  });
  const reclaim = vi.fn(
    async (
      request: { agentId: string; sessionId: string; sessionKey: string },
      authorize?: () => void,
      beforeDrain?: () => void,
    ) =>
      await barriers.runReclaimBarrier({
        ...request,
        authorize,
        beforeDrain,
        begin: () => {
          placement = recoveryWorkerPlacement({
            sessionId: sourceSessionId,
            sessionKey: sourceKey,
            state: "draining",
            generation: placement.generation + 1,
          });
          return placement as Extract<WorkerSessionPlacementRecord, { state: "draining" }>;
        },
        reclaim: async (worktreePath, _placement, reauthorize) => {
          expect(worktreePath).toBe(worktree.path);
          reclaimStarted.resolve();
          await reclaimGate.promise;
          reauthorize?.();
          await fs.appendFile(unsyncedPath, "final worker sync\n");
          placement = recoveryWorkerPlacement({
            sessionId: sourceSessionId,
            sessionKey: sourceKey,
            state: "reclaimed",
            generation: placement.generation + 1,
          });
          return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
        },
      }),
  );
  const context = {
    workerSessionPlacementService: recoveryPlacementReader(() => placement),
    workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
  };

  const recovering = directSessionReq<{ key: string; sessionId: string }>(
    "sessions.recover",
    { agentId: "main", key: sourceKey },
    { context },
  );
  try {
    const committedBeforeReclaim = await Promise.race([
      reclaimStarted.promise.then(() => false),
      recovering.then(() => true),
    ]);
    expect(committedBeforeReclaim).toBe(false);
    expect(reclaim).toHaveBeenCalledWith(
      { agentId: "main", sessionId: sourceSessionId, sessionKey: sourceKey },
      undefined,
      expect.any(Function),
    );
    const unsettledSource = loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath });
    expect(unsettledSource?.archivedAt).toBeUndefined();
    expect(unsettledSource?.mainRestartRecovery?.tombstone?.recoveredSessionKey).toBeUndefined();
  } finally {
    reclaimGate.resolve();
    await Promise.allSettled([recovering]);
  }

  const recovered = await recovering;
  expect(recovered).toMatchObject({ ok: true, payload: { key: expect.any(String) } });
  expect(placement.state).toBe("reclaimed");
  expect(loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath })).toMatchObject({
    archivedAt: expect.any(Number),
    worktree: { id: worktree.id },
  });
  expect(managedWorktrees.findLiveByOwner("session", sourceKey)).toMatchObject({
    id: worktree.id,
    ownerId: sourceKey,
  });
  expect(managedWorktrees.findLiveByOwner("session", recovered.payload?.key ?? "")).toBeUndefined();
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: recovered.payload?.key ?? "",
      storePath,
    })?.worktree,
  ).toBeUndefined();
  await expect(fs.readFile(unsyncedPath, "utf8")).resolves.toBe(
    "preserve local work\nfinal worker sync\n",
  );

  await expect(
    directSessionReq("sessions.recover", { agentId: "main", key: sourceKey }, { context }),
  ).resolves.toMatchObject({ ok: true, payload: { key: recovered.payload?.key } });
  expect(reclaim).toHaveBeenCalledOnce();
});

test.each(["before-interrupt", "before-drain"] as const)(
  "automatic reclaim rechecks eligibility after waiting %s",
  async (phase) => {
    const { dir, storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:dashboard:idle-reclaim-${phase}`;
    const sessionId = `idle-reclaim-${phase}`;
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("gateway test state directory is unavailable");
    }
    const repoRoot = await initializeManagedWorktreeTestRepository(dir);
    const worktree = await materializeManagedWorktreeFixture({
      env: process.env,
      name: sessionId,
      now: Date.now(),
      ownerKind: "session",
      ownerId: sessionKey,
      repoRoot,
      stateDir,
    });
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          spawnedCwd: worktree.path,
          worktree: {
            id: worktree.id,
            branch: worktree.branch,
            repoRoot,
            canonicalWorkspaceDir: repoRoot,
          },
        }),
      },
    });
    const placement = recoveryWorkerPlacement({ sessionId, sessionKey, state: "active" });
    if (placement.state !== "active") {
      throw new Error("expected active worker placement");
    }
    const enteredWait = createDeferredCore();
    const releaseWait = createDeferredCore();
    const wait = async () => {
      enteredWait.resolve();
      await releaseWait.promise;
    };
    const onInterrupt = vi.fn();
    let releaseAdmission = () => {};
    const admission =
      phase === "before-interrupt"
        ? await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionId, sessionKey],
            assertAllowed: () => {},
            onInterrupt: () => {
              onInterrupt();
              releaseAdmission();
            },
          })
        : undefined;
    releaseAdmission = () => admission?.release();
    const begin = vi.fn(() => ({ ...placement, state: "draining" as const }));
    const reclaim = vi.fn(async () => {
      throw new Error("ineligible worker must not be reclaimed");
    });
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements: {
        get: () => placement,
        waitForTurnClaimRelease: async () => {
          if (phase === "before-drain") {
            await wait();
          }
        },
      },
      loadSessionRuntime: async () => {
        if (phase === "before-interrupt") {
          await wait();
        }
        return {
          managedWorktrees,
          resolveCanonicalSessionEntryFromStoreKeys,
          resolveGatewaySessionStoreTargetWithStore,
        };
      },
      revokeSessionAuthority: vi.fn(),
    });
    let eligible = true;
    const eligibilityError = new Error("worker is no longer idle");
    const reclaiming = barriers.runReclaimBarrier({
      sessionId,
      sessionKey,
      agentId: "main",
      beforeDrain: () => {
        if (!eligible) {
          throw eligibilityError;
        }
      },
      begin,
      reclaim,
    });
    const rejected = expect(reclaiming).rejects.toBe(eligibilityError);
    try {
      await enteredWait.promise;
      eligible = false;
      releaseWait.resolve();
      await rejected;
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
      expect(reclaim).not.toHaveBeenCalled();
    } finally {
      releaseWait.resolve();
      admission?.release();
      await Promise.allSettled([reclaiming]);
    }
  },
);

test.each(["rejected", "unavailable", "stale-result"] as const)(
  "sessions.recover leaves its source and successor untouched when cloud reclaim is %s",
  async (failure) => {
    const { storePath } = await createSessionStoreDir();
    const sourceKey = `agent:main:dashboard:recovery-cloud-${failure}`;
    const sourceSessionId = `recovery-cloud-${failure}-source`;
    await seedRecoverableSession({ sourceKey, sourceSessionId, storePath });
    const placement = recoveryWorkerPlacement({
      sessionId: sourceSessionId,
      sessionKey: sourceKey,
      state: "active",
    });
    const reclaim = vi.fn(async () => {
      if (failure === "rejected") {
        throw new Error("final workspace reconciliation rejected");
      }
      return recoveryWorkerPlacement({
        sessionId: sourceSessionId,
        sessionKey: sourceKey,
        state: "reclaimed",
      });
    });

    const recovered = await directSessionReq(
      "sessions.recover",
      { agentId: "main", key: sourceKey },
      {
        context: {
          workerSessionPlacementService: recoveryPlacementReader(() => placement),
          workerPlacementDispatchService:
            failure === "unavailable" ? { dispatch: vi.fn() } : { dispatch: vi.fn(), reclaim },
        },
      },
    );

    expect(recovered).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        retryable: true,
        message: expect.stringContaining("sessions.reclaim"),
      },
    });
    const source = loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath });
    expect(source?.archivedAt).toBeUndefined();
    expect(source?.mainRestartRecovery?.tombstone?.recoveredSessionId).toBeUndefined();
    expect(reclaim).toHaveBeenCalledTimes(failure === "unavailable" ? 0 : 1);
  },
);

test.each([
  "requested",
  "provisioning",
  "syncing",
  "starting",
  "draining",
  "reconciling",
  "failed",
] as const)("sessions.recover rejects an unsettled %s cloud placement", async (state) => {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = `agent:main:dashboard:recovery-cloud-${state}`;
  const sourceSessionId = `recovery-cloud-${state}-source`;
  await seedRecoverableSession({ sourceKey, sourceSessionId, storePath });
  const placement = recoveryWorkerPlacement({
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    state,
  });
  const reclaim = vi.fn();

  const recovered = await directSessionReq(
    "sessions.recover",
    { agentId: "main", key: sourceKey },
    {
      context: {
        workerSessionPlacementService: recoveryPlacementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(recovered).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true, message: expect.stringContaining(state) },
  });
  expect(reclaim).not.toHaveBeenCalled();
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath })?.archivedAt,
  ).toBeUndefined();
});

test.each(["session-id", "lifecycle-revision"] as const)(
  "sessions.recover rejects a source %s changed while its placement is reclaiming",
  async (changedIdentity) => {
    const { storePath } = await createSessionStoreDir();
    const sourceKey = `agent:main:dashboard:recovery-cloud-race-${changedIdentity}`;
    const sourceSessionId = `recovery-cloud-race-${changedIdentity}-source`;
    await seedRecoverableSession({
      sourceKey,
      sourceSessionId,
      storePath,
      overrides: { lifecycleRevision: "original-lifecycle" },
    });
    let placement = recoveryWorkerPlacement({
      sessionId: sourceSessionId,
      sessionKey: sourceKey,
      state: "active",
    });
    const reclaim = vi.fn(async () => {
      const current = loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath });
      if (!current) {
        throw new Error("recovery source disappeared");
      }
      await replaceSessionEntry(
        { agentId: "main", sessionKey: sourceKey, storePath },
        {
          ...current,
          ...(changedIdentity === "session-id"
            ? { sessionId: "replacement-session" }
            : { lifecycleRevision: "replacement-lifecycle" }),
        },
      );
      placement = recoveryWorkerPlacement({
        sessionId: sourceSessionId,
        sessionKey: sourceKey,
        state: "reclaimed",
      });
      return placement;
    });

    const recovered = await directSessionReq(
      "sessions.recover",
      { agentId: "main", key: sourceKey },
      {
        context: {
          workerSessionPlacementService: recoveryPlacementReader(() => placement),
          workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        },
      },
    );

    expect(recovered).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("changed") },
    });
    const source = loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath });
    expect(source?.archivedAt).toBeUndefined();
    expect(source?.mainRestartRecovery?.tombstone?.recoveredSessionId).toBeUndefined();
  },
);

test("sessions.recover rolls over one tombstone and returns its continuation outcome", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main", scope: "per-sender" };
  const sourceKey = "agent:main:dashboard:tombstoned";
  const sourceSessionId = "tombstoned-session";
  await writeSessionStore({
    entries: {
      [sourceKey]: sessionStoreEntry(sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        modelSelectionLocked: true,
        pinnedAt: 1,
        sandbox: "required",
        spawnedCwd: "/tmp/recovered-worktree",
        mainRestartRecovery: {
          cycleId: "cycle-tombstoned",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
    messages: [
      { role: "user", content: "finish the interrupted implementation" },
      { role: "assistant", content: [{ type: "text", text: "I reached the final check." }] },
    ],
  });
  const sourceTranscriptBefore = await loadTranscriptEvents({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
  });

  type RecoveryPayload = {
    key: string;
    sessionId: string;
    continuation: { status: string; runId?: string };
  };
  const [recovered, concurrentRetry] = await Promise.all([
    directSessionReq<RecoveryPayload>("sessions.recover", { agentId: "main", key: sourceKey }),
    directSessionReq<RecoveryPayload>("sessions.recover", { agentId: "main", key: sourceKey }),
  ]);

  expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
  expect(recovered.payload).toMatchObject({
    key: expect.stringMatching(/^agent:main:dashboard:/),
    sessionId: expect.any(String),
    continuation: { status: "started", runId: expect.any(String) },
  });
  const successorKey = recovered.payload?.key ?? "";
  const successorSessionId = recovered.payload?.sessionId ?? "";
  expect(concurrentRetry).toMatchObject({
    ok: true,
    payload: {
      key: successorKey,
      sessionId: successorSessionId,
      continuation: { status: "started" },
    },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: successorKey, storePath })).toMatchObject({
    agentHarnessId: "codex",
    agentRuntimeOverride: "codex",
    modelSelectionLocked: true,
    modelOverride: "gpt-5.6-sol",
    previousSessionId: sourceSessionId,
    providerOverride: "openai",
    sandbox: "required",
    spawnedCwd: "/tmp/recovered-worktree",
  });
  const archivedSource = loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath });
  expect(archivedSource).toMatchObject({
    archivedAt: expect.any(Number),
    mainRestartRecovery: {
      revision: 5,
      tombstone: {
        recoveredSessionId: successorSessionId,
        recoveredSessionKey: successorKey,
      },
    },
  });
  expect(archivedSource).not.toHaveProperty("pinnedAt");
  await expect(
    loadTranscriptEvents({
      agentId: "main",
      sessionId: sourceSessionId,
      sessionKey: sourceKey,
      storePath,
    }),
  ).resolves.toEqual(sourceTranscriptBefore);
  expect(
    JSON.stringify(
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: successorSessionId,
        sessionKey: successorKey,
        storePath,
      }),
    ),
  ).toContain("finish the interrupted implementation");

  const repeated = await directSessionReq<typeof recovered.payload>("sessions.recover", {
    agentId: "main",
    key: sourceKey,
  });
  expect(repeated).toMatchObject({
    ok: true,
    payload: {
      key: successorKey,
      sessionId: successorSessionId,
      continuation: { status: "started" },
    },
  });
});

test("sessions.recover rejects a healthy session", async () => {
  await createSessionStoreDir();
  const key = "agent:main:dashboard:healthy";
  await writeSessionStore({ entries: { [key]: sessionStoreEntry("healthy-session") } });
  const recovered = await directSessionReq("sessions.recover", { agentId: "main", key });
  expect(recovered).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining("tombstoned") },
  });
});

test.each([false, true])(
  "sessions.recover uses the recovering creator's sandbox requirement (%s), not its source's",
  async (required) => {
    const { storePath } = await createSessionStoreDir();
    const owner = ensureProfileForEmail("recovery-source-owner@example.test");
    const recovering = ensureProfileForEmail("recovery-requester@example.test");
    setUserProfileRole(recovering.id, "requester");
    const sourceKey = "agent:main:dashboard:creator-policy-recovery";
    const sourceStamp = {
      createdVia: "operator" as const,
      createdActor: { type: "human" as const, id: owner.id },
      createdAt: 123,
      ...(!required ? { sandbox: "required" as const } : {}),
    };
    await seedRecoverableSession({
      sourceKey,
      sourceSessionId: "creator-policy-recovery-source",
      storePath,
      overrides: { ...sourceStamp, visibility: "shared" },
    });
    const cfg = {
      ...getRuntimeConfig(),
      gateway: {
        ...getRuntimeConfig().gateway,
        roles: {
          default: "requester",
          definitions: {
            requester: {
              sessions: { others: "write" as const },
              agents: "*" as const,
              scopes: ["operator.read" as const, "operator.write" as const],
              ...(required ? { sandbox: "required" as const } : {}),
            },
          },
        },
      },
    };
    const request = {
      client: {
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "test" as const, mode: "test" as const, platform: "test", version: "test" },
          role: "operator",
          scopes: ["operator.write"],
        },
        authenticatedUserProfile: {
          profileId: recovering.id,
          displayName: recovering.displayName,
          hasAvatar: false,
          updatedAt: recovering.updatedAt,
        },
      },
      context: { getRuntimeConfig: () => cfg },
    };
    type RecoveryPayload = { key: string; continuation: { status: string } };
    const recovered = await directSessionReq<RecoveryPayload>(
      "sessions.recover",
      { agentId: "main", key: sourceKey },
      request,
    );
    expect(recovered).toMatchObject({
      ok: true,
      payload: { key: expect.any(String), continuation: { status: "started" } },
    });
    const scope = { agentId: "main", sessionKey: recovered.payload?.key ?? "", storePath };
    const successor = loadSessionEntry(scope);
    expect(successor).toMatchObject({
      createdVia: "operator",
      createdActor: { type: "human", id: recovering.id },
      createdAt: expect.any(Number),
    });
    expect(successor?.sandbox).toBe(required ? "required" : undefined);
    expect(successor?.createdAt).not.toBe(sourceStamp.createdAt);
    const repeated = await directSessionReq<RecoveryPayload>(
      "sessions.recover",
      { agentId: "main", key: sourceKey },
      request,
    );
    expect(repeated.payload?.key).toBe(scope.sessionKey);
    expect(loadSessionEntry(scope)).toMatchObject({
      createdActor: successor?.createdActor,
      createdAt: successor?.createdAt,
    });
    expect(loadSessionEntry(scope)?.sandbox).toBe(successor?.sandbox);
    const source = loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath });
    expect(source).toMatchObject(sourceStamp);
    expect(source?.sandbox).toBe(required ? undefined : "required");
  },
);

test("sessions.recover cannot create a successor on an agent excluded by the caller's role", async () => {
  const { storePath } = await createSessionStoreDir();
  const profile = ensureProfileForEmail("restricted-session-recovery@example.com");
  setUserProfileRole(profile.id, "guest");
  const key = "agent:main:dashboard:role-denied-recovery";
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("role-denied-recovery-session", {
        status: "failed",
        abortedLastRun: true,
        createdActor: { type: "human", id: profile.id },
        mainRestartRecovery: {
          cycleId: "cycle-role-denied-recovery",
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    },
  });
  const cfg = {
    ...getRuntimeConfig(),
    gateway: {
      ...getRuntimeConfig().gateway,
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" as const },
            agents: ["guest-only"],
            scopes: ["operator.read" as const, "operator.write" as const],
          },
        },
      },
    },
  };
  const client = {
    connect: { role: "operator", scopes: ["operator.write"] },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: profile.displayName,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    },
  } as never;

  const recovered = await directSessionReq(
    "sessions.recover",
    { agentId: "main", key },
    { client, context: { getRuntimeConfig: () => cfg } },
  );

  expect(recovered).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: expect.stringContaining('agent "main"') },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
    mainRestartRecovery: {
      revision: 1,
      tombstone: { reason: "automatic recovery exhausted" },
    },
  });
});

test("sessions.recover revalidates participation at the recovery writer commit", async () => {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = "agent:main:dashboard:recovery-participation-race";
  const sourceSessionId = "recovery-participation-race-source";
  await writeSessionStore({
    entries: {
      [sourceKey]: sessionStoreEntry(sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        visibility: "read-only",
        createdActor: { type: "human", id: "owner" },
        mainRestartRecovery: {
          cycleId: "cycle-recovery-participation-race",
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
    messages: [{ role: "user", content: "recover this private session" }],
  });
  addSessionMember(
    { agentId: "main", sessionKey: sourceKey, storePath },
    { identityId: "member", addedBy: "owner", expectedSessionId: sourceSessionId },
  );
  const client = {
    authenticatedUserId: "member@example.com",
    authenticatedUserProfile: {
      profileId: "member",
      displayName: "Member",
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: { role: "operator", scopes: ["operator.write"] },
  } as never;
  // Use an already-registered single-key mutation to isolate handler/writer propagation from
  // the separate sessions.recover registry regression covered at the router boundary.
  const authorization = resolveSessionMutationAuthorization({
    client,
    method: "sessions.reset",
    requestParams: { key: sourceKey, agentId: "main" },
    context: { getRuntimeConfig } as never,
  });
  expect(authorization.error).toBeNull();
  if (!authorization.authorization) {
    throw new Error("failed to capture recovery source participation");
  }

  const mutationEntered = createDeferredCore();
  const releaseMutation = createDeferredCore();
  const heldMutation = runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [sourceKey, sourceSessionId],
    run: async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationEntered.promise;
  const requestStarted = createDeferredCore();
  const recovering = directSessionReq(
    "sessions.recover",
    { agentId: "main", key: sourceKey },
    {
      client,
      context: {
        getRuntimeConfig: () => {
          requestStarted.resolve();
          return getRuntimeConfig();
        },
      },
      sessionMutationAuthorization: authorization.authorization,
    },
  );

  try {
    await requestStarted.promise;
    removeSessionMember(
      { agentId: "main", sessionKey: sourceKey, storePath },
      "member",
      undefined,
      sourceSessionId,
    );
  } finally {
    releaseMutation.resolve();
    await heldMutation;
  }

  await expect(recovering).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
  const source = loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath });
  expect(source?.archivedAt).toBeUndefined();
  expect(source?.mainRestartRecovery?.tombstone).not.toHaveProperty("recoveredSessionKey");
  expect(source?.mainRestartRecovery?.tombstone).not.toHaveProperty("recoveredSessionId");
});

test("sessions.recover revalidates runtime authority after its cloud placement reclaim", async () => {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = "agent:main:dashboard:recovery-cloud-authority-race";
  const sourceSessionId = "recovery-cloud-authority-race-source";
  await seedRecoverableSession({ sourceKey, sourceSessionId, storePath });
  let authorityActive = true;
  let placement = recoveryWorkerPlacement({
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    state: "active",
  });
  const reclaim = vi.fn(async (_request: unknown, authorize?: () => void) => {
    authorize?.();
    authorityActive = false;
    placement = recoveryWorkerPlacement({
      sessionId: sourceSessionId,
      sessionKey: sourceKey,
      state: "reclaimed",
    });
    return placement;
  });

  const recovered = await directSessionReq(
    "sessions.recover",
    { agentId: "main", key: sourceKey },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRuntimeIdentity: { kind: "agentRuntime", agentId: "main", sessionKey: sourceKey },
        },
      } as never,
      context: {
        validateAgentRuntimeApprovalAuthority: () => authorityActive,
        workerSessionPlacementService: recoveryPlacementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );

  expect(recovered).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "agent runtime authority is no longer active" },
  });
  expect(reclaim).toHaveBeenCalledOnce();
  const source = loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath });
  expect(source?.archivedAt).toBeUndefined();
  expect(source?.mainRestartRecovery?.tombstone?.recoveredSessionId).toBeUndefined();
});

test("sessions.recover rejects continuation launch after runtime authority closes", async () => {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = "agent:main:dashboard:authority-race";
  const sourceSessionId = "authority-race-source";
  await writeSessionStore({
    entries: {
      [sourceKey]: sessionStoreEntry(sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-authority-race",
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
    messages: [{ role: "user", content: "continue after recovery" }],
  });
  let validations = 0;

  const recovered = await directSessionReq<{
    key: string;
    continuation: { status: string; error?: { message?: string } };
  }>(
    "sessions.recover",
    { agentId: "main", key: sourceKey },
    {
      context: {
        validateAgentRuntimeApprovalAuthority: () => ++validations < 2,
      },
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: sourceKey,
          },
        },
      } as never,
    },
  );

  expect(recovered).toMatchObject({
    ok: true,
    payload: {
      continuation: {
        status: "rejected",
        error: { message: "agent runtime authority is no longer active" },
      },
    },
  });
  expect(validations).toBe(2);
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: recovered.payload?.key ?? "",
      storePath,
    }),
  ).toBeDefined();
});
