import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getRegistryWorktree, insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../agents/worktrees/service.test-support.js";
import type { OpenClawConfig } from "../config/config.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";

describe("managed worktree path state migrations", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  });

  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  it("does not create the worktrees directory during detection", async () => {
    const root = tempDirs.make("openclaw-worktree-path-detection-");
    const stateDir = path.join(root, "state");
    const worktreesDir = path.join(stateDir, "worktrees");
    await fs.mkdir(stateDir, { recursive: true });
    const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: stateDir };

    const detected = await detectLegacyStateMigrations({
      cfg: {} as OpenClawConfig,
      env,
      homedir: () => root,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(detected.worktrees.pathRewrites).toStrictEqual([]);
    await expect(fs.stat(worktreesDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes persisted paths when the latest additive worktree column is absent",
    async () => {
      const root = tempDirs.make(
        "openclaw-worktree-path-migration-",
        await fs.realpath(os.tmpdir()),
      );
      const repo = await initializeManagedWorktreeTestRepository(root);
      const realStateDir = path.join(root, "real-state");
      const linkedStateDir = path.join(root, "linked-state");
      await fs.mkdir(realStateDir, { recursive: true });
      await fs.symlink(realStateDir, linkedStateDir, "dir");
      const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: linkedStateDir };
      const service = new ManagedWorktreeService({ env });
      const live = await service.create({ repoRoot: repo, name: "live", baseRef: "HEAD" });
      const canonicalRoot = path.dirname(path.dirname(live.path));
      const rawLivePath = path.join(linkedStateDir, "worktrees", live.repoFingerprint, live.name);
      const rawRemovedPath = path.join(
        linkedStateDir,
        "worktrees",
        live.repoFingerprint,
        "removed",
      );
      const database = openOpenClawStateDatabase({ env });
      const db = database.db;
      db.prepare("UPDATE worktrees SET path = ? WHERE id = ?").run(rawLivePath, live.id);
      const removed = {
        ...live,
        id: "legacy-removed",
        name: "removed",
        path: rawRemovedPath,
        branch: "openclaw/removed",
        removedAt: 1,
      };
      const canonical = {
        ...live,
        id: "canonical-row",
        name: "canonical",
        path: path.join(canonicalRoot, live.repoFingerprint, "canonical"),
        branch: "openclaw/canonical",
      };
      const movedPath = path.join(root, "relocated-worktrees", "moved");
      const moved = {
        ...live,
        id: "moved-row",
        name: "moved",
        path: movedPath,
        branch: "openclaw/moved",
      };
      insertRegistryWorktree(env, removed, { provisionedPaths: [] });
      insertRegistryWorktree(env, canonical, { provisionedPaths: [] });
      insertRegistryWorktree(env, moved, { provisionedPaths: [] });

      closeOpenClawStateDatabaseForTest();
      const { DatabaseSync } = requireNodeSqlite();
      const beforeCleanupOutcome = new DatabaseSync(database.path);
      try {
        beforeCleanupOutcome.exec("ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json;");
      } finally {
        beforeCleanupOutcome.close();
      }

      const cfg = {} as OpenClawConfig;
      // Doctor's read-only SELECT * follows the physical columns. Compatibility
      // validation must allow this additive column to be absent before that query.
      const detected = await detectLegacyStateMigrations({
        cfg,
        env,
        homedir: () => root,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(detected.preview).toContain(
        "- Managed worktrees: canonicalize 2 persisted paths for symlinked state directories",
      );
      const result = await runLegacyStateMigrations({
        detected,
        config: cfg,
        env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(result.warnings).toStrictEqual([]);
      expect(result.changes).toContain(
        "Canonicalized 2 managed worktree paths for symlinked state directories",
      );
      expect(
        result.stepReceipts.find((receipt) => receipt.id === "managed-worktrees"),
      ).toMatchObject({
        source: [
          { kind: "sqlite", path: database.path },
          ...[live.id, removed.id]
            .toSorted()
            .map((id) => ({ kind: "owner", id: `core:managed-worktree:${id}` })),
        ],
        outcome: "completed",
      });
      expect(getRegistryWorktree(env, live.id)?.path).toBe(live.path);
      expect(getRegistryWorktree(env, removed.id)?.path).toBe(
        path.join(canonicalRoot, live.repoFingerprint, removed.name),
      );
      expect(getRegistryWorktree(env, canonical.id)?.path).toBe(canonical.path);
      expect(getRegistryWorktree(env, moved.id)?.path).toBe(movedPath);

      const secondDetection = await detectLegacyStateMigrations({
        cfg,
        env,
        homedir: () => root,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(secondDetection.worktrees.pathRewrites).toStrictEqual([]);
      const secondResult = await runLegacyStateMigrations({
        detected: secondDetection,
        config: cfg,
        env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
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
