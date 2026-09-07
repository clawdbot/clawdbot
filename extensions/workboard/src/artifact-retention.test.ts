import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { IDLE_GC_MS, ManagedWorktreeService } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupWorkboardCardWorktree } from "./dispatcher-workspace.js";
import { isWorkboardCardStore } from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

const execFileAsync = promisify(execFile);
type RetentionWorktrees = Pick<
  PluginRuntime["worktrees"],
  "resolveRetentionTarget" | "setRetentionClaim"
>;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

describe("Workboard artifact worktree retention", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;
  let sqlite: ReturnType<typeof createWorkboardSqliteStores>;
  let store: WorkboardStore;

  beforeEach(async () => {
    // openclaw-temp-dir: allow extension tests cannot import the core-only tracker.
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "workboard-retention-"));
    // Disk admission has separate capacity tests; these tiny fixtures exercise retention owners.
    const disk = fsSync.statfsSync(root);
    disk.bavail = 100_000_000;
    disk.bfree = 100_000_000;
    vi.spyOn(fsSync, "statfsSync").mockReturnValue(disk);
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await fs.writeFile(path.join(repo, ".gitignore"), "dist/\n");
    await git(repo, "add", "README.md", ".gitignore");
    await git(repo, "commit", "-m", "initial");
    const remote = path.join(root, "remote.git");
    await execFileAsync("git", ["clone", "--bare", repo, remote]);
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "-u", "origin", "main");
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
    openRetentionStore();
    expect(isWorkboardCardStore(sqlite.cards)).toBe(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    sqlite.close();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createCardWorktree(name: string) {
    const card = await store.create({
      title: name,
      status: "done",
      runId: `run-${name}`,
    });
    const worktree = await service.create({
      repoRoot: repo,
      name,
      ownerKind: "workboard",
      ownerId: card.id,
    });
    await service.acquire(worktree.id);
    await store.update(card.id, {
      workspace: {
        kind: "worktree",
        path: worktree.path,
        branch: worktree.branch,
        sourcePath: repo,
        sourceBranch: "main",
      },
      workspaceAccess: { unrestricted: true },
    });
    return { card, worktree };
  }

  function retentionWorktrees(activeService = service): RetentionWorktrees {
    return {
      resolveRetentionTarget: async (params) =>
        activeService.resolveRetentionTargetByPath(params.path, {
          ownerKind: params.ownerKind,
          ownerId: params.ownerId,
        }),
      setRetentionClaim: async (params) =>
        activeService.setRetentionClaim(
          params.worktreeId,
          { ownerKind: params.ownerKind, ownerId: params.ownerId },
          { claimId: params.claimId, active: params.active },
        ),
    };
  }

  function runtimeWorktrees(activeService = service) {
    return {
      release: async ({ path: worktreePath }: { path: string }) => {
        await activeService.releaseByPath(worktreePath);
      },
      removeIfLossless: async (params: { path: string; ownerKind: "workboard"; ownerId: string }) =>
        await activeService.removeIfLosslessByPath(params.path, {
          ownerKind: params.ownerKind,
          ownerId: params.ownerId,
        }),
    };
  }

  function openRetentionStore(worktrees = retentionWorktrees()) {
    sqlite = createWorkboardSqliteStores({ env, worktrees });
    store = new WorkboardStore(sqlite.cards, {
      boards: sqlite.boards,
      subscriptions: sqlite.subscriptions,
      attachments: sqlite.attachments,
      dataVersion: sqlite.dataVersion,
    });
    return sqlite.cards;
  }

  function restartWithRetentionStore() {
    sqlite.close();
    closeOpenClawStateDatabaseForTest();
    service = new ManagedWorktreeService({ env, now: () => now });
    return openRetentionStore();
  }

  function replaceRetentionRuntime(worktrees: RetentionWorktrees) {
    sqlite.close();
    return openRetentionStore(worktrees);
  }

  async function writeArtifact(worktreePath: string) {
    await fs.mkdir(path.join(worktreePath, "dist"), { recursive: true });
    await fs.writeFile(path.join(worktreePath, "dist", "report.txt"), "report\n");
  }

  async function referenceWorktree(
    cardId: string,
    worktree: { path: string; branch: string },
    activeStore = store,
  ) {
    const persisted = await activeStore.get(cardId);
    return await activeStore.update(cardId, {
      workspace: {
        kind: "worktree",
        path: worktree.path,
        branch: worktree.branch,
        sourcePath: repo,
        sourceBranch: "main",
      },
      workspaceAccess: { unrestricted: true },
      metadata: { ...persisted?.metadata, artifacts: [{ path: "dist/report.txt" }] },
    });
  }

  async function createSecondWorktree(cardId: string, previousId: string, name: string) {
    // create() reuses a live owner's checkout. An explicit remove followed by a
    // later restore is the supported path to two identities for the same card.
    await service.release(previousId);
    await service.remove({ id: previousId, reason: "retention-test-operator-remove" });
    const worktree = await service.create({
      repoRoot: repo,
      name,
      ownerKind: "workboard",
      ownerId: cardId,
    });
    expect(worktree.id).not.toBe(previousId);
    const restored = await service.restore({ id: previousId });
    await writeArtifact(restored.path);
    await service.acquire(worktree.id);
    await writeArtifact(worktree.path);
    return worktree;
  }

  async function cleanupCardWorktree(cardId: string, activeService = service) {
    const card = await store.get(cardId);
    if (!card) {
      throw new Error(`card not found: ${cardId}`);
    }
    await cleanupWorkboardCardWorktree({
      store,
      worktrees: runtimeWorktrees(activeService),
      card,
    });
  }

  async function createLegacyArtifactCard(name: string) {
    const legacySqlite = createWorkboardSqliteStores({ env });
    try {
      const legacyStore = new WorkboardStore(legacySqlite.cards, {
        boards: legacySqlite.boards,
        subscriptions: legacySqlite.subscriptions,
        attachments: legacySqlite.attachments,
        dataVersion: legacySqlite.dataVersion,
      });
      const card = await legacyStore.create({ title: name, status: "done", runId: `run-${name}` });
      const worktree = await service.create({
        repoRoot: repo,
        name,
        ownerKind: "workboard",
        ownerId: card.id,
      });
      await service.acquire(worktree.id);
      await legacyStore.update(card.id, {
        workspace: {
          kind: "worktree",
          path: worktree.path,
          branch: worktree.branch,
          sourcePath: repo,
          sourceBranch: "main",
        },
        workspaceAccess: { unrestricted: true },
      });
      await writeArtifact(worktree.path);
      await legacyStore.addArtifact(card.id, { path: "dist/report.txt" });
      return { card, worktree };
    } finally {
      legacySqlite.close();
    }
  }

  it("persists an aliased local artifact claim until the reference is externalized", async () => {
    const { card, worktree } = await createCardWorktree("aliased-artifact");
    const artifactDir = path.join(worktree.path, "dist");
    const alias = path.join(root, "artifact-alias");
    await fs.mkdir(artifactDir);
    await fs.writeFile(path.join(artifactDir, "report.txt"), "report\n");
    await fs.symlink(worktree.path, alias, process.platform === "win32" ? "junction" : "dir");
    await store.addArtifact(card.id, { path: path.join(alias, "dist", "report.txt") });
    expect((await sqlite.cards.lookup(card.id))?.card.metadata?.artifacts).toHaveLength(1);

    const restarted = new ManagedWorktreeService({ env, now: () => now });
    await cleanupCardWorktree(card.id, restarted);
    await expect(fs.stat(worktree.path)).resolves.toBeDefined();
    now += IDLE_GC_MS + 1;
    expect((await restarted.gc()).removed).toEqual([]);
    expect((await restarted.gc({ limits: { maxCount: 0 } })).removed).toEqual([]);
    expect((await restarted.gc({ limits: { maxTotalSizeBytes: 1 } })).removed).toEqual([]);

    const persisted = await store.get(card.id);
    await store.update(card.id, {
      metadata: {
        ...persisted?.metadata,
        artifacts: [{ url: "https://example.invalid/report.txt" }],
      },
    });
    expect((await restarted.gc({ limits: { maxCount: 0 } })).removed).toEqual([worktree.id]);
    await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles artifacts persisted before retention claims existed", async () => {
    const { card, worktree } = await createLegacyArtifactCard("legacy-artifact");

    restartWithRetentionStore();

    await cleanupCardWorktree(card.id);
    await expect(fs.stat(worktree.path)).resolves.toBeDefined();
    now += IDLE_GC_MS + 1;
    expect((await service.gc()).removed).toEqual([]);
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([]);
    expect((await service.gc({ limits: { maxTotalSizeBytes: 1 } })).removed).toEqual([]);

    const persisted = await store.get(card.id);
    await store.update(card.id, {
      metadata: {
        ...persisted?.metadata,
        artifacts: [{ url: "https://example.invalid/report.txt" }],
      },
    });
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([worktree.id]);
    await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips legacy cards whose worktrees were already removed", async () => {
    const { card, worktree } = await createLegacyArtifactCard("removed-legacy-artifact");
    await service.release(worktree.id);
    await expect(service.removeIfLossless(worktree.id)).resolves.toBe(true);

    const cards = restartWithRetentionStore();

    await expect(cards.reconcileArtifactRetention()).resolves.toBeUndefined();
    await expect(store.get(card.id)).resolves.toMatchObject({ id: card.id });
    await expect(store.addArtifact(card.id, { path: "dist/new.txt" })).rejects.toThrow(
      "managed worktree is unavailable for artifact retention",
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { artifacts: [{ path: "dist/report.txt" }] },
    });
  });

  it("keeps a referenced worktree protected when restored after startup reconciliation", async () => {
    const { card, worktree } = await createCardWorktree("restored-after-restart");
    // Explicit removal snapshots non-ignored files; use one that restore actually recovers.
    const artifact = path.join(worktree.path, "report.txt");
    await fs.writeFile(artifact, "report");
    await store.addArtifact(card.id, { path: "report.txt" });
    await service.release(worktree.id);
    await service.remove({ id: worktree.id, reason: "retention-test-operator-remove" });
    await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });

    await restartWithRetentionStore().reconcileArtifactRetention();
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { artifacts: [{ path: "report.txt" }] },
    });
    const restored = await service.restore({ id: worktree.id });
    expect(restored.id).toBe(worktree.id);
    await expect(fs.readFile(artifact, "utf8")).resolves.toBe("report");
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([]);
    await expect(fs.readFile(artifact, "utf8")).resolves.toBe("report");

    const persisted = await store.get(card.id);
    await store.update(card.id, {
      metadata: {
        ...persisted?.metadata,
        artifacts: [{ url: "https://example.invalid/report.txt" }],
      },
    });
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([worktree.id]);
  });

  it("reports a committed mutation while release remains durably retryable", async () => {
    const delegate = retentionWorktrees();
    let releaseUnavailable = true;
    replaceRetentionRuntime({
      ...delegate,
      async setRetentionClaim(params) {
        if (!params.active && releaseUnavailable) {
          throw new Error("transient retention release failure");
        }
        return await delegate.setRetentionClaim(params);
      },
    });
    const { card, worktree } = await createCardWorktree("retry-release");
    await writeArtifact(worktree.path);
    await store.addArtifact(card.id, { path: "dist/report.txt" });
    const persisted = await store.get(card.id);

    await expect(
      store.update(card.id, {
        metadata: {
          ...persisted?.metadata,
          artifacts: [{ url: "https://example.invalid/report.txt" }],
        },
      }),
    ).resolves.toMatchObject({ id: card.id });

    await expect(sqlite.cards.lookup(card.id)).resolves.toMatchObject({
      card: { metadata: { artifacts: [{ url: "https://example.invalid/report.txt" }] } },
    });
    await service.release(worktree.id);
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([]);
    await expect(sqlite.cards.reconcileArtifactRetention()).rejects.toThrow(
      "transient retention release failure",
    );
    releaseUnavailable = false;
    await sqlite.cards.reconcileArtifactRetention();
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([worktree.id]);
  });

  it("recovers a failed release after deleting the card and restarting", async () => {
    const { card, worktree } = await createCardWorktree("deleted-release-restart");
    await writeArtifact(worktree.path);
    await store.addArtifact(card.id, { path: "dist/report.txt" });
    const delegate = retentionWorktrees();
    const cards = replaceRetentionRuntime({
      ...delegate,
      async setRetentionClaim(params) {
        if (!params.active) {
          throw new Error("transient retention release failure");
        }
        return await delegate.setRetentionClaim(params);
      },
    });
    await expect(cards.delete(card.id)).resolves.toBe(true);
    await expect(sqlite.cards.lookup(card.id)).resolves.toBeUndefined();

    const restarted = restartWithRetentionStore();
    await restarted.reconcileArtifactRetention();
    await service.release(worktree.id);
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([worktree.id]);
  });

  it("releases obsolete A after restart while the committed B stays protected", async () => {
    const { card, worktree: previous } = await createCardWorktree("previous-artifact");
    await writeArtifact(previous.path);
    await store.addArtifact(card.id, { path: "dist/report.txt" });
    const next = await createSecondWorktree(card.id, previous.id, "next-artifact");
    const delegate = retentionWorktrees();
    replaceRetentionRuntime({
      ...delegate,
      async setRetentionClaim(params) {
        if (!params.active && params.worktreeId === previous.id) {
          throw new Error("transient previous retention release failure");
        }
        return await delegate.setRetentionClaim(params);
      },
    });

    await expect(referenceWorktree(card.id, next)).resolves.toMatchObject({ id: card.id });
    await expect(sqlite.cards.lookup(card.id)).resolves.toMatchObject({
      card: { metadata: { automation: { workspace: { path: next.path } } } },
    });
    await service.release(previous.id);
    await service.release(next.id);
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([]);

    await restartWithRetentionStore().reconcileArtifactRetention();
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([previous.id]);
    await expect(fs.stat(next.path)).resolves.toBeDefined();
    const transitioned = await store.get(card.id);
    await store.update(card.id, {
      metadata: {
        ...transitioned?.metadata,
        artifacts: [{ url: "https://example.invalid/report.txt" }],
      },
    });
    expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([next.id]);
  });

  it("does not let an old A release remove the later A generation", async () => {
    const { card, worktree: previous } = await createCardWorktree("returning-artifact");
    await writeArtifact(previous.path);
    await store.addArtifact(card.id, { path: "dist/report.txt" });
    const next = await createSecondWorktree(card.id, previous.id, "intermediate-artifact");
    const delegate = retentionWorktrees();
    const releaseStarted = Promise.withResolvers<void>();
    const resumeRelease = Promise.withResolvers<void>();
    let pauseFirstRelease = true;
    replaceRetentionRuntime({
      ...delegate,
      async setRetentionClaim(params) {
        if (!params.active && params.worktreeId === previous.id && pauseFirstRelease) {
          pauseFirstRelease = false;
          releaseStarted.resolve();
          await resumeRelease.promise;
        }
        return await delegate.setRetentionClaim(params);
      },
    });
    const movingToB = referenceWorktree(card.id, next);
    const movingResult = movingToB.then(
      () => ({ applied: true }),
      () => ({ applied: false }),
    );
    await releaseStarted.promise;
    const other = createWorkboardSqliteStores({ env, worktrees: retentionWorktrees() });
    try {
      const otherStore = new WorkboardStore(other.cards, { dataVersion: other.dataVersion });
      await referenceWorktree(card.id, previous, otherStore);
      resumeRelease.resolve();
      await expect(movingResult).resolves.toEqual({ applied: true });
      await other.cards.reconcileArtifactRetention();
      await service.release(previous.id);
      await service.release(next.id);
      expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([next.id]);
      await expect(fs.stat(previous.path)).resolves.toBeDefined();
      await expect(other.cards.lookup(card.id)).resolves.toMatchObject({
        card: { metadata: { automation: { workspace: { path: previous.path } } } },
      });
    } finally {
      resumeRelease.resolve();
      await movingResult;
      other.close();
    }
  });

  it.each(["before", "after"] as const)(
    "fences a prepared write cancelled %s its delayed acquisition",
    async (pauseAt) => {
      const { card, worktree } = await createCardWorktree("cancelled-preparation");
      await writeArtifact(worktree.path);
      const original = await sqlite.cards.lookup(card.id);
      if (!original) {
        throw new Error("expected persisted card");
      }
      const delegate = retentionWorktrees();
      const acquisitionStarted = Promise.withResolvers<void>();
      const resumeAcquisition = Promise.withResolvers<void>();
      replaceRetentionRuntime({
        ...delegate,
        async setRetentionClaim(params) {
          if (!params.active) {
            return await delegate.setRetentionClaim(params);
          }
          const accepted =
            pauseAt === "after" ? await delegate.setRetentionClaim(params) : undefined;
          acquisitionStarted.resolve();
          await resumeAcquisition.promise;
          return accepted ?? (await delegate.setRetentionClaim(params));
        },
      });
      const writing = sqlite.cards.registerIfUpdatedAt(
        card.id,
        {
          version: 1,
          card: {
            ...original.card,
            updatedAt: original.card.updatedAt + 1,
            metadata: { ...original.card.metadata, artifacts: [{ path: "dist/report.txt" }] },
          },
        },
        original.card.updatedAt,
      );
      const writeResult = writing.then(
        (applied) => ({ applied }),
        () => ({ applied: false }),
      );
      await acquisitionStarted.promise;
      const recovering = createWorkboardSqliteStores({ env, worktrees: retentionWorktrees() });
      try {
        await recovering.cards.reconcileArtifactRetention();
        resumeAcquisition.resolve();
        await expect(writeResult).resolves.toEqual({ applied: false });
        expect((await recovering.cards.lookup(card.id))?.card.metadata?.artifacts).toBeUndefined();
        await recovering.cards.reconcileArtifactRetention();
        await service.release(worktree.id);
        expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([worktree.id]);
      } finally {
        resumeAcquisition.resolve();
        await writeResult;
        recovering.close();
      }
    },
  );

  it("releases a newly acquired generation when another connection wins the card CAS", async () => {
    const { card, worktree } = await createCardWorktree("conflicting-artifact");
    await writeArtifact(worktree.path);
    const original = await sqlite.cards.lookup(card.id);
    if (!original) {
      throw new Error("expected persisted card");
    }
    const delegate = retentionWorktrees();
    const acquisitionFinished = Promise.withResolvers<void>();
    const resumeCommit = Promise.withResolvers<void>();
    replaceRetentionRuntime({
      ...delegate,
      async setRetentionClaim(params) {
        const accepted = await delegate.setRetentionClaim(params);
        if (params.active) {
          acquisitionFinished.resolve();
          await resumeCommit.promise;
        }
        return accepted;
      },
    });
    const updating = sqlite.cards.registerIfUpdatedAt(
      card.id,
      {
        version: 1,
        card: {
          ...original.card,
          updatedAt: original.card.updatedAt + 1,
          metadata: { ...original.card.metadata, artifacts: [{ path: "dist/report.txt" }] },
        },
      },
      original.card.updatedAt,
    );
    const updateResult = updating.then(
      (applied) => ({ applied }),
      () => ({ applied: false }),
    );
    await acquisitionFinished.promise;
    const competing = createWorkboardSqliteStores({ env });
    try {
      await expect(
        competing.cards.registerIfUpdatedAt(
          card.id,
          {
            version: 1,
            card: {
              ...original.card,
              title: "concurrent winner",
              updatedAt: original.card.updatedAt + 2,
            },
          },
          original.card.updatedAt,
        ),
      ).resolves.toBe(true);
      resumeCommit.resolve();
      await expect(updateResult).resolves.toEqual({ applied: false });
      await sqlite.cards.reconcileArtifactRetention();
      await expect(competing.cards.lookup(card.id)).resolves.toMatchObject({
        card: { title: "concurrent winner" },
      });
      await service.release(worktree.id);
      expect((await service.gc({ limits: { maxCount: 0 } })).removed).toEqual([worktree.id]);
    } finally {
      resumeCommit.resolve();
      await updateResult;
      competing.close();
    }
  });

  it("does not claim URL-only or outside-worktree artifacts", async () => {
    for (const [name, artifact] of [
      ["url-artifact", { url: "https://example.invalid/report.txt" }],
      ["outside-artifact", { path: path.join(root, "shared", "report.txt") }],
    ] as const) {
      const { card, worktree } = await createCardWorktree(name);
      await store.addArtifact(card.id, artifact);
      await cleanupCardWorktree(card.id);
      await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("releases the claim after the card is archived", async () => {
    const { card, worktree } = await createCardWorktree("archived-artifact");
    await fs.mkdir(path.join(worktree.path, "dist"));
    await fs.writeFile(path.join(worktree.path, "dist", "report.txt"), "report\n");
    await store.addArtifact(card.id, { path: "dist/report.txt" });
    await store.archive(card.id, true);

    await cleanupCardWorktree(card.id);

    await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
