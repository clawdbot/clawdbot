// Session delete worktree lifecycle tests protect exact-generation cleanup and
// same-key successor admission.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import {
  acquireWorktreeRunLease,
  resolveWorktreeIdForPath,
} from "../agents/worktrees/run-lease.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { isSessionLifecycleMutationActive } from "../sessions/session-lifecycle-admission.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const execFileAsync = promisify(execFile);

async function initializeRemoteBackedGitWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(workspace, { recursive: true });
  await execFileAsync("git", ["-C", workspace, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", workspace, "config", "user.name", "OpenClaw Test"]);
  await execFileAsync("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "openclaw-test@example.invalid",
  ]);
  await fs.writeFile(path.join(workspace, "README.md"), "base\n");
  await execFileAsync("git", ["-C", workspace, "add", "README.md"]);
  await execFileAsync("git", ["-C", workspace, "commit", "-m", "initial"]);
  await execFileAsync("git", ["clone", "--bare", workspace, remote]);
  await execFileAsync("git", ["-C", workspace, "remote", "add", "origin", remote]);
  await execFileAsync("git", ["-C", workspace, "push", "-u", "origin", "main"]);
  return await fs.realpath(workspace);
}

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
      await managedWorktrees.remove({ id: dirtyWorktreeId, reason: "test-cleanup", force: true });
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
    await expect(fs.access(successorWorktree.path)).resolves.toBeUndefined();
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
        force: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.delete reports the exact preserved worktree when cleanup fails", async () => {
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
        throw new Error("simulated cleanup failure");
      }
      return await originalRemove(params);
    });

    const deleted = await directSessionReq<{
      deleted: boolean;
      worktreePreserved?: { id: string; path: string; branch: string };
    }>("sessions.delete", { key });

    expect(deleted).toMatchObject({
      ok: true,
      payload: {
        deleted: true,
        worktreePreserved: {
          id: worktree.id,
          path: worktree.path,
          branch: worktree.branch,
        },
      },
    });
    expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
    await expect(fs.access(worktree.path)).resolves.toBeUndefined();
  } finally {
    removeSpy.mockRestore();
    if (worktreeId && getRegistryWorktree(process.env, worktreeId)?.removedAt === undefined) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
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
    const deleted = await directSessionReq<{
      deleted: boolean;
      worktreePreserved?: { id: string; path: string; branch: string };
    }>("sessions.delete", { key, deleteTranscript: false });

    expect(deleted).toMatchObject({
      ok: true,
      payload: {
        deleted: true,
        worktreePreserved: {
          id: foreignWorktree.id,
          path: foreignWorktree.path,
          branch: foreignWorktree.branch,
        },
      },
    });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(getRegistryWorktree(process.env, foreignWorktree.id)).toMatchObject({
      ownerKind: "manual",
      ownerId: "foreign-owner",
    });
    expect(getRegistryWorktree(process.env, foreignWorktree.id)?.removedAt).toBeUndefined();
    await expect(fs.access(foreignWorktree.path)).resolves.toBeUndefined();
  } finally {
    removeSpy.mockRestore();
    if (getRegistryWorktree(process.env, foreignWorktree.id)?.removedAt === undefined) {
      await managedWorktrees.remove({
        id: foreignWorktree.id,
        reason: "test-cleanup",
        force: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});
