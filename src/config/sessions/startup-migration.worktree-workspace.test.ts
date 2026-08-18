import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "./worktree-workspace-migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("backfills a nested requested workspace once instead of using the agent default", async () => {
  const root = tempDirs.make("openclaw-worktree-workspace-migration-");
  const stateDir = path.join(root, "state");
  const repoRoot = path.join(root, "repo");
  const agentWorkspace = path.join(repoRoot, "agent-default");
  const requestedWorkspace = path.join(repoRoot, "packages", "app");
  const worktreeRoot = path.join(stateDir, "worktrees", "legacy");
  const spawnedCwd = path.join(worktreeRoot, "packages", "app");
  await Promise.all([
    fs.mkdir(agentWorkspace, { recursive: true }),
    fs.mkdir(requestedWorkspace, { recursive: true }),
    fs.mkdir(spawnedCwd, { recursive: true }),
  ]);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const sessionKey = "agent:main:dashboard:legacy-worktree";
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true, workspace: agentWorkspace }] },
    session: { store: storePath },
  };
  insertRegistryWorktree(env, {
    id: "legacy",
    name: "legacy",
    repoFingerprint: "0123456789abcdef",
    repoRoot,
    path: worktreeRoot,
    branch: "openclaw/legacy",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  });
  await replaceSessionEntry(
    { agentId: "main", env, sessionKey, storePath },
    {
      sessionId: "legacy-session",
      updatedAt: 10,
      spawnedCwd,
      worktree: { id: "legacy", branch: "openclaw/legacy", repoRoot },
    },
  );

  const runMigration = async () =>
    await migrateManagedWorktreeCanonicalWorkspaces({
      agentId: "main",
      cfg,
      env,
      storePath,
    });

  await runMigration();
  const first = loadSessionEntry({ agentId: "main", env, sessionKey, storePath });
  expect(first?.worktree?.canonicalWorkspaceDir).toBe(requestedWorkspace);
  expect(first?.updatedAt).toBe(10);

  await runMigration();
  expect(loadSessionEntry({ agentId: "main", env, sessionKey, storePath })).toEqual(first);
});
