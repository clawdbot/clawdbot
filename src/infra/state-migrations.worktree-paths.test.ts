import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../agents/worktrees/service.test-support.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { detectLegacyStateMigrations, runLegacyStateMigrations } from "./state-migrations.js";

describe("managed worktree path state migrations", () => {
  let root: string | undefined;

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes persisted paths from symlinked state directories",
    async () => {
      root = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-path-migration-"),
      );
      const repo = await initializeManagedWorktreeTestRepository(root);
      const realStateDir = path.join(root, "real-state");
      const linkedStateDir = path.join(root, "linked-state");
      await fs.mkdir(realStateDir, { recursive: true });
      await fs.symlink(realStateDir, linkedStateDir, "dir");
      const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: linkedStateDir };
      const service = new ManagedWorktreeService({ env });
      const live = await service.create({ repoRoot: repo, name: "live", baseRef: "HEAD" });
      const removed = await service.create({ repoRoot: repo, name: "removed", baseRef: "HEAD" });
      const canonical = await service.create({
        repoRoot: repo,
        name: "canonical",
        baseRef: "HEAD",
      });
      const moved = await service.create({ repoRoot: repo, name: "moved", baseRef: "HEAD" });
      await service.remove({ id: removed.id, reason: "migration-fixture" });

      const rawLivePath = path.join(linkedStateDir, "worktrees", live.repoFingerprint, live.name);
      const rawRemovedPath = path.join(
        linkedStateDir,
        "worktrees",
        removed.repoFingerprint,
        removed.name,
      );
      const db = openOpenClawStateDatabase({ env }).db;
      db.prepare("UPDATE worktrees SET path = ? WHERE id = ?").run(rawLivePath, live.id);
      db.prepare("UPDATE worktrees SET path = ? WHERE id = ?").run(rawRemovedPath, removed.id);
      const movedPath = path.join(root, "relocated-worktrees", moved.name);
      db.prepare("UPDATE worktrees SET path = ? WHERE id = ?").run(movedPath, moved.id);

      const cfg = {} as OpenClawConfig;
      const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root! });
      expect(detected.preview).toContain(
        "- Managed worktrees: canonicalize 2 persisted paths for symlinked state directories",
      );
      const result = await runLegacyStateMigrations({ detected, config: cfg, env });
      expect(result.warnings).toStrictEqual([]);
      expect(result.changes).toContain(
        "Canonicalized 2 managed worktree paths for symlinked state directories",
      );
      expect(getRegistryWorktree(env, live.id)?.path).toBe(live.path);
      expect(getRegistryWorktree(env, removed.id)?.path).toBe(removed.path);
      expect(getRegistryWorktree(env, canonical.id)?.path).toBe(canonical.path);
      expect(getRegistryWorktree(env, moved.id)?.path).toBe(movedPath);

      const secondDetection = await detectLegacyStateMigrations({
        cfg,
        env,
        homedir: () => root!,
      });
      expect(secondDetection.worktrees.pathRewrites).toStrictEqual([]);
      const secondResult = await runLegacyStateMigrations({
        detected: secondDetection,
        config: cfg,
        env,
      });
      expect(secondResult.changes).not.toContain(
        "Canonicalized 2 managed worktree paths for symlinked state directories",
      );

      await service.acquire(live.id);
      await expect(service.removeIfLossless(live.id)).resolves.toBe(true);
      await expect(fs.stat(live.path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
