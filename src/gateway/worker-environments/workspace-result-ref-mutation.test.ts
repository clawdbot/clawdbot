import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "../../agents/worktrees/service.js";
import * as processExec from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  cleanupWorkerWorkspaceResultRef,
  deleteStagedWorkerWorkspaceResult,
  deleteWorkerWorkspaceResultCleanupRefs,
  hasWorkerWorkspaceResultRef,
  moveStagedWorkerWorkspaceResultToCleanup,
  preparedWorkerWorkspaceResultRef,
  restoreStagedWorkerWorkspaceResultFromCleanup,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

async function repository() {
  const root = await fs.realpath(tempDirs.make("openclaw-workspace-ref-"));
  await requireGit(root, ["init", "--quiet", "-b", "main"]);
  await requireGit(root, [
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=test@localhost",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--allow-empty",
    "-m",
    "seed",
  ]);
  return root;
}

it("shares ref serialization and deferred retention between snapshots and result recovery", async () => {
  vi.stubEnv("GIT_COMMON_DIR", undefined);
  const root = await repository();
  const other = await repository();
  let now = 1_700_000_000_000;
  const service = new ManagedWorktreeService({
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    now: () => now,
  });
  const worktree = await service.create({ repoRoot: root, name: "snapshot", baseRef: "HEAD" });
  const removed = await service.remove({ id: worktree.id, reason: "test" });
  const snapshotRef = expectDefined(removed.snapshotRef, "removed worktree snapshot");
  const linked = path.join(root, "linked");
  await requireGit(root, ["worktree", "add", "--detach", linked, "HEAD"]);
  const stagedResultRef = workerWorkspaceResultRef("queued-result");
  const candidateRef = preparedWorkerWorkspaceResultRef(stagedResultRef);
  for (const repositoryRoot of [root, other]) {
    await requireGit(repositoryRoot, ["update-ref", stagedResultRef, "HEAD"]);
    await requireGit(repositoryRoot, ["update-ref", candidateRef, "HEAD"]);
  }
  const retainedRef = cleanupWorkerWorkspaceResultRef(workerWorkspaceResultRef("retained"));
  await requireGit(root, ["update-ref", retainedRef, "HEAD"]);
  const retainedRefs = new Set<string>();
  const readRetainedRefs = vi.fn(() => retainedRefs);
  now += SNAPSHOT_RETENTION_MS + 1;

  const started = createDeferred();
  const release = createDeferred();
  const discovered = createDeferred();
  let resultDiscoveries = 0;
  const mutations: string[][] = [];
  const run = processExec.runCommandWithTimeout;
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
    const args = argv.slice(argv.indexOf("-C") + 2);
    if (args[0] === "update-ref" && argv[argv.indexOf("-C") + 1] !== other) {
      mutations.push(args);
      if (args[1] === "-d" && args[2] === snapshotRef) {
        started.resolve();
        await release.promise;
      }
    }
    const result = await run(argv, options);
    if (
      argv[argv.indexOf("-C") + 1] === linked &&
      args[0] === "rev-parse" &&
      args[1] === "--git-common-dir" &&
      ++resultDiscoveries === 2
    ) {
      discovered.resolve();
    }
    return result;
  });
  const pruning = service.gc();
  let move: Promise<string> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    await started.promise;
    move = moveStagedWorkerWorkspaceResultToCleanup({ root: linked, stagedResultRef });
    cleanup = deleteWorkerWorkspaceResultCleanupRefs({
      root: linked,
      retainedRefs: readRetainedRefs,
    });
    // Both writers must capture their environment before the redirect below.
    await discovered.promise;
    // An independent full ref operation must progress while this repository's
    // writer is parked; a quick read alone can outrun the queued caller's discovery.
    await moveStagedWorkerWorkspaceResultToCleanup({ root: other, stagedResultRef });
    await expect(hasWorkerWorkspaceResultRef({ root: linked, stagedResultRef })).resolves.toBe(
      true,
    );
    expect(mutations).toEqual([["update-ref", "-d", snapshotRef]]);
    expect(readRetainedRefs).not.toHaveBeenCalled();
    // A queued result writer must not adopt a later repository redirect.
    vi.stubEnv("GIT_COMMON_DIR", path.join(other, ".git"));
  } finally {
    retainedRefs.add(retainedRef);
    release.resolve();
    await Promise.allSettled([pruning, ...(move ? [move] : []), ...(cleanup ? [cleanup] : [])]);
    vi.stubEnv("GIT_COMMON_DIR", undefined);
  }
  await cleanup;
  expect(readRetainedRefs).toHaveBeenCalledOnce();
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: retainedRef })).resolves.toBe(
    true,
  );
  expect((await pruning).snapshotsPruned).toBe(1);
  const cleanupRef = await expectDefined(move, "queued worker result move");
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef })).resolves.toBe(false);
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: candidateRef })).resolves.toBe(
    false,
  );
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: cleanupRef })).resolves.toBe(
    true,
  );

  await restoreStagedWorkerWorkspaceResultFromCleanup({
    root: linked,
    cleanupRef,
    stagedResultRef,
  });
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef })).resolves.toBe(true);
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: cleanupRef })).resolves.toBe(
    false,
  );
  await moveStagedWorkerWorkspaceResultToCleanup({ root: linked, stagedResultRef });
  await deleteWorkerWorkspaceResultCleanupRefs({ root: linked });
  expect(await requireGit(root, ["for-each-ref", "--format=%(refname)", "refs/openclaw/"])).toBe(
    "",
  );
});

it.each([false, true])(
  "preserves native external packed-ref contention without retrying or deleting its lock (bare=%s)",
  async (bare) => {
    let root = await repository();
    if (bare) {
      const bareRoot = path.join(tempDirs.make("openclaw-workspace-bare-ref-"), "repo.git");
      await requireGit(root, ["clone", "--bare", "--no-hardlinks", "--", root, bareRoot]);
      root = await fs.realpath(bareRoot);
    }
    const stagedResultRef = workerWorkspaceResultRef("external-lock");
    await requireGit(root, ["update-ref", stagedResultRef, "HEAD"]);
    const lock = path.join(root, bare ? "." : ".git", "packed-refs.lock");
    await fs.writeFile(lock, "external owner\n", { flag: "wx" });
    const commandSpy = vi.spyOn(processExec, "runCommandWithTimeout");
    try {
      await expect(deleteStagedWorkerWorkspaceResult({ root, stagedResultRef })).rejects.toThrow(
        "packed-refs.lock",
      );
      await expect(fs.readFile(lock, "utf8")).resolves.toBe("external owner\n");
      await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef })).resolves.toBe(true);
      const deleteAttempts = commandSpy.mock.calls.filter(([argv]) =>
        argv.includes("update-ref"),
      ).length;
      expect(deleteAttempts).toBe(1);
    } finally {
      await fs.rm(lock, { force: true });
    }
    await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef });
    await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef })).resolves.toBe(false);
  },
);
