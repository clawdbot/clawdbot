// Archive lifecycle tests protect fence-before-cancel, terminal drains, and sentinels.
import { afterEach, expect, test, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { onAgentEvent } from "../infra/agent-events.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { markChatAbortTerminalPersistenceError } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController, removeChatAbortControllerEntry } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  resolveSessionMutationAuthorization,
  resolveSessionSharingTarget,
} from "./session-sharing.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  getGatewayConfigModule,
  getSessionsHandlers,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { registerWorkerInferenceSessionDrain } from "./worker-environments/inference-control-internal.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const sessionAuditGate = vi.hoisted(() => ({
  entered: vi.fn(),
  wait: undefined as Promise<void> | undefined,
}));

vi.mock("./server-methods/session-audit.js", async () => {
  const actual = await vi.importActual<typeof import("./server-methods/session-audit.js")>(
    "./server-methods/session-audit.js",
  );
  return {
    ...actual,
    appendSessionAudit: async (...args: Parameters<typeof actual.appendSessionAudit>) => {
      if (sessionAuditGate.wait) {
        sessionAuditGate.entered();
        await sessionAuditGate.wait;
      }
      await actual.appendSessionAudit(...args);
    },
  };
});

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function activeRunContext(params: {
  runId: string;
  sessionId: string;
  sessionKey: string;
  persistence: ReturnType<typeof createDeferredCore<void>>;
  ownerConnId?: string;
}) {
  const chatAbortControllers = new Map();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    timeoutMs: 60_000,
    ownerConnId: params.ownerConnId,
  });
  if (!registration.entry) {
    throw new Error("expected active run registration");
  }
  const entry = registration.entry;
  const unsubscribe = onAgentEvent((event) => {
    if (
      event.runId !== params.runId ||
      event.stream !== "lifecycle" ||
      event.data.phase !== "end"
    ) {
      return;
    }
    entry.projectSessionTerminalPending = false;
    entry.projectSessionTerminalPersistence = params.persistence.promise;
    void params.persistence.promise.then(
      () => {
        entry.projectSessionTerminalPersistence = undefined;
        entry.projectSessionTerminalPersisted = true;
        removeChatAbortControllerEntry(chatAbortControllers, params.runId, entry);
      },
      (error: unknown) => {
        markChatAbortTerminalPersistenceError(entry, error);
        removeChatAbortControllerEntry(chatAbortControllers, params.runId, entry);
      },
    );
  });
  const chatRunState = createChatRunState();
  return {
    context: {
      agentRunSeq: new Map([[params.runId, 0]]),
      broadcast: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      chatAbortControllers,
      chatRunState,
      logGateway: { warn: vi.fn() },
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => ({
        sessionKey: params.sessionKey,
        clientRunId: params.runId,
      })),
    },
    controller: registration.controller,
    unsubscribe,
  };
}

function identifiedClient(profileId: string): GatewayClient {
  return {
    connId: `${profileId}-connection`,
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
  };
}

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

async function archiveLifecycleRequestContext(
  overrides: Record<string, unknown>,
): Promise<GatewayRequestContext> {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const loadGatewayModelCatalog = async () => [];
  return {
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    getRuntimeConfig,
    loadGatewayModelCatalog,
    readPreparedGatewayModelCatalog: loadGatewayModelCatalog,
    ...overrides,
  } as unknown as GatewayRequestContext;
}

type LifecycleHandlerResponse = {
  ok: boolean;
  payload?: unknown;
  error?: Parameters<RespondFn>[2];
};

function archivePatch(key: string, expectedSessionId: string) {
  return { key, archived: true, expectedSessionId };
}

function archiveTarget(key: string, expectedSessionId: string) {
  return { key, expectedSessionId };
}

function expectArchived(storePath: string, sessionKey: string) {
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
}

async function invokeArchiveHandler(params: {
  authorization: NonNullable<
    ReturnType<typeof resolveSessionMutationAuthorization>["authorization"]
  >;
  client: GatewayClient;
  context: GatewayRequestContext;
  sessionKey: string;
  expectedSessionId: string;
}): Promise<LifecycleHandlerResponse> {
  const handlers = await getSessionsHandlers();
  let response: LifecycleHandlerResponse | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await handlers["sessions.patch"]?.({
    req: {} as never,
    params: archivePatch(params.sessionKey, params.expectedSessionId),
    client: params.client,
    context: params.context,
    isWebchatConnect: () => false,
    sessionMutationAuthorization: params.authorization,
    respond,
  } as never);
  if (!response) {
    throw new Error("sessions.patch did not respond");
  }
  return response;
}

async function invokeVisibilityHandler(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  sessionKey: string;
  visibility: "draft" | "shared";
}): Promise<LifecycleHandlerResponse> {
  const handlers = await getSessionsHandlers();
  let response: LifecycleHandlerResponse | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await handlers["session.visibility.set"]?.({
    params: { sessionKey: params.sessionKey, visibility: params.visibility },
    client: params.client,
    context: params.context,
    respond,
  } as never);
  if (!response) {
    throw new Error("session.visibility.set did not respond");
  }
  return response;
}

test("sessions.patch cancels active work and commits only after admission and terminal persistence drain", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-active";
  const sessionId = "session-archive-active";
  const runId = "run-archive-active";
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId) },
  });
  const interrupted = createDeferredCore();
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {},
    onInterrupt: () => interrupted.resolve(),
  });
  const persistence = createDeferredCore();
  const active = activeRunContext({
    runId,
    sessionId,
    sessionKey,
    persistence,
    ownerConnId: "different-connection",
  });
  try {
    const archive = directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: sessionId },
      {
        context: active.context,
        client: { connId: "archive-writer", connect: { scopes: ["operator.write"] } } as never,
      },
    );
    await interrupted.promise;
    expect(active.controller.signal.aborted).toBe(true);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();

    let replacementAdmitted = false;
    const replacement = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {
        replacementAdmitted = true;
        if (loadSessionEntry({ storePath, sessionKey })?.archivedAt !== undefined) {
          throw new Error("archived");
        }
      },
    }).then(
      (lease) => lease,
      (error: unknown) => error,
    );
    await Promise.resolve();
    expect(replacementAdmitted).toBe(false);

    admission.release();
    await Promise.resolve();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    persistence.resolve();

    const archived = await archive;
    expect(archived.ok).toBe(true);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
    expect(await replacement).toBeInstanceOf(Error);
  } finally {
    admission.release();
    active.unsubscribe();
  }
});

test("sharing revocation fences archive before cancellation and forces fresh authorization", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-sharing-revocation";
  const sessionId = "session-archive-sharing-revocation";
  const runId = "run-archive-sharing-revocation";
  const owner = identifiedClient("archive-owner");
  const viewer = identifiedClient("archive-viewer");
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, {
        createdActor: { type: "human", id: "archive-owner" },
        visibility: "shared",
      }),
    },
  });
  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });
  const persistence = createDeferredCore();
  const active = activeRunContext({ runId, sessionId, sessionKey, persistence });
  const requestContext = await archiveLifecycleRequestContext(active.context);
  const placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const reclaim = vi.fn();
  requestContext.workerSessionPlacementService = placementReader(() => placement);
  requestContext.workerPlacementDispatchService = { dispatch: vi.fn(), reclaim };
  const authorized = resolveSessionMutationAuthorization({
    client: viewer,
    method: "sessions.patch",
    requestParams: { key: sessionKey, archived: true },
    context: requestContext,
  });
  expect(authorized.error).toBeNull();
  if (!authorized.authorization) {
    throw new Error("expected captured archive authorization");
  }
  const sharingTarget = resolveSessionSharingTarget({
    cfg: requestContext.getRuntimeConfig(),
    sessionKey,
  });
  if (!sharingTarget) {
    throw new Error("expected resolved sharing target");
  }

  const releaseAudit = createDeferredCore();
  sessionAuditGate.entered.mockClear();
  sessionAuditGate.wait = releaseAudit.promise;
  let sharing: Promise<LifecycleHandlerResponse> | undefined;
  let archive: Promise<LifecycleHandlerResponse> | undefined;

  try {
    let sharingSettled = false;
    sharing = invokeVisibilityHandler({
      client: owner,
      context: requestContext,
      sessionKey,
      visibility: "draft",
    }).finally(() => {
      sharingSettled = true;
    });
    await vi.waitFor(() => {
      expect(sessionAuditGate.entered).toHaveBeenCalledOnce();
      expect(
        isSessionLifecycleMutationActive(sharingTarget.storePath, [sessionKey, sessionId]),
      ).toBe(true);
    });
    expect(sharingSettled).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey })?.visibility).toBe("draft");

    let archiveSettled = false;
    archive = invokeArchiveHandler({
      authorization: authorized.authorization,
      client: viewer,
      context: requestContext,
      sessionKey,
      expectedSessionId: sessionId,
    }).finally(() => {
      archiveSettled = true;
    });
    await Promise.resolve();
    expect(archiveSettled).toBe(false);
    expect(interrupted).toBe(false);
    expect(active.controller.signal.aborted).toBe(false);
    expectNoSessionQueueCleanup();
    expect(reclaim).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();

    releaseAudit.resolve();
    expect(await sharing).toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey })?.visibility).toBe("draft");

    expect(await archive).toMatchObject({
      ok: false,
      error: { details: { code: "SESSION_PARTICIPATION_REQUIRED" } },
    });
    expect(interrupted).toBe(false);
    expect(active.controller.signal.aborted).toBe(false);
    expectNoSessionQueueCleanup();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  } finally {
    sessionAuditGate.wait = undefined;
    releaseAudit.resolve();
    admission.release();
    await Promise.allSettled([...(sharing ? [sharing] : []), ...(archive ? [archive] : [])]);
    active.unsubscribe();
  }
});

test("archive retains the lifecycle fence until drain and commit before sharing proceeds", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-before-sharing";
  const sessionId = "session-archive-before-sharing";
  const runId = "run-archive-before-sharing";
  const owner = identifiedClient("archive-owner");
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, {
        createdActor: { type: "human", id: "archive-owner" },
        visibility: "shared",
      }),
    },
  });
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {},
  });
  const persistence = createDeferredCore();
  const active = activeRunContext({ runId, sessionId, sessionKey, persistence });
  const requestContext = await archiveLifecycleRequestContext(active.context);
  let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const reclaimGate = createDeferredCore();
  const reclaim = vi.fn(async () => {
    await reclaimGate.promise;
    placement = workerPlacement({ sessionId, sessionKey, state: "reclaimed" });
    return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
  });
  requestContext.workerSessionPlacementService = placementReader(() => placement);
  requestContext.workerPlacementDispatchService = { dispatch: vi.fn(), reclaim };
  const authorized = resolveSessionMutationAuthorization({
    client: owner,
    method: "sessions.patch",
    requestParams: { key: sessionKey, archived: true },
    context: requestContext,
  });
  expect(authorized.error).toBeNull();
  if (!authorized.authorization) {
    throw new Error("expected captured archive authorization");
  }
  let archive: Promise<LifecycleHandlerResponse> | undefined;
  let sharing: Promise<LifecycleHandlerResponse> | undefined;

  try {
    archive = invokeArchiveHandler({
      authorization: authorized.authorization,
      client: owner,
      context: requestContext,
      sessionKey,
      expectedSessionId: sessionId,
    });
    await vi.waitFor(() => expect(active.controller.signal.aborted).toBe(true));

    let sharingSettled = false;
    sharing = invokeVisibilityHandler({
      client: owner,
      context: requestContext,
      sessionKey,
      visibility: "draft",
    }).finally(() => {
      sharingSettled = true;
    });
    await Promise.resolve();
    expect(sharingSettled).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey })?.visibility).toBe("shared");
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();

    admission.release();
    persistence.resolve();
    await vi.waitFor(() => expect(reclaim).toHaveBeenCalledOnce());
    expect(sharingSettled).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    reclaimGate.resolve();
    expect(await archive).toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
    expect(await sharing).toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      archivedAt: expect.any(Number),
      visibility: "draft",
    });
  } finally {
    admission.release();
    persistence.resolve();
    reclaimGate.resolve();
    await Promise.allSettled([...(archive ? [archive] : []), ...(sharing ? [sharing] : [])]);
    active.unsubscribe();
  }
});

test("alias archive lets the canonical cloud reclaim barrier reenter without deadlock", async () => {
  const { storePath } = await createSessionStoreDir();
  const aliasKey = "aaa-archive-cloud-alias";
  const sessionKey = `agent:main:${aliasKey}`;
  const sessionId = "session-archive-cloud-alias";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const reclaimEntered = createDeferredCore();
  const allowNestedReclaim = createDeferredCore();
  const contenderRelease = createDeferredCore();
  const reclaim = vi.fn(async () => {
    reclaimEntered.resolve();
    await allowNestedReclaim.promise;
    await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [aliasKey, sessionKey, sessionId],
      run: async () => {},
    });
    placement = workerPlacement({ sessionId, sessionKey, state: "reclaimed" });
    return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
  });
  const archive = directSessionReq(
    "sessions.patch",
    { key: aliasKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerSessionPlacementService: placementReader(() => placement),
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      },
    },
  );
  await reclaimEntered.promise;
  const contender = runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [aliasKey],
    run: async () => await contenderRelease.promise,
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  allowNestedReclaim.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      archive,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("nested alias reclaim deadlocked")), 2_000);
      }),
    ]);
    expect(result.ok).toBe(true);
    expect(reclaim).toHaveBeenCalledOnce();
    expect(placement.state).toBe("reclaimed");
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    contenderRelease.resolve();
    allowNestedReclaim.resolve();
    await Promise.allSettled([archive, contender]);
  }
});

test("sessions.patch returns retryable UNAVAILABLE when runtime drain does not settle", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-stuck";
  const sessionId = "session-archive-stuck";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  embeddedRunMock.activeIds.add(sessionId);
  embeddedRunMock.waitResults.set(sessionId, false);

  const archived = await directSessionReq("sessions.patch", archivePatch(sessionKey, sessionId));

  expect(archived.ok).toBe(false);
  expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch rechecks authoritative worker work before projection and releases the drain", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-worker-recheck";
  const sessionId = "session-archive-worker-recheck";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const release = vi.fn();
  const workerEnvironmentService = {
    cancelInferenceForSession: vi.fn(() => []),
    hasInferenceForSession: vi.fn(() => false),
    resolveInferenceSessionForRunId: vi.fn(),
  };
  registerWorkerInferenceSessionDrain(workerEnvironmentService, () => ({
    drained: Promise.resolve(),
    hasWork: () => true,
    release,
  }));

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerEnvironmentService,
      },
    },
  );

  expect(archived.ok).toBe(false);
  expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
});

test("sessions.patch fails closed when active worker inference has no archive drain", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-worker-drain-unavailable";
  const sessionId = "session-archive-worker-drain-unavailable";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerEnvironmentService: {
          cancelInferenceForSession: vi.fn(() => []),
          hasInferenceForSession: vi.fn(() => true),
          resolveInferenceSessionForRunId: vi.fn(),
        },
      },
    },
  );

  expect(archived.ok).toBe(false);
  expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch releases the archive drain without appending a transcript message", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-drain-no-transcript";
  const sessionId = "session-archive-drain-no-transcript";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const release = vi.fn();
  const append = vi.spyOn(SessionManager, "appendMessageToTranscript");
  try {
    const archived = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: sessionId },
      {
        client: identifiedClient("archive-reviewer"),
        context: {
          workerEnvironmentService: {
            beginInferenceSessionDrain: vi.fn(() => ({
              drained: Promise.resolve(),
              hasWork: () => false,
              release,
            })),
            cancelInferenceForSession: vi.fn(() => []),
            hasInferenceForSession: vi.fn(() => false),
            resolveInferenceSessionForRunId: vi.fn(),
          },
        },
      },
    );

    expect(archived.ok).toBe(true);
    expect(append).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
  } finally {
    append.mockRestore();
  }
});

test("sessions.patch returns UNAVAILABLE when terminal persistence fails", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-persistence-failure";
  const sessionId = "session-archive-persistence-failure";
  const runId = "run-archive-persistence-failure";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const persistence = createDeferredCore();
  const active = activeRunContext({ runId, sessionId, sessionKey, persistence });
  try {
    const archive = directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: sessionId },
      {
        context: active.context,
      },
    );
    await vi.waitFor(() => expect(active.controller.signal.aborted).toBe(true));
    persistence.reject(new Error("disk full"));

    const archived = await archive;
    expect(archived.ok).toBe(false);
    expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  } finally {
    active.unsubscribe();
  }
});

test("sessions.patch rejects main and global archives before cancellation side effects", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("session-main") } });
  embeddedRunMock.activeIds.add("session-main");

  const main = await directSessionReq("sessions.patch", { key: "main", archived: true });
  expect(main.ok).toBe(false);
  expect(main.error?.message).toContain("main session");
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expectNoSessionQueueCleanup();
  expect(loadSessionEntry({ storePath, sessionKey: "main" })?.archivedAt).toBeUndefined();

  const globalFixture = await createConfiguredGlobalAgentSessionStore();
  try {
    embeddedRunMock.activeIds.add("sess-main-global");
    const global = await directSessionReq("sessions.patch", {
      key: "global",
      agentId: "main",
      archived: true,
    });
    expect(global.ok).toBe(false);
    expect(global.error?.message).toContain("main session");
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expectNoSessionQueueCleanup();
  } finally {
    await resetConfiguredGlobalAgentSessionStore(globalFixture);
  }
});

test("sessions.patch rejects unknown without materializing a session entry", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: {} });

  const archived = await directSessionReq("sessions.patch", { key: "unknown", archived: true });

  expect(archived.ok).toBe(false);
  expect(archived.error?.message).toContain("unknown session sentinel");
  expect(loadSessionEntry({ storePath, sessionKey: "unknown" })).toBeUndefined();
  expectNoSessionQueueCleanup();
});

test("sessions.patchMany independently archives active and idle sessions in target order", async () => {
  const { storePath } = await createSessionStoreDir();
  const activeKey = "agent:main:archive-batch-active";
  const idleKey = "agent:main:archive-batch-idle";
  const activeSessionId = "session-batch-active";
  const idleSessionId = "session-batch-idle";
  await writeSessionStore({
    entries: {
      [activeKey]: sessionStoreEntry(activeSessionId),
      [idleKey]: sessionStoreEntry(idleSessionId),
    },
  });
  embeddedRunMock.activeIds.add(activeSessionId);
  embeddedRunMock.waitResults.set(activeSessionId, true);

  const result = await directSessionReq<{ outcomes: Array<{ key: string; ok: boolean }> }>(
    "sessions.patchMany",
    {
      targets: [archiveTarget(activeKey, activeSessionId), archiveTarget(idleKey, idleSessionId)],
      patch: { archived: true },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload?.outcomes).toEqual([
    { key: activeKey, ok: true },
    { key: idleKey, ok: true },
  ]);
  expectArchived(storePath, activeKey);
  expectArchived(storePath, idleKey);
});

test("sessions.patchMany prepares independent archive drains concurrently and releases in target order", async () => {
  const { storePath } = await createSessionStoreDir();
  const firstKey = "agent:main:archive-batch-concurrent-first";
  const secondKey = "agent:main:archive-batch-concurrent-second";
  const firstSessionId = "session-batch-concurrent-first";
  const secondSessionId = "session-batch-concurrent-second";
  await writeSessionStore({
    entries: {
      [firstKey]: sessionStoreEntry(firstSessionId),
      [secondKey]: sessionStoreEntry(secondSessionId),
    },
  });
  const firstDrained = createDeferredCore();
  const firstRelease = vi.fn();
  const secondRelease = vi.fn();
  const beginInferenceSessionDrain = vi.fn((sessionId: string) => ({
    drained: sessionId === firstSessionId ? firstDrained.promise : Promise.resolve(),
    hasWork: () => false,
    release: sessionId === firstSessionId ? firstRelease : secondRelease,
  }));

  const archive = directSessionReq<{ outcomes: Array<{ key: string; ok: boolean }> }>(
    "sessions.patchMany",
    {
      targets: [archiveTarget(firstKey, firstSessionId), archiveTarget(secondKey, secondSessionId)],
      patch: { archived: true },
    },
    {
      context: {
        workerEnvironmentService: {
          beginInferenceSessionDrain,
          cancelInferenceForSession: vi.fn(() => []),
          hasInferenceForSession: vi.fn(() => false),
          resolveInferenceSessionForRunId: vi.fn(),
        },
      },
    },
  );

  await vi.waitFor(() => expect(beginInferenceSessionDrain).toHaveBeenCalledTimes(2));
  expect(beginInferenceSessionDrain.mock.calls.map(([sessionId]) => sessionId)).toEqual([
    firstSessionId,
    secondSessionId,
  ]);
  expect(firstRelease).not.toHaveBeenCalled();
  expect(secondRelease).not.toHaveBeenCalled();
  firstDrained.resolve();

  const result = await archive;
  expect(result.payload?.outcomes).toEqual([
    { key: firstKey, ok: true },
    { key: secondKey, ok: true },
  ]);
  expect(firstRelease).toHaveBeenCalledOnce();
  expect(secondRelease).toHaveBeenCalledOnce();
  expect(firstRelease.mock.invocationCallOrder[0]).toBeLessThan(
    secondRelease.mock.invocationCallOrder[0]!,
  );
  expectArchived(storePath, firstKey);
  expectArchived(storePath, secondKey);
});

test("sessions.patchMany attempts every archive drain release without masking success", async () => {
  const { storePath } = await createSessionStoreDir();
  const firstKey = "agent:main:archive-release-throws-first";
  const secondKey = "agent:main:archive-release-after-throw";
  const firstSessionId = "session-archive-release-throws-first";
  const secondSessionId = "session-archive-release-after-throw";
  await writeSessionStore({
    entries: {
      [firstKey]: sessionStoreEntry(firstSessionId),
      [secondKey]: sessionStoreEntry(secondSessionId),
    },
  });
  const firstRelease = vi.fn(() => {
    throw new Error("release failed");
  });
  const secondRelease = vi.fn();

  const result = await directSessionReq<{ outcomes: Array<{ key: string; ok: boolean }> }>(
    "sessions.patchMany",
    {
      targets: [archiveTarget(firstKey, firstSessionId), archiveTarget(secondKey, secondSessionId)],
      patch: { archived: true },
    },
    {
      context: {
        workerEnvironmentService: {
          beginInferenceSessionDrain: vi.fn((sessionId: string) => ({
            drained: Promise.resolve(),
            hasWork: () => false,
            release: sessionId === firstSessionId ? firstRelease : secondRelease,
          })),
          cancelInferenceForSession: vi.fn(() => []),
          hasInferenceForSession: vi.fn(() => false),
          resolveInferenceSessionForRunId: vi.fn(),
        },
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload?.outcomes).toEqual([
    { key: firstKey, ok: true },
    { key: secondKey, ok: true },
  ]);
  expect(firstRelease).toHaveBeenCalledOnce();
  expect(secondRelease).toHaveBeenCalledOnce();
  expectArchived(storePath, firstKey);
  expectArchived(storePath, secondKey);
});

test("sessions.patchMany isolates a failed archive drain and continues later targets", async () => {
  const { storePath } = await createSessionStoreDir();
  const stuckKey = "agent:main:archive-batch-stuck";
  const idleKey = "agent:main:archive-batch-after-stuck";
  const stuckSessionId = "session-batch-stuck";
  const idleSessionId = "session-batch-after-stuck";
  await writeSessionStore({
    entries: {
      [stuckKey]: sessionStoreEntry(stuckSessionId),
      [idleKey]: sessionStoreEntry(idleSessionId),
    },
  });
  embeddedRunMock.activeIds.add(stuckSessionId);
  embeddedRunMock.waitResults.set(stuckSessionId, false);

  const result = await directSessionReq<{
    outcomes: Array<{ error?: { code: string; retryable?: boolean }; key: string; ok: boolean }>;
  }>("sessions.patchMany", {
    targets: [archiveTarget(stuckKey, stuckSessionId), archiveTarget(idleKey, idleSessionId)],
    patch: { archived: true },
  });

  expect(result.ok).toBe(true);
  expect(result.payload?.outcomes).toEqual([
    {
      key: stuckKey,
      ok: false,
      error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    },
    { key: idleKey, ok: true },
  ]);
  expect(loadSessionEntry({ storePath, sessionKey: stuckKey })?.archivedAt).toBeUndefined();
  expectArchived(storePath, idleKey);
});

test("sessions.patch rejects a generation replaced after the exact preparation read", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-generation-race";
  const sessionId = "session-archive-generation-race";
  const runId = "run-archive-generation-race";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const persistence = createDeferredCore();
  const active = activeRunContext({ runId, sessionId, sessionKey, persistence });
  let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
  const dispatch = vi.fn();
  const reclaim = vi.fn(async () => {
    placement = workerPlacement({ sessionId, sessionKey, state: "reclaimed" });
    return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
  });
  try {
    const archive = directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: sessionId },
      {
        context: {
          ...active.context,
          workerSessionPlacementService: placementReader(() => placement),
          workerPlacementDispatchService: { dispatch, reclaim },
        },
      },
    );
    await vi.waitFor(() => expect(active.controller.signal.aborted).toBe(true));
    await upsertSessionEntryCore(
      { storePath, sessionKey },
      { sessionId: "session-archive-generation-replacement", updatedAt: 2 },
    );
    persistence.resolve();

    const archived = await archive;
    expect(archived.ok).toBe(false);
    expect(archived.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "session-changed" },
    });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      sessionId: "session-archive-generation-replacement",
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    expect(reclaim).toHaveBeenCalledOnce();
    expect(placement.state).toBe("reclaimed");
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    active.unsubscribe();
  }
});
