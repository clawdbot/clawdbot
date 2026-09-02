import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  errorShape,
  type SessionsForkResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  createSessionEntryWithTranscript,
  listSessionEntriesCore,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sqliteSessionScope from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createRuntimeAgent } from "../../plugins/runtime/runtime-agent.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as storeWriterQueue from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";

const cfg = { agents: { entries: { main: {} } } };
const mutationMethods = ["sessions.fork", "sessions.rewind", "sessions.branches.switch"] as const;
type MutationMethod = (typeof mutationMethods)[number];
type SourceScope = Awaited<ReturnType<typeof seedMessageCutSource>>;

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => resetPluginRuntimeStateForTest());

it.each(mutationMethods)(
  "rejects %s while its source initializer is still running",
  async (method) => {
    await withOpenClawTestState({ label: "message-cut-initializing-source" }, async (testState) => {
      await testState.writeConfig(cfg);
      const runtime = createRuntimeAgent();
      const key = "agent:main:dashboard:initializing-source";
      const initialized = createDeferredCore();
      const release = createDeferredCore();
      let source: SourceScope | undefined;
      const creation = runtime.session.createSessionEntry({
        cfg,
        key,
        initialEntry: { agentHarnessId: "test-harness" },
        afterCreate: async (entry) => {
          source = { agentId: entry.agentId, sessionKey: key, sessionId: entry.sessionId };
          await appendTranscriptMessage(source, {
            eventId: "user-2",
            parentId: null,
            message: { role: "user", content: "Pending history" },
          });
          await appendTranscriptMessage(source, {
            eventId: "alternate-user",
            parentId: null,
            message: { role: "user", content: "Alternate pending history" },
          });
          await appendTranscriptEvent(source, {
            type: "leaf",
            id: "pending-leaf",
            parentId: "alternate-user",
            targetId: "user-2",
          });
          initialized.resolve();
          await release.promise;
        },
      });
      const creationResult = creation.then(
        (created) => ({ created }),
        (error: unknown) => ({ error }),
      );
      let mutation: ReturnType<typeof invokeMessageCut> | undefined;
      try {
        await initialized.promise;
        const scope = expectDefined(source, "pending source");
        const before = await readMutationStorage(scope);
        mutation = invokeMessageCut(method, scope);
        // The initializer remains blocked: rejection must not wait on its lifecycle fence.
        await vi.waitFor(() => expect(mutation?.respond).toHaveBeenCalled());
        expect(await mutation.error).toBeUndefined();
        expect(mutation.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.UNAVAILABLE,
            message: expect.stringContaining("initializing"),
          }),
        );
        expect(await readMutationStorage(scope)).toEqual(before);
      } finally {
        release.resolve();
        await creationResult;
        await mutation?.error;
      }
      expect(await creationResult).toHaveProperty("created.entry.sessionId", source?.sessionId);
    });
  },
);

async function seedMessageCutSource(
  incognito = false,
  identity?: { sessionKey: string; sessionId: string },
) {
  const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}source`;
  const scope = { agentId: "main", sessionKey, sessionId: "message-fork-source", ...identity };
  const created = await createSessionEntryWithTranscript(scope, () => ({
    ok: true,
    entry: {
      sessionId: scope.sessionId,
      lifecycleRevision: "message-fork-source-lifecycle",
      updatedAt: Date.now(),
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: "owner" },
      ...(incognito ? { incognito: true as const } : {}),
    },
  }));
  expect(created.ok).toBe(true);
  for (const message of [
    { eventId: "user-1", parentId: null, role: "user", content: "Remember lighthouse." },
    { eventId: "assistant-1", parentId: "user-1", role: "assistant", content: "Lighthouse." },
    { eventId: "user-2", parentId: "assistant-1", role: "user", content: "What did I say?" },
    { eventId: "alternate-user", parentId: null, role: "user", content: "An alternate branch." },
  ]) {
    await appendTranscriptMessage(scope, {
      eventId: message.eventId,
      parentId: message.parentId,
      message: { role: message.role, content: message.content },
    });
  }
  await appendTranscriptEvent(scope, {
    type: "leaf",
    id: "active-leaf",
    parentId: "alternate-user",
    targetId: "user-2",
  });
  return scope;
}

function context(): GatewayRequestContext {
  return {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
  } as unknown as GatewayRequestContext;
}

it.each([
  { kind: "visible", hidden: false },
  { kind: "hidden internal-effects", hidden: true },
])("lists $kind session branches without decoding unrelated metadata", async ({ hidden }) => {
  await withOpenClawTestState({ label: "branch-list-bounded-read" }, async (state) => {
    await state.writeConfig(cfg);
    const identity = hidden
      ? resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "branch-list-hidden" })
      : undefined;
    const scope = await seedMessageCutSource(false, identity);
    const unrelatedPrompt = "unrelated-session-skill-prompt".repeat(128);
    for (let index = 0; index < 3; index += 1) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: `agent:main:unrelated-${index}` },
        {
          sessionId: `unrelated-${index}`,
          updatedAt: index + 1,
          skillsSnapshot: { prompt: unrelatedPrompt, skills: [] },
        },
      );
    }
    const method = "sessions.branches.list";
    const params = { sessionKey: scope.sessionKey };
    const respond = vi.fn<RespondFn>();
    const parse = vi.spyOn(JSON, "parse");
    try {
      await expectDefined(
        sessionRewindHandlers[method],
        method,
      )({
        req: { type: "req", id: "branch-list-bounded-read", method, params },
        params,
        respond,
        context: context(),
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          branches: hidden
            ? []
            : expect.arrayContaining([
                expect.objectContaining({ leafEntryId: "user-2", active: true }),
                expect.objectContaining({ leafEntryId: "alternate-user", active: false }),
              ]),
        },
        undefined,
      );
      expect(parse.mock.calls.filter(([text]) => text.includes(unrelatedPrompt))).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
  });
});

function mutationParams(method: MutationMethod, sessionKey: string) {
  return {
    sessionKey,
    ...(method === "sessions.branches.switch"
      ? { leafEntryId: "alternate-user" }
      : { entryId: "user-2" }),
  };
}

function invokeMessageCut(
  method: MutationMethod,
  scope: SourceScope,
  options: Partial<
    Pick<
      GatewayRequestHandlerOptions,
      "client" | "context" | "sessionMutationCommitGuard" | "sessionMutationAuthorization"
    >
  > = {},
) {
  const params = mutationParams(method, scope.sessionKey);
  const respond = vi.fn<RespondFn>();
  const completion = (async () => {
    await expectDefined(
      sessionRewindHandlers[method],
      `${method} handler`,
    )({
      req: { type: "req", id: "message-cut-storage", method, params },
      params,
      respond,
      context: context(),
      client: null,
      isWebchatConnect: () => false,
      ...options,
    });
  })();
  // Observe rejection immediately while the test controls an earlier queued writer.
  const error = completion.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  return { respond, error };
}

it.each(mutationMethods)(
  "observes initialization written by another process for %s",
  async (method) => {
    await withOpenClawTestState({ label: "message-cut-initialization-cache" }, async (state) => {
      await state.writeConfig(cfg);
      const scope = await seedMessageCutSource();
      // Another process can publish a pending row without touching this process's entry cache.
      listSessionEntriesCore({ agentId: scope.agentId });
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      const peer = new DatabaseSync(database.path);
      try {
        peer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.initializationPending', json('true')) WHERE session_key = ?",
          )
          .run(scope.sessionKey);
        const mutation = invokeMessageCut(method, scope);
        expect(await mutation.error).toBeUndefined();
        expect(mutation.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.UNAVAILABLE,
            message: expect.stringContaining("initializing"),
          }),
        );
        expect(loadSessionEntry({ ...scope, readConsistency: "latest" })?.sessionId).toBe(
          scope.sessionId,
        );
      } finally {
        peer.close();
      }
    });
  },
);

async function readMutationStorage(scope: SourceScope) {
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  const db = getSessionKysely(database.db);
  return {
    source: loadSessionEntry(scope),
    history: await loadTranscriptEvents(scope),
    sessions: listSessionEntriesCore({ agentId: scope.agentId }),
    // Include every transcript generation so a rejected copy cannot leave orphaned private rows.
    transcripts: executeSqliteQuerySync(
      database.db,
      db.selectFrom("transcript_events").selectAll().orderBy("seq"),
    ).rows,
  };
}

async function revokeDuringWriterWait(
  scope: SourceScope,
  invoke: () => ReturnType<typeof invokeMessageCut>,
  revoke: () => void | Promise<void>,
) {
  const resolved = resolveSqliteScope(scope);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const heldWriter = runExclusiveSqliteSessionWrite(resolved, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const enqueueWrite = sqliteSessionScope.runExclusiveSqliteSessionWrite;
  let sourceWriteQueued = false;
  const writer = vi
    .spyOn(sqliteSessionScope, "runExclusiveSqliteSessionWrite")
    .mockImplementation((writeScope, operation) => {
      const pending = enqueueWrite(writeScope, operation);
      if ("sessionKey" in writeScope && writeScope.sessionKey === scope.sessionKey) {
        sourceWriteQueued = true;
      }
      return pending;
    });
  const mutation = invoke();
  try {
    // Branch seeding also queues database-wide projection work. Observe the source-scoped
    // mutation's actual enqueue instead of counting unrelated writers in the same queue.
    await vi.waitFor(() => {
      expect(sourceWriteQueued).toBe(true);
    });
    await revoke();
  } finally {
    writer.mockRestore();
    release.resolve();
    await heldWriter;
    await mutation.error;
  }
  return mutation;
}

async function revokeWithPublicLifecyclePredecessor(
  scope: SourceScope,
  requestContext: GatewayRequestContext,
  invoke: () => ReturnType<typeof invokeMessageCut>,
) {
  const storePath = resolveSessionStorePathCore(undefined, { agentId: scope.agentId });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const heldLifecycle = runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [scope.sessionId],
    run: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  const enqueue = storeWriterQueue.runQueuedStoreWrite;
  let queuedMutations = 0;
  const queue = vi.spyOn(storeWriterQueue, "runQueuedStoreWrite").mockImplementation((params) => {
    const pending = enqueue(params);
    if (
      params.label === "runExclusiveSessionLifecycleMutation" &&
      params.storePath === JSON.stringify([storePath, scope.sessionKey])
    ) {
      queuedMutations += 1;
    }
    return pending;
  });
  const sourceEntry = loadSessionEntry(scope);
  const respond = vi.fn<RespondFn>();
  const params = { sessionKey: scope.sessionKey, identityId: "member" };
  const removal = (async () => {
    await expectDefined(
      sessionSharingHandlers["session.members.remove"],
      "remove handler",
    )({
      req: { type: "req", id: "remove-fork-member", method: "session.members.remove", params },
      params,
      respond,
      client: { connect: { role: "operator", scopes: ["operator.admin"] } } as GatewayClient,
      context: {
        ...requestContext,
        // The public removal publishes inside its fence, before the waiting fork can enter.
        broadcast: vi.fn(() => expect(loadSessionEntry(scope)).toEqual(sourceEntry)),
      },
      isWebchatConnect: () => false,
    });
  })().then(
    () => undefined,
    (error: unknown) => error,
  );
  let mutation: ReturnType<typeof invokeMessageCut> | undefined;
  try {
    // Both operations now acquire the source key before its physical session id.
    await vi.waitFor(() => expect(queuedMutations).toBe(1));
    mutation = invoke();
    await vi.waitFor(() => expect(queuedMutations).toBe(2));
  } finally {
    queue.mockRestore();
    release.resolve();
    await heldLifecycle;
    await removal;
    await mutation?.error;
  }
  expect(await removal).toBeUndefined();
  expect(respond).toHaveBeenCalledWith(true, { ok: true, ...params }, undefined);
  return expectDefined(mutation, "queued fork");
}

it.each(
  mutationMethods.flatMap((method) =>
    [false, true].map((lockWhileQueued) => ({ method, lockWhileQueued })),
  ),
)(
  "rejects local $method on model-locked history (lockWhileQueued=$lockWhileQueued)",
  async ({ method, lockWhileQueued }) => {
    await withOpenClawTestState({ label: "message-cut-locked-owner" }, async (testState) => {
      await testState.writeConfig(cfg);
      const scope = await seedMessageCutSource();
      let before: Awaited<ReturnType<typeof readMutationStorage>> | undefined;
      const lockSource = async () => {
        // Simulate the harness claiming history after admission, without rotating identity.
        runOpenClawAgentWriteTransaction(
          (database) => {
            writeSessionEntry(database, scope.sessionKey, {
              ...expectDefined(loadSessionEntry(scope), "source before harness lock"),
              agentHarnessId: "external-harness",
              modelSelectionLocked: true,
            });
          },
          toDatabaseOptions(resolveSqliteScope(scope)),
        );
        before = await readMutationStorage(scope);
      };
      if (!lockWhileQueued) {
        await lockSource();
      }
      const mutation = lockWhileQueued
        ? await revokeDuringWriterWait(scope, () => invokeMessageCut(method, scope), lockSource)
        : invokeMessageCut(method, scope);
      expect(await mutation.error).toBeUndefined();
      expect(mutation.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: "Session history changes are unavailable while model selection is locked.",
        }),
      );
      expect(await readMutationStorage(scope)).toEqual(before);
    });
  },
);

describe("sessions.fork storage ownership", () => {
  it.each([
    { kind: "incognito", incognito: true },
    { kind: "ordinary", incognito: false },
  ])("keeps the $kind child accessible in its source storage class", async ({ incognito }) => {
    await withOpenClawTestState({ label: "message-fork-storage" }, async (testState) => {
      await testState.writeConfig(cfg);
      const sourceScope = await seedMessageCutSource(incognito);
      const { sessionKey } = sourceScope;
      const sourceEntry = loadSessionEntry(sourceScope);
      const sourceEvents = await loadTranscriptEvents(sourceScope);
      const { respond, error } = invokeMessageCut("sessions.fork", sourceScope, {
        sessionMutationCommitGuard: () => {},
        sessionMutationAuthorization: { assertCurrent: () => {}, assertTargetCurrent: () => {} },
      });
      expect(await error).toBeUndefined();

      expect(respond).toHaveBeenCalledWith(
        true,
        { sessionKey: expect.any(String), editorText: "What did I say?" },
        undefined,
      );
      const result = expectDefined(
        respond.mock.calls[0]?.[1] as SessionsForkResult | undefined,
        "fork response",
      );
      const childScope = { agentId: "main", sessionKey: result.sessionKey };
      // Resolve exactly the returned key, without supplying the source's volatile store path.
      const child = expectDefined(loadSessionEntry(childScope), "fork child at returned key");
      expect(isIncognitoSessionKey(result.sessionKey)).toBe(incognito);
      expect(child.incognito === true).toBe(incognito);
      expect(child.sessionId).not.toBe(sourceScope.sessionId);
      expect(child.parentSessionKey).toBe(sessionKey);
      const childTranscriptScope = { ...childScope, sessionId: child.sessionId };
      const childEvents = await loadTranscriptEvents(childTranscriptScope);
      expect(childEvents).toEqual([
        expect.objectContaining({ type: "session", id: child.sessionId }),
        ...sourceEvents.slice(1, 3),
      ]);
      expect(loadSessionEntry(sourceScope)).toEqual(sourceEntry);
      await expect(loadTranscriptEvents(sourceScope)).resolves.toEqual(sourceEvents);

      // Omitting the incognito key deliberately inspects the durable agent store.
      const durableRows = listSessionEntriesCore({ agentId: "main" });
      expect(durableRows.some((row) => row.sessionKey === result.sessionKey)).toBe(!incognito);
      await expect(
        loadTranscriptEvents({ agentId: "main", sessionId: child.sessionId }),
      ).resolves.toEqual(incognito ? [] : childEvents);

      const databasePath = incognito
        ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" })
        : resolveOpenClawAgentSqlitePath({ agentId: "main" });
      expect(fs.existsSync(databasePath)).toBe(!incognito);
      expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
      expect(loadSessionEntry(childScope)).toEqual(incognito ? undefined : child);
      await expect(loadTranscriptEvents(childTranscriptScope)).resolves.toEqual(
        incognito ? [] : childEvents,
      );
    });
  });
});

describe.each(["sessionMutationCommitGuard", "sessionMutationAuthorization"] as const)(
  "message-cut %s",
  (guardKind) => {
    it.each(mutationMethods)(
      "revalidates %s authority inside the queued commit",
      async (method) => {
        await withOpenClawTestState({ label: "message-cut-authority" }, async (testState) => {
          await testState.writeConfig(cfg);
          const scope = await seedMessageCutSource();
          const before = await readMutationStorage(scope);
          const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
          const denied = new SessionMutationAuthorizationChangedError(
            errorShape(ErrorCodes.FORBIDDEN, "admitted mutation authority was revoked"),
          );
          let current = true;
          let rejectedInsideTransaction = false;
          const assertCurrent = () => {
            if (!current) {
              rejectedInsideTransaction = database.db.isTransaction;
              throw denied;
            }
          };
          const guards =
            guardKind === "sessionMutationCommitGuard"
              ? { sessionMutationCommitGuard: assertCurrent }
              : {
                  sessionMutationAuthorization: {
                    assertCurrent,
                    assertTargetCurrent: vi.fn(),
                  },
                };
          const mutation = await revokeDuringWriterWait(
            scope,
            () => invokeMessageCut(method, scope, guards),
            () => {
              current = false;
            },
          );

          expect.soft(await readMutationStorage(scope)).toEqual(before);
          expect.soft(rejectedInsideTransaction).toBe(true);
          expect(await mutation.error).toBe(denied);
          expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
        });
      },
    );
  },
);

it.each(["SQLite writer fault injection", "public lifecycle predecessor"] as const)(
  "sessions.fork revalidates source participation after %s",
  async (revocation) => {
    await withOpenClawTestState({ label: "message-fork-participation" }, async (testState) => {
      await testState.writeConfig(cfg);
      const scope = await seedMessageCutSource();
      addSessionMember(scope, {
        identityId: "member",
        addedBy: "owner",
        expectedSessionId: scope.sessionId,
      });
      const client = {
        authenticatedUserId: "member@example.com",
        authenticatedUserProfile: {
          profileId: "member",
          displayName: "Member",
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: { role: "operator", scopes: ["operator.write"] },
      } as GatewayClient;
      const requestContext = context();
      const invoke = () => {
        const admission = resolveSessionMutationAuthorization({
          client,
          method: "sessions.fork",
          requestParams: mutationParams("sessions.fork", scope.sessionKey),
          context: requestContext,
        });
        expect(admission.error).toBeNull();
        const authorization = expectDefined(
          admission.authorization,
          "source participation authority",
        );
        expect(() => authorization.assertCurrent()).not.toThrow();
        return invokeMessageCut("sessions.fork", scope, {
          client,
          context: requestContext,
          sessionMutationAuthorization: authorization,
        });
      };
      const before = await readMutationStorage(scope);
      const mutation =
        revocation === "public lifecycle predecessor"
          ? await revokeWithPublicLifecyclePredecessor(scope, requestContext, invoke)
          : await revokeDuringWriterWait(scope, invoke, () => {
              expect(
                removeSessionMember(scope, "member", undefined, scope.sessionId),
              ).not.toBeNull();
              expect(loadSessionEntry(scope)).toEqual(before.source);
            });

      expect(
        resolveSessionMutationAuthorization({
          client,
          method: "sessions.fork",
          requestParams: mutationParams("sessions.fork", scope.sessionKey),
          context: requestContext,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      expect.soft(await readMutationStorage(scope)).toEqual(before);
      expect(await mutation.error).toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(await mutation.error).toMatchObject({
        error: { details: { code: "SESSION_PARTICIPATION_REQUIRED" } },
      });
      expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
    });
  },
);
