// Session delete worktree lifecycle tests protect exact-generation cleanup and
// same-key successor admission.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import type { SessionsDeleteResult } from "../../packages/gateway-protocol/src/index.js";
import {
  getRegistryWorktree,
  WorktreeRemovalContentionError,
} from "../agents/worktrees/registry.js";
import {
  acquireWorktreeRunLease,
  resolveWorktreeIdForPath,
} from "../agents/worktrees/run-lease.js";
import { managedWorktrees, WorktreeSnapshotError } from "../agents/worktrees/service.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../config/sessions/store-writer-state.js";
import { isSessionLifecycleMutationActive } from "../sessions/session-lifecycle-admission.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  loadSeededTranscriptEvents,
  sessionStoreEntry,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";
import {
  initializeRemoteBackedGitWorkspace,
  setupGatewaySessionsWorktreeTestHarness,
} from "./test/server-sessions.worktree-fixture.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const { createSessionStoreDir, createArchiveWorktreeFixture } =
  setupGatewaySessionsWorktreeTestHarness();
const execFileAsync = promisify(execFile);

test.each(["none", "restore-failed", "placement-changed"] as const)(
  "inbound admission restores the archived worktree before opening its session (failure=%s)",
  async (failure) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree, workspace } = fixture;
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "inbound restore keeps work\n");
    await managedWorktrees.remove({ id: worktree.id, reason: "session-archive" });
    await patchSessionEntryCore(
      { storePath, sessionKey: key },
      (entry) => ({
        ...entry!,
        archivedAt: 1,
      }),
      { skipMaintenance: true },
    );
    const [
      { createDispatchReplyOperationCoordinator },
      { createReplyDispatcher },
      { buildTestCtx },
    ] = await Promise.all([
      import("../auto-reply/reply/dispatch-from-config.lifecycle.js"),
      import("../auto-reply/reply/reply-dispatcher.js"),
      import("../auto-reply/reply/test-ctx.js"),
    ]);
    const placements =
      failure === "placement-changed" ? createWorkerSessionPlacementStore() : undefined;
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });
    onTestFinished(async () => {
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    });
    const coordinator = createDispatchReplyOperationCoordinator({
      agentId: "main",
      cfg: { agents: { defaults: { workspace } } },
      ctx: buildTestCtx({
        SessionKey: key,
        Body: "Continue this task",
        CommandSource: undefined,
        InboundAccessAuthorized: true,
        InboundEventKind: "user_request",
        InputProvenance: { kind: "external_user", sourceChannel: "discord" },
      }),
      dispatcher,
      dispatchOperationSessionKey: key,
      operationSessionStoreEntry: {
        storePath,
        entry: loadSessionEntry({ storePath, sessionKey: key }),
      },
      sessionWorkerPlacementContext: placements
        ? { workerSessionPlacementService: placements }
        : {},
      resolveOperationExpectedSessionId: () => sessionId,
    });
    const restore =
      failure === "restore-failed"
        ? vi
            .spyOn(managedWorktrees, "restore")
            .mockRejectedValueOnce(new Error("worktree checkout unavailable"))
        : undefined;
    const worktreeLifecycle = await import("../sessions/session-worktree-lifecycle.js");
    const synchronize = worktreeLifecycle.synchronizeSessionWorktreeArchive;
    const sqliteScope = resolveSqliteScope({ storePath, sessionKey: key });
    const writerQueuePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(sqliteScope));
    const writerStarted = createDeferredCore();
    const releaseWriter = createDeferredCore();
    let heldWriter: Promise<void> | undefined;
    let admission: ReturnType<typeof coordinator.ensureDispatchReplyOperation> | undefined;
    const placementChange = placements
      ? vi
          .spyOn(worktreeLifecycle, "synchronizeSessionWorktreeArchive")
          .mockImplementationOnce(async (params) => {
            const assertCurrent = await synchronize(params);
            heldWriter = runExclusiveSqliteSessionWrite(sqliteScope, async () => {
              writerStarted.resolve();
              await releaseWriter.promise;
            });
            await writerStarted.promise;
            return assertCurrent;
          })
      : undefined;
    try {
      admission = coordinator.ensureDispatchReplyOperation("pre_dispatch");
      void admission.catch(() => {});
      if (failure === "placement-changed") {
        // Advance placement only after the restored session waits behind a real SQLite writer.
        await Promise.race([writerStarted.promise, admission]);
        expect(heldWriter).toBeDefined();
        await vi.waitFor(() => {
          expect(SQLITE_SESSION_WRITER_QUEUES.get(writerQueuePath)?.pending.length).toBe(1);
        });
        expect(isSessionLifecycleMutationActive(storePath, [key, sessionId])).toBe(true);
        placements!.startDispatch({ sessionId, sessionKey: key, agentId: "main" });
        // A stopped replacement is eligible, but cannot reuse preparation owned by the prior placement.
        placements!.fail({ sessionId, expectedGeneration: 1, recoveryError: "preparation failed" });
        releaseWriter.resolve();
        await heldWriter;
        await expect(admission).rejects.toThrow("changed before mutation");
        expect(placements?.get(sessionId)).toMatchObject({
          state: "failed",
          generation: 2,
          environmentId: null,
        });
        expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBe(1);
        await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
          "inbound restore keeps work\n",
        );
      } else if (failure === "restore-failed") {
        await expect(admission).rejects.toThrow(/worktree/i);
        expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBe(1);
        await expect(fs.access(worktree.path)).rejects.toThrow();
      } else {
        await expect(admission).resolves.toEqual({ status: "ready" });
        await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
          "inbound restore keeps work\n",
        );
        expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
      }
      await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(
        transcript,
      );
    } finally {
      releaseWriter.resolve();
      await heldWriter;
      await admission?.catch(() => {});
      placementChange?.mockRestore();
      restore?.mockRestore();
      coordinator.completeDispatchReplyOperation();
      await coordinator.releasePreDispatchLifecycleAdmission();
      expect(isSessionLifecycleMutationActive(storePath, [key, sessionId])).toBe(false);
    }
  },
);

test("sessions.create only allocates worktrees for lifecycle-manageable agent owners", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-create-worktree-agent-owner-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  const { storePath } = await createSessionStoreDir();
  const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
  const allocatedWorktreeIds = new Set<string>();
  const createWorktree = vi.spyOn(managedWorktrees, "create");
  try {
    for (const owner of [{ agentId: "main" }, { key: "agent:main:dashboard:unconfigured-owner" }]) {
      const created = await directSessionReq<{
        key: string;
        worktree: { id: string };
      }>("sessions.create", { ...owner, worktree: true }, { client: adminClient });
      if (created.payload?.worktree.id) {
        allocatedWorktreeIds.add(created.payload.worktree.id);
      }

      expect(created).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: 'Unknown agent id "main"' },
      });
      if (owner.key) {
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: owner.key, storePath }),
        ).toBeUndefined();
      }
      expect(createWorktree).not.toHaveBeenCalled();
    }

    for (const owner of [{ agentId: "ops" }, {}]) {
      const created = await directSessionReq<{
        key: string;
        worktree: { id: string; path: string };
      }>("sessions.create", { ...owner, worktree: true }, { client: adminClient });
      if (created.payload?.worktree.id) {
        allocatedWorktreeIds.add(created.payload.worktree.id);
      }
      expect(created).toMatchObject({
        ok: true,
        payload: { key: expect.stringMatching(/^agent:ops:/) },
      });

      const worktree = created.payload!.worktree;
      await expect(
        directSessionReq("sessions.delete", { key: created.payload!.key, agentId: "ops" }),
      ).resolves.toMatchObject({ ok: true, payload: { deleted: true } });
      await expect(fs.access(worktree.path)).rejects.toThrow();
      allocatedWorktreeIds.delete(worktree.id);
    }
  } finally {
    createWorktree.mockRestore();
    for (const id of allocatedWorktreeIds) {
      if (getRegistryWorktree(process.env, id)?.removedAt === undefined) {
        await managedWorktrees.remove({ id, reason: "test-cleanup", allowSnapshotLoss: true });
      }
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    testState.agentsConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.delete snapshots and removes session worktrees", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-delete-worktree-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let dirtyWorktreeId: string | undefined;
  try {
    const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
    await fs.writeFile(path.join(workspace, "local-base.txt"), "inherited local commit\n");
    await execFileAsync("git", ["-C", workspace, "add", "local-base.txt"]);
    await execFileAsync("git", ["-C", workspace, "commit", "-m", "local base"]);
    const clean = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string; branch: string };
    }>("sessions.create", { agentId: "main", worktree: true }, { client: adminClient });
    expect(clean.ok).toBe(true);
    const cleanKey = clean.payload?.key;
    const cleanWorktree = clean.payload?.worktree;
    expect(cleanKey).toBeTruthy();
    expect(cleanWorktree).toBeTruthy();

    await expect(directSessionReq("sessions.delete", { key: cleanKey! })).resolves.toMatchObject({
      ok: true,
      payload: { deleted: true },
    });

    await expect(fs.access(cleanWorktree!.path)).rejects.toThrow();
    expect(getRegistryWorktree(process.env, cleanWorktree!.id)).toMatchObject({
      removedAt: expect.any(Number),
      snapshotRef: expect.stringMatching(/^refs\/openclaw\/snapshots\//),
    });
    const registered = await execFileAsync("git", [
      "-C",
      workspace,
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(registered.stdout).not.toContain(cleanWorktree!.path);
    const branch = await execFileAsync("git", [
      "-C",
      workspace,
      "branch",
      "--list",
      cleanWorktree!.branch,
    ]);
    expect(branch.stdout.trim()).toBe("");

    const dirty = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string; branch: string };
    }>("sessions.create", { agentId: "main", worktree: true }, { client: adminClient });
    expect(dirty.ok).toBe(true);
    const dirtyKey = dirty.payload?.key;
    const dirtyWorktree = dirty.payload?.worktree;
    dirtyWorktreeId = dirtyWorktree?.id;
    await fs.writeFile(path.join(dirtyWorktree!.path, "dirty.txt"), "keep me\n");

    await expect(directSessionReq("sessions.delete", { key: dirtyKey! })).resolves.toMatchObject({
      ok: true,
      payload: { deleted: true },
    });

    await expect(fs.access(dirtyWorktree!.path)).rejects.toThrow();
    expect(getRegistryWorktree(process.env, dirtyWorktree!.id)).toMatchObject({
      removedAt: expect.any(Number),
      snapshotRef: expect.stringMatching(/^refs\/openclaw\/snapshots\//),
    });
    dirtyWorktreeId = undefined;
  } finally {
    if (
      dirtyWorktreeId &&
      getRegistryWorktree(process.env, dirtyWorktreeId)?.removedAt === undefined
    ) {
      await managedWorktrees.remove({
        id: dirtyWorktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.delete keeps same-key successor worktree creation behind exact cleanup", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-delete-worktree-successor-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:delete-worktree-successor";
  const creatorProfileId = "delete-worktree-successor-creator";
  const adminClient = {
    connect: { scopes: ["operator.admin"] },
    authenticatedUserProfile: {
      profileId: creatorProfileId,
      displayName: "Delete Worktree Test",
      hasAvatar: false,
      updatedAt: 1,
    },
  } as never;
  let successorWorktreeId: string | undefined;
  let releaseRemoval = () => {};
  const removalGate = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
  let markRemovalStarted = () => {};
  const removalStarted = new Promise<void>((resolve) => {
    markRemovalStarted = resolve;
  });
  const removeSpy = vi.spyOn(managedWorktrees, "remove");
  try {
    const predecessor = await directSessionReq<{
      sessionId: string;
      worktree: { id: string; path: string; branch: string };
    }>("sessions.create", { key, agentId: "main", worktree: true }, { client: adminClient });
    expect(predecessor.ok).toBe(true);
    const predecessorSessionId = predecessor.payload!.sessionId;
    const predecessorWorktree = predecessor.payload!.worktree;

    removeSpy.mockImplementation(async (params) => {
      if (params.id === predecessorWorktree.id && params.reason === "session-delete") {
        expect(isSessionLifecycleMutationActive(storePath, [key, predecessorSessionId])).toBe(true);
        expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
          targetSessionKey: key,
          reason: "session-delete",
        });
        markRemovalStarted();
        await removalGate;
      }
      return await originalRemove(params);
    });

    const deletion = directSessionReq<{ deleted: boolean }>("sessions.delete", {
      key,
      expectedSessionId: predecessorSessionId,
    });
    await removalStarted;
    let successorSettled = false;
    const successorPromise = directSessionReq<{
      sessionId: string;
      entry: { spawnedCwd?: string; worktree?: { id: string; branch: string; repoRoot: string } };
      worktree: { id: string; path: string; branch: string };
    }>("sessions.create", { key, agentId: "main", worktree: true }, { client: adminClient }).then(
      (result) => {
        successorSettled = true;
        return result;
      },
    );
    await Promise.resolve();
    expect(successorSettled).toBe(false);

    releaseRemoval();
    const [deleted, successor] = await Promise.all([deletion, successorPromise]);
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(successor.ok).toBe(true);
    const successorSessionId = successor.payload!.sessionId;
    const successorWorktree = successor.payload!.worktree;
    successorWorktreeId = successorWorktree.id;
    expect(successorSessionId).not.toBe(predecessorSessionId);
    expect(successorWorktree.id).not.toBe(predecessorWorktree.id);
    await fs.access(successorWorktree.path);
    expect(getRegistryWorktree(process.env, successorWorktree.id)?.id).toBe(successorWorktree.id);
    expect(getRegistryWorktree(process.env, successorWorktree.id)?.removedAt).toBeUndefined();
    const persisted = loadSessionEntry({ sessionKey: key, storePath });
    expect(persisted).toMatchObject({
      sessionId: successorSessionId,
      spawnedCwd: successorWorktree.path,
      worktree: {
        id: successorWorktree.id,
        branch: successorWorktree.branch,
        repoRoot: workspace,
      },
    });
    expect(
      listSessionStateEventsSince(key, "main", 0, 20).events.filter(
        (event) => event.kind === "created",
      ),
    ).toEqual([
      expect.objectContaining({
        sessionId: successorSessionId,
        actorType: "human",
        actorId: creatorProfileId,
      }),
    ]);
    const admittedWorktreeId = await resolveWorktreeIdForPath({
      sessionEntry: persisted,
      candidatePaths: [persisted?.spawnedCwd],
    });
    expect(admittedWorktreeId).toBe(successorWorktree.id);
    const runLease = await acquireWorktreeRunLease(admittedWorktreeId!);
    await runLease.release();
  } finally {
    releaseRemoval();
    removeSpy.mockRestore();
    if (
      successorWorktreeId &&
      getRegistryWorktree(process.env, successorWorktreeId)?.removedAt === undefined
    ) {
      await managedWorktrees.remove({
        id: successorWorktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test.each([
  {
    failure: () => new Error("simulated cleanup failure"),
    name: "generic cleanup failure",
    reason: "cleanup-failed",
    finalized: false,
  },
  {
    failure: () => new WorktreeSnapshotError("simulated snapshot failure"),
    name: "snapshot failure",
    reason: "snapshot-failed",
    finalized: false,
  },
  {
    failure: () => new WorktreeRemovalContentionError("finalized", "removed concurrently"),
    name: "concurrently finalized removal",
    reason: undefined,
    finalized: true,
  },
])("sessions.delete reports preserved worktree truth after $name", async (scenario) => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-delete-worktree-preserved-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:delete-worktree-preserved";
  const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
  const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
  let worktreeId: string | undefined;
  const removeSpy = vi.spyOn(managedWorktrees, "remove");
  try {
    const created = await directSessionReq<{
      worktree: { id: string; path: string; branch: string };
    }>("sessions.create", { key, agentId: "main", worktree: true }, { client: adminClient });
    expect(created.ok).toBe(true);
    const worktree = created.payload!.worktree;
    worktreeId = worktree.id;
    removeSpy.mockImplementation(async (params) => {
      if (params.id === worktree.id && params.reason === "session-delete") {
        if (scenario.finalized) {
          await originalRemove(params);
        }
        throw scenario.failure();
      }
      return await originalRemove(params);
    });

    const deleted = await directSessionReq<SessionsDeleteResult>("sessions.delete", { key });

    if (scenario.reason) {
      expect(deleted).toMatchObject({
        ok: true,
        payload: {
          deleted: true,
          worktreePreserved: {
            id: worktree.id,
            path: worktree.path,
            branch: worktree.branch,
            reason: scenario.reason,
          },
        },
      });
    } else {
      expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
      expect(deleted.payload).not.toHaveProperty("worktreePreserved");
    }
    expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
    if (scenario.finalized) {
      expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toEqual(expect.any(Number));
      await expect(fs.access(worktree.path)).rejects.toThrow();
    } else {
      expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
      await fs.access(worktree.path);
    }
  } finally {
    removeSpy.mockRestore();
    if (worktreeId && getRegistryWorktree(process.env, worktreeId)?.removedAt === undefined) {
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.delete reports a busy preserved worktree while a live run lease exists", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-delete-worktree-busy-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const key = "agent:main:dashboard:delete-worktree-busy";
  const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
  let worktreeId: string | undefined;
  let runLease: Awaited<ReturnType<typeof acquireWorktreeRunLease>> | undefined;
  try {
    const created = await directSessionReq<{
      worktree: { id: string; path: string; branch: string };
    }>("sessions.create", { key, agentId: "main", worktree: true }, { client: adminClient });
    expect(created.ok).toBe(true);
    const worktree = created.payload!.worktree;
    worktreeId = worktree.id;
    runLease = await acquireWorktreeRunLease(worktree.id);

    const deleted = await directSessionReq<SessionsDeleteResult>("sessions.delete", { key });

    expect(deleted).toMatchObject({
      ok: true,
      payload: {
        deleted: true,
        worktreePreserved: {
          id: worktree.id,
          path: worktree.path,
          branch: worktree.branch,
          reason: "busy",
        },
      },
    });
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
    await fs.access(worktree.path);
  } finally {
    await runLease?.release();
    if (worktreeId && getRegistryWorktree(process.env, worktreeId)?.removedAt === undefined) {
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.delete preserves an entry-bound worktree owned by another principal", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-delete-worktree-owner-mismatch-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const key = "agent:main:dashboard:delete-worktree-owner-mismatch";
  const foreignWorktree = await managedWorktrees.create({
    repoRoot: workspace,
    ownerKind: "manual",
    ownerId: "foreign-owner",
    name: "foreign-owner",
  });
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("session-owner-mismatch", {
        spawnedCwd: foreignWorktree.path,
        worktree: {
          id: foreignWorktree.id,
          branch: foreignWorktree.branch,
          repoRoot: foreignWorktree.repoRoot,
        },
      }),
    },
  });
  const removeSpy = vi.spyOn(managedWorktrees, "remove");
  try {
    const deleted = await directSessionReq<SessionsDeleteResult>("sessions.delete", {
      key,
      deleteTranscript: false,
    });

    expect(deleted).toMatchObject({
      ok: true,
      payload: {
        deleted: true,
        worktreePreserved: {
          id: foreignWorktree.id,
          path: foreignWorktree.path,
          branch: foreignWorktree.branch,
          reason: "owner-mismatch",
        },
      },
    });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(getRegistryWorktree(process.env, foreignWorktree.id)).toMatchObject({
      ownerKind: "manual",
      ownerId: "foreign-owner",
    });
    expect(getRegistryWorktree(process.env, foreignWorktree.id)?.removedAt).toBeUndefined();
    await fs.access(foreignWorktree.path);
  } finally {
    removeSpy.mockRestore();
    if (getRegistryWorktree(process.env, foreignWorktree.id)?.removedAt === undefined) {
      await managedWorktrees.remove({
        id: foreignWorktree.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});
