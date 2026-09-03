import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
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
  const ordinarySessionKey = "agent:main:dashboard:ordinary";
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
  await replaceSessionEntry(
    { agentId: "main", env, sessionKey: ordinarySessionKey, storePath },
    { sessionId: "ordinary-session", updatedAt: 20 },
  );
  const ordinaryBefore = loadSessionEntry({
    agentId: "main",
    env,
    sessionKey: ordinarySessionKey,
    storePath,
  });

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
  expect(
    loadSessionEntry({ agentId: "main", env, sessionKey: ordinarySessionKey, storePath }),
  ).toEqual(ordinaryBefore);
});

it("repairs a foreign logical row in its source partition without changing a same-key sibling", async () => {
  const root = tempDirs.make("openclaw-worktree-source-partition-");
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(stateDir, "shared.json");
  const workspace = path.join(root, "ops-workspace");
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, ops: { workspace } },
      defaults: { sessionStore: { agentId: "main" } },
    },
    session: { store: storePath },
  };
  await fs.mkdir(workspace, { recursive: true });
  await replaceSessionEntry(
    { agentId: "main", env, sessionKey: "agent:main:ordinary", storePath },
    { sessionId: "ordinary-session", updatedAt: 5 },
  );
  const sourcePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "main",
    env,
  }).path;
  const scope = { agentId: "ops", env, sessionKey: "agent:ops:legacy-worktree", storePath };
  const sourceScope = { ...scope, storePath: sourcePath };
  await replaceSessionEntry(sourceScope, {
    sessionId: "source-session",
    updatedAt: 10,
    worktree: { id: "legacy", branch: "openclaw/legacy", repoRoot: workspace },
  });
  await replaceSessionEntry(scope, {
    sessionId: "sibling-session",
    updatedAt: 20,
    worktree: {
      id: "legacy",
      branch: "openclaw/legacy",
      repoRoot: path.join(root, "unrelated-workspace"),
    },
  });
  const siblingBefore = loadSessionEntry(scope);
  const runMigration = () =>
    migrateManagedWorktreeCanonicalWorkspaces({ agentId: "main", cfg, env, storePath });

  await expect(runMigration()).resolves.toBe(1);
  expect(loadSessionEntry(sourceScope)).toMatchObject({
    sessionId: "source-session",
    updatedAt: 10,
    worktree: {
      id: "legacy",
      branch: "openclaw/legacy",
      repoRoot: workspace,
      canonicalWorkspaceDir: workspace,
    },
  });
  expect(loadSessionEntry(scope)).toEqual(siblingBefore);
  await expect(runMigration()).resolves.toBe(0);
  expect(loadSessionEntry(scope)).toEqual(siblingBefore);
});

it.each(["main", "ops"])(
  "backfills each logical owner's workspace in a shared SQLite store selected for %s",
  async (agentId) => {
    const root = tempDirs.make("openclaw-shared-worktree-workspace-migration-");
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storePath = path.join(stateDir, "shared.sqlite");
    const agents = ["main", "ops"].map((id) => ({ id, workspace: path.join(root, id) }));
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(agents.map(({ id, workspace }) => [id, { workspace }])),
        defaults: { sessionStore: { agentId: "main" } },
      },
      session: { store: storePath },
    };
    // Stage persisted legacy rows without a runtime write pruning the previous old row.
    for (const agent of agents) {
      await fs.mkdir(agent.workspace, { recursive: true });
      replaceSessionEntrySync(
        { agentId: agent.id, env, sessionKey: `agent:${agent.id}:worktree`, storePath },
        {
          sessionId: `${agent.id}-session`,
          updatedAt: 10,
          worktree: { id: agent.id, branch: `openclaw/${agent.id}`, repoRoot: agent.workspace },
        },
      );
    }

    const readEntries = () =>
      agents.map((agent) =>
        loadSessionEntry({
          agentId: agent.id,
          env,
          sessionKey: `agent:${agent.id}:worktree`,
          storePath,
        }),
      );
    expect(readEntries().map((entry) => entry?.sessionId)).toEqual(
      agents.map((agent) => `${agent.id}-session`),
    );
    const runMigration = () =>
      migrateManagedWorktreeCanonicalWorkspaces({ agentId, cfg, env, storePath });
    await expect(runMigration()).resolves.toBe(2);
    const migrated = readEntries();
    expect(migrated).toEqual(
      agents.map((agent) =>
        expect.objectContaining({
          sessionId: `${agent.id}-session`,
          updatedAt: 10,
          worktree: {
            id: agent.id,
            branch: `openclaw/${agent.id}`,
            repoRoot: agent.workspace,
            canonicalWorkspaceDir: agent.workspace,
          },
        }),
      ),
    );
    await expect(runMigration()).resolves.toBe(0);
    expect(readEntries()).toEqual(migrated);
  },
);
