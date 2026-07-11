// Session creation tests protect dashboard-origin session records, transcript
// creation, parent linkage, and model/provider overrides exposed by the gateway API.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import {
  findLiveRegistryWorktreeByOwner,
  listRegistryWorktrees,
} from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  agentCommand,
  agentDiscoveryMock,
  embeddedRunMock,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  createCheckpointFixture,
  sessionStoreEntry,
  directSessionReq,
  sessionHookMocks,
  sessionLifecycleHookMocks,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore, openClient } =
  setupGatewaySessionsTestHarness();
const execFileAsync = promisify(execFile);

async function initializeGitWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
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
  return await fs.realpath(workspace);
}

function requireNonEmptyString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

test("sessions.create provisions and reuses a session worktree for later runs", async () => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-session-worktree-"),
  );
  const workspace = await initializeGitWorkspace(root);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    const key = requireNonEmptyString(created.payload?.key, "created session key");
    const worktree = created.payload?.worktree;
    expect(worktree?.branch).toMatch(/^openclaw\/wt-[a-f0-9]{8}$/);
    expect(created.payload?.entry.spawnedCwd).toBe(worktree?.path);
    worktreeId = worktree?.id;
    expect(findLiveRegistryWorktreeByOwner(process.env, "session", key)).toMatchObject({
      id: worktree?.id,
      path: worktree?.path,
      ownerKind: "session",
      ownerId: key,
    });

    const recreated = await directSessionReq<{
      entry: { spawnedCwd?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      { key, agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(recreated.ok).toBe(true);
    expect(recreated.payload?.worktree).toEqual(worktree);
    expect(recreated.payload?.entry.spawnedCwd).toBe(worktree?.path);
    expect(
      listRegistryWorktrees(process.env).filter(
        (record) =>
          record.ownerKind === "session" &&
          record.ownerId === key &&
          record.removedAt === undefined,
      ),
    ).toHaveLength(1);

    agentCommand.mockClear();
    const { ws } = await openClient();
    const run = await rpcReq(ws, "agent", {
      message: "verify worktree cwd",
      sessionKey: key,
      idempotencyKey: "session-worktree-cwd",
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    await vi.waitFor(() => expect(agentCommand).toHaveBeenCalled());
    expect(agentCommand.mock.calls.at(-1)?.[0]).toMatchObject({
      cwd: worktree?.path,
      workspaceDir: worktree?.path,
    });
    ws.close();
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    testState.agentConfig = undefined;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sessions.create honors worktree name/base ref and persists worktree info", async () => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-session-worktree-target-"),
  );
  const workspace = await initializeGitWorkspace(root);
  await execFileAsync("git", ["-C", workspace, "checkout", "-b", "base-branch"]);
  await fs.writeFile(path.join(workspace, "base.txt"), "base\n");
  await execFileAsync("git", ["-C", workspace, "add", "base.txt"]);
  await execFileAsync("git", ["-C", workspace, "commit", "-m", "base branch commit"]);
  const { stdout: baseCommitRaw } = await execFileAsync("git", [
    "-C",
    workspace,
    "rev-parse",
    "HEAD",
  ]);
  await execFileAsync("git", ["-C", workspace, "checkout", "main"]);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string; worktree?: { id: string; branch: string; repoRoot: string } };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        worktree: true,
        worktreeName: "target-task",
        worktreeBaseRef: "base-branch",
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    const worktree = created.payload?.worktree;
    worktreeId = worktree?.id;
    expect(worktree?.branch).toBe("openclaw/target-task");
    const { stdout: worktreeCommitRaw } = await execFileAsync("git", [
      "-C",
      requireNonEmptyString(worktree?.path, "worktree path"),
      "rev-parse",
      "HEAD",
    ]);
    expect(worktreeCommitRaw.trim()).toBe(baseCommitRaw.trim());
    expect(created.payload?.entry.worktree).toEqual({
      id: worktree?.id,
      branch: "openclaw/target-task",
      repoRoot: workspace,
    });

    const rejected = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktreeName: "no-flag" },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(rejected.ok).toBe(false);
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    testState.agentConfig = undefined;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sessions.create execNode binds session exec routing", async () => {
  await createSessionStoreDir();
  const created = await directSessionReq<{
    key: string;
    entry: { execHost?: string; execNode?: string };
  }>(
    "sessions.create",
    { agentId: "main", execNode: "macbook" },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );
  expect(created.ok).toBe(true);
  expect(created.payload?.entry.execHost).toBe("node");
  expect(created.payload?.entry.execNode).toBe("macbook");
});

test("sessions.create provisions a worktree from an admin-selected cwd", async () => {
  const configuredRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-configured-workspace-"),
  );
  const selectedRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-selected-workspace-"),
  );
  const configuredWorkspace = await initializeGitWorkspace(configuredRoot);
  const selectedWorkspace = await initializeGitWorkspace(selectedRoot);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(configuredRoot, "state");
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace: configuredWorkspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true, cwd: selectedWorkspace },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    const worktree = created.payload?.worktree;
    worktreeId = worktree?.id;
    expect(created.payload?.entry.spawnedCwd).toBe(worktree?.path);
    expect(
      findLiveRegistryWorktreeByOwner(process.env, "session", created.payload?.key ?? ""),
    ).toMatchObject({
      id: worktree?.id,
      repoRoot: selectedWorkspace,
    });

    const mismatched = await directSessionReq(
      "sessions.create",
      {
        key: created.payload?.key,
        agentId: "main",
        worktree: true,
        cwd: configuredWorkspace,
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(mismatched).toMatchObject({
      ok: false,
      error: { message: "session worktree belongs to a different repository" },
    });
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    testState.agentConfig = undefined;
    await fs.rm(configuredRoot, { recursive: true, force: true });
    await fs.rm(selectedRoot, { recursive: true, force: true });
  }
});

test("sessions.create rejects cwd without a managed worktree", async () => {
  const created = await directSessionReq("sessions.create", { cwd: "/tmp/repo" });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "sessions.create cwd requires worktree=true",
  });
});

test("sessions.create skips the worktree setup script for non-admin callers", async () => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-setup-scope-"),
  );
  const workspace = await initializeGitWorkspace(root);
  await fs.mkdir(path.join(workspace, ".openclaw"), { recursive: true });
  const setupScript = path.join(workspace, ".openclaw", "worktree-setup.sh");
  await fs.writeFile(setupScript, "#!/bin/sh\ntouch setup-marker.txt\n");
  await fs.chmod(setupScript, 0o755);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );
    expect(created.ok).toBe(true);
    const worktree = requireNonEmptyString(created.payload?.worktree.path, "worktree path");
    worktreeId = created.payload?.worktree.id;
    // Write-scoped callers get provisioning but never repo-script execution.
    await expect(fs.stat(path.join(worktree, "setup-marker.txt"))).rejects.toThrow();
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    testState.agentConfig = undefined;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sessions.create preserves a linked-worktree subdirectory", async () => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-subdir-session-worktree-"),
  );
  const repoRoot = await initializeGitWorkspace(root);
  const linkedRoot = path.join(root, "linked");
  await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "-b", "linked", linkedRoot]);
  const workspace = path.join(linkedRoot, "packages", "app");
  await fs.mkdir(workspace, { recursive: true });
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(created.ok).toBe(true);
    const worktree = created.payload?.worktree;
    worktreeId = worktree?.id;
    // The managed worktree anchors at the repo root even when the workspace is nested;
    // the session cwd points at the equivalent subdirectory inside the worktree.
    expect(worktree?.branch).toMatch(/^openclaw\/wt-[a-f0-9]{8}$/);
    expect(created.payload?.entry.spawnedCwd).toBe(
      path.join(requireNonEmptyString(worktree?.path, "worktree path"), "packages", "app"),
    );
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    testState.agentConfig = undefined;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sessions.create reset-in-place persists the returned worktree cwd", async () => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-reset-session-worktree-"),
  );
  const workspace = await initializeGitWorkspace(root);
  // A remote makes the base commit reachable from `--remotes`, so leaving the worktree via a
  // plain New Chat is lossless and the reset can remove it (the real leave-worktree flow).
  const origin = path.join(root, "origin.git");
  await execFileAsync("git", ["init", "--bare", origin]);
  await execFileAsync("git", ["-C", workspace, "remote", "add", "origin", origin]);
  await execFileAsync("git", ["-C", workspace, "push", "-u", "origin", "main"]);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace, model: { primary: "openai/current-model" } };
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-reset-parent") } });
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      resolved: { modelProvider?: string; model?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        parentSessionKey: "main",
        emitCommandHooks: true,
        worktree: true,
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe("agent:main:main");
    expect(created.payload?.resolved).toEqual({
      modelProvider: "openai",
      model: "current-model",
    });
    const worktree = created.payload?.worktree;
    worktreeId = worktree?.id;
    expect(created.payload?.entry.spawnedCwd).toBe(worktree?.path);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.spawnedCwd).toBe(
      worktree?.path,
    );

    // A later plain New Chat on the same main session must leave the worktree: cwd clears
    // and the (clean) session worktree is lossless-removed rather than left orphaned.
    const reset = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      resolved: { modelProvider?: string; model?: string };
    }>(
      "sessions.create",
      { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );
    expect(reset.ok).toBe(true);
    expect(reset.payload?.entry.spawnedCwd).toBeUndefined();
    expect(reset.payload?.resolved).toEqual({
      modelProvider: "openai",
      model: "current-model",
    });
    expect(
      listRegistryWorktrees(process.env).filter(
        (record) =>
          record.ownerKind === "session" &&
          record.ownerId === "agent:main:main" &&
          record.removedAt === undefined,
      ),
    ).toHaveLength(0);
    worktreeId = undefined;
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    testState.agentConfig = undefined;
    testState.sessionConfig = undefined;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sessions.create rejects worktrees for non-git agent workspaces", async () => {
  const workspace = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-session-plain-workspace-"),
  );
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  try {
    const created = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "agent workspace is not a git checkout",
    });
  } finally {
    testState.agentConfig = undefined;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("sessions.create stores dashboard session model and parent linkage, and creates a transcript", async () => {
  const { storePath } = await createSessionStoreDir();
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent"),
    },
  });
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
      providerOverride?: string;
      modelOverride?: string;
      parentSessionKey?: string;
      sessionFile?: string;
    };
  }>("sessions.create", {
    agentId: "ops",
    label: "Dashboard Chat",
    model: "openai/gpt-test-a",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.entry?.label).toBe("Dashboard Chat");
  expect(created.payload?.entry?.providerOverride).toBe("openai");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-test-a");
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  const sessionFile = requireNonEmptyString(
    created.payload?.entry?.sessionFile,
    "created session file",
  );
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "ops", sessionKey: key, storePath });
  expect(storedEntry?.sessionId).toBe(created.payload?.sessionId);
  expect(storedEntry?.label).toBe("Dashboard Chat");
  expect(storedEntry?.providerOverride).toBe("openai");
  expect(storedEntry?.modelOverride).toBe("gpt-test-a");
  expect(storedEntry?.parentSessionKey).toBe("agent:main:main");
  expect(sessionFile).toBe(storedEntry?.sessionFile);

  await expect(
    loadTranscriptEvents({
      agentId: "ops",
      sessionId: requireNonEmptyString(created.payload?.sessionId, "created session id"),
      sessionKey: key,
      storePath,
    }),
  ).resolves.toEqual([
    expect.objectContaining({ id: created.payload?.sessionId, type: "session" }),
  ]);
});

test("sessions.create inherits explicit selection without runtime model identity", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent", {
        providerOverride: "codex",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        agentRuntimeOverride: "codex",
        modelProvider: "codex",
        model: "gpt-5.5",
        contextTokens: 272000,
        inputTokens: 12000,
        outputTokens: 340,
        totalTokens: 12340,
        totalTokensFresh: false,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 1,
          provider: "codex",
          model: "gpt-5.5",
          route: "compact_then_truncate",
          shouldCompact: true,
          estimatedPromptTokens: 250000,
          contextTokenBudget: 128000,
          promptBudgetBeforeReserve: 112000,
          reserveTokens: 16000,
          effectiveReserveTokens: 16000,
          remainingPromptBudgetTokens: 0,
          overflowTokens: 138000,
          toolResultReducibleChars: 5000,
          messageCount: 12,
          unwindowedMessageCount: 12,
        },
        thinkingLevel: "off",
        fastMode: "auto",
        traceLevel: "debug",
        authProfileOverride: "codex-oauth",
        authProfileOverrideSource: "user",
      }),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    resolved?: { modelProvider?: string; model?: string };
    entry?: {
      providerOverride?: string;
      modelOverride?: string;
      modelOverrideSource?: string;
      agentRuntimeOverride?: string;
      modelProvider?: string;
      model?: string;
      contextTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      totalTokensFresh?: boolean;
      contextBudgetStatus?: unknown;
      thinkingLevel?: string;
      fastMode?: string;
      traceLevel?: string;
      authProfileOverride?: string;
      authProfileOverrideSource?: string;
      parentSessionKey?: string;
    };
  }>("sessions.create", {
    agentId: "main",
    label: "Fresh Chat",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.providerOverride).toBe("codex");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-5.5");
  expect(created.payload?.entry?.modelOverrideSource).toBe("user");
  expect(created.payload?.entry?.agentRuntimeOverride).toBe("codex");
  expect(created.payload?.entry?.modelProvider).toBeUndefined();
  expect(created.payload?.entry?.model).toBeUndefined();
  expect(created.payload?.resolved).toEqual({ modelProvider: "codex", model: "gpt-5.5" });
  expect(created.payload?.entry?.contextTokens).toBeUndefined();
  expect(created.payload?.entry?.inputTokens).toBeUndefined();
  expect(created.payload?.entry?.outputTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokensFresh).toBeUndefined();
  expect(created.payload?.entry?.contextBudgetStatus).toBeUndefined();
  expect(created.payload?.entry?.thinkingLevel).toBe("off");
  expect(created.payload?.entry?.fastMode).toBe("auto");
  expect(created.payload?.entry?.traceLevel).toBe("debug");
  expect(created.payload?.entry?.authProfileOverride).toBe("codex-oauth");
  expect(created.payload?.entry?.authProfileOverrideSource).toBe("user");

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(storedEntry?.providerOverride).toBe("codex");
  expect(storedEntry?.modelOverride).toBe("gpt-5.5");
  expect(storedEntry?.modelProvider).toBeUndefined();
  expect(storedEntry?.model).toBeUndefined();
  expect(storedEntry?.parentSessionKey).toBe("agent:main:main");
});

test("sessions.create resolves the current default instead of inherited runtime identity", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = { model: { primary: "anthropic/current-model" } };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent-stale", {
        modelProvider: "openai",
        model: "stale-model",
      }),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    resolved?: { modelProvider?: string; model?: string };
    entry?: { modelProvider?: string; model?: string };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.modelProvider).toBeUndefined();
  expect(created.payload?.entry?.model).toBeUndefined();
  expect(created.payload?.resolved).toEqual({
    modelProvider: "anthropic",
    model: "current-model",
  });

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(storedEntry?.modelProvider).toBeUndefined();
  expect(storedEntry?.model).toBeUndefined();
});

test("sessions.create accepts an explicit key for persistent dashboard sessions", async () => {
  await createSessionStoreDir();

  const key = "agent:ops-agent:dashboard:direct:subagent-orchestrator";
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
    };
  }>("sessions.create", {
    key,
    label: "Dashboard Orchestrator",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe(key);
  expect(created.payload?.entry?.label).toBe("Dashboard Orchestrator");
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("sessions.create scopes the main alias to the requested agent", async () => {
  const { storePath } = await createSessionStoreDir();

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
    };
  }>("sessions.create", {
    key: "main",
    agentId: "longmemeval",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe("agent:longmemeval:main");
  requireNonEmptyString(created.payload?.entry?.sessionFile, "longmemeval session file");

  expect(
    loadSessionEntry({
      agentId: "longmemeval",
      sessionKey: "agent:longmemeval:main",
      storePath,
    })?.sessionId,
  ).toBe(created.payload?.sessionId);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
  ).toBeUndefined();
});

test("sessions.create replaces a dead main entry with a fresh session id", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  try {
    await writeSessionStore({
      agentId: "ops",
      entries: {
        main: {
          updatedAt: 1,
          label: "Ops Main",
          sessionFile: "stale.jsonl",
        },
      },
    });

    const created = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        label?: string;
        sessionFile?: string;
      };
    }>("sessions.create", {
      key: "main",
      agentId: "ops",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe("agent:ops:main");
    expect(created.payload?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.payload?.entry?.label).toBeUndefined();
    expect(created.payload?.entry?.sessionFile).not.toBe("stale.jsonl");

    const storedEntry = loadSessionEntry({
      agentId: "ops",
      sessionKey: "agent:ops:main",
      storePath,
    });
    expect(storedEntry?.sessionId).toBe(created.payload?.sessionId);
    expect(storedEntry?.sessionFile).not.toBe("stale.jsonl");
  } finally {
    testState.agentsConfig = undefined;
  }
});

test("sessions.create preserves global and unknown sentinel keys", async () => {
  const { storePath } = await createSessionStoreDir();

  const globalCreated = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
    };
  }>("sessions.create", {
    key: "global",
    agentId: "longmemeval",
  });

  expect(globalCreated.ok).toBe(true);
  expect(globalCreated.payload?.key).toBe("global");
  requireNonEmptyString(globalCreated.payload?.entry?.sessionFile, "global session file");

  const unknownCreated = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
    };
  }>("sessions.create", {
    key: "unknown",
    agentId: "longmemeval",
  });

  expect(unknownCreated.ok).toBe(true);
  expect(unknownCreated.payload?.key).toBe("unknown");
  requireNonEmptyString(unknownCreated.payload?.entry?.sessionFile, "unknown session file");

  expect(
    loadSessionEntry({ agentId: "longmemeval", sessionKey: "global", storePath })?.sessionId,
  ).toBe(globalCreated.payload?.sessionId);
  expect(
    loadSessionEntry({ agentId: "longmemeval", sessionKey: "unknown", storePath })?.sessionId,
  ).toBe(unknownCreated.payload?.sessionId);
  expect(
    loadSessionEntry({
      agentId: "longmemeval",
      sessionKey: "agent:longmemeval:global",
      storePath,
    }),
  ).toBeUndefined();
  expect(
    loadSessionEntry({
      agentId: "longmemeval",
      sessionKey: "agent:longmemeval:unknown",
      storePath,
    }),
  ).toBeUndefined();
});

test("sessions.create stores selected global sessions in the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const broadcastToConnIds = vi.fn();

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: { sessionFile?: string };
  }>(
    "sessions.create",
    {
      key: "global",
      agentId: "work",
    },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe("global");
  requireNonEmptyString(created.payload?.entry?.sessionFile, "work global session file");
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath }),
  ).toBeUndefined();
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: "global", storePath: workStorePath })
      ?.sessionId,
  ).toBe(created.payload?.sessionId);
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ sessionKey: "global", agentId: "work", reason: "create" }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
});

test("sessions.create loads selected global parent from the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-parent", {
          providerOverride: "codex",
          modelOverride: "main-model",
        }),
      },
    });
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-parent", {
          providerOverride: "openai",
          modelOverride: "work-model",
          thinkingLevel: "high",
        }),
      },
    });

    const created = await directSessionReq<{
      key?: string;
      entry?: {
        parentSessionKey?: string;
        providerOverride?: string;
        modelOverride?: string;
        thinkingLevel?: string;
      };
    }>("sessions.create", {
      agentId: "work",
      parentSessionKey: "global",
      emitCommandHooks: true,
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:work:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("global");
    expect(created.payload?.entry?.providerOverride).toBe("openai");
    expect(created.payload?.entry?.modelOverride).toBe("work-model");
    expect(created.payload?.entry?.thinkingLevel).toBe("high");

    const commandNewEvent = (
      sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
    )
      .map((call) => call[0])
      .find(
        (
          event,
        ): event is {
          context?: { sessionEntry?: { sessionId?: string } };
        } =>
          Boolean(event) &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "command" &&
          (event as { action?: unknown }).action === "new",
      );
    expect(commandNewEvent?.context?.sessionEntry?.sessionId).toBe("sess-work-parent");
    const [endEvent] = sessionLifecycleHookMocks.runSessionEnd.mock.calls[0] as unknown as [
      { sessionId?: string; sessionKey?: string },
      unknown,
    ];
    expect(endEvent.sessionId).toBe("sess-work-parent");
    expect(endEvent.sessionKey).toBe("global");
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.get reads selected global messages from the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-global"),
      },
    });
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-global"),
      },
    });
    await seedSessionTranscript({
      agentId: "main",
      messages: [{ role: "user", content: "main global" }],
      sessionId: "sess-main-global",
      sessionKey: "global",
      storePath: mainStorePath,
    });
    await seedSessionTranscript({
      agentId: "work",
      messages: [{ role: "user", content: "work global" }],
      sessionId: "sess-work-global",
      sessionKey: "global",
      storePath: workStorePath,
    });

    const result = await directSessionReq<{ messages?: unknown[] }>("sessions.get", {
      key: "global",
      agentId: "work",
    });

    expect(result.ok).toBe(true);
    const renderedMessages = JSON.stringify(result.payload?.messages ?? []);
    expect(renderedMessages).toContain("work global");
    expect(renderedMessages).not.toContain("main global");
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create sends selected global initial tasks to the requested agent", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    runStarted?: boolean;
    runId?: string;
  }>(ws, "sessions.create", {
    key: "global",
    agentId: "work",
    task: "hello selected global",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe("global");
  expect(created.payload?.runStarted).toBe(true);
  const runId = requireNonEmptyString(created.payload?.runId, "selected global run id");
  const wait = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 1_000 });
  expect(wait.ok).toBe(true);
  const workEntry = loadSessionEntry({
    agentId: "work",
    sessionKey: "global",
    storePath: workStorePath,
  });
  const workSessionId = requireNonEmptyString(workEntry?.sessionId, "selected global session id");
  await expect(
    loadTranscriptEvents({
      agentId: "work",
      sessionId: workSessionId,
      sessionKey: "global",
      storePath: workStorePath,
    }),
  ).resolves.toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({ content: "hello selected global" }),
      type: "message",
    }),
  );
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath }),
  ).toBeUndefined();
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
  ws.close();
});

test("sessions.create rejects unknown parentSessionKey", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", {
    agentId: "ops",
    parentSessionKey: "agent:main:missing",
  });

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
    "unknown parent session",
  );
});

test("sessions.create forks the parent transcript into the new session", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        totalTokens: 123,
        totalTokensFresh: true,
      }),
    },
  });
  await seedSessionTranscript({
    sessionId: parent.sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [
      { role: "user", content: "before compaction" },
      { role: "assistant", content: [{ type: "text", text: "working on it" }] },
    ],
  });

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
      parentSessionKey?: string;
      forkedFromParent?: boolean;
      totalTokens?: number;
      totalTokensFresh?: boolean;
    };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    fork: true,
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.forkedFromParent).toBe(true);
  expect(created.payload?.entry?.totalTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokensFresh).toBe(false);
  expect(created.payload?.sessionId).not.toBe(parent.sessionId);
  const forkedSessionFile = requireNonEmptyString(
    created.payload?.entry?.sessionFile,
    "forked session file",
  );
  const readMessages = async (scope: {
    sessionFile?: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) =>
    (await loadTranscriptEvents(scope))
      .filter((entry): entry is { type: "message"; message: unknown } => {
        return (
          entry !== null &&
          typeof entry === "object" &&
          "type" in entry &&
          entry.type === "message" &&
          "message" in entry
        );
      })
      .map((entry) => entry.message);
  const forkedSessionId = requireNonEmptyString(created.payload?.sessionId, "forked session id");
  expect(
    await readMessages({
      sessionFile: forkedSessionFile,
      sessionId: forkedSessionId,
      sessionKey: created.payload?.key ?? "",
      storePath,
    }),
  ).toEqual(
    await readMessages({
      sessionId: parent.sessionId,
      sessionKey: "agent:main:main",
      storePath,
    }),
  );

  const key = requireNonEmptyString(created.payload?.key, "forked session key");
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    sessionId: created.payload?.sessionId,
    sessionFile: forkedSessionFile,
    forkedFromParent: true,
  });
  testState.sessionConfig = undefined;
});

test("public session mutations reserve agent harness-owned session keys", async () => {
  const { storePath } = await createSessionStoreDir();

  for (const key of [
    "harness:codex:supervision:native-thread",
    "agent:main:harness:codex:supervision:native-thread",
  ]) {
    for (const [method, params] of [
      ["sessions.create", { agentId: "main", key }],
      ["sessions.patch", { agentId: "main", key, label: "Public overwrite" }],
      ["sessions.reset", { agentId: "main", key }],
    ] as const) {
      const rejected = await directSessionReq(method, params);
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "Session key namespace is reserved for agent harness-owned sessions.",
      });
    }
  }

  const ordinary = await directSessionReq<{ key: string }>("sessions.create", {
    agentId: "main",
    key: "ordinary-session",
  });
  expect(ordinary.ok).toBe(true);
  expect(ordinary.payload?.key).toBe("agent:main:ordinary-session");

  expect(
    loadSessionEntry({
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
      storePath,
    }),
  ).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: "agent:main:ordinary-session", storePath })).toBeDefined();
});

test("sessions.create preserves a pre-existing unlocked harness-prefixed session", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:harness:legacy-notes";
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("legacy-session", { label: "Legacy notes" }),
    },
  });

  const created = await directSessionReq<{
    key: string;
    sessionId: string;
  }>("sessions.create", {
    agentId: "main",
    key,
    label: "Updated notes",
  });

  expect(created.ok).toBe(true);
  expect(created.payload).toMatchObject({ key, sessionId: "legacy-session" });
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    sessionId: "legacy-session",
    label: "Updated notes",
  });
});

test("sessions.create rejects a pre-existing locked harness session", async () => {
  await createSessionStoreDir();
  const key = "agent:main:harness:codex:supervision:native-thread";
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("locked-session", {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }),
    },
  });

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    key,
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "Session key namespace is reserved for agent harness-owned sessions.",
  });
});

test("sessions.create rejects children of model-selection-locked sessions", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main", scope: "per-sender" };
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        modelSelectionLocked: true,
      }),
    },
  });

  const linkedChild = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
  });
  const forkedChild = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    fork: true,
  });
  const resetParent = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
  });

  for (const created of [linkedChild, forkedChild, resetParent]) {
    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Model-selection-locked sessions cannot create child sessions from parent context.",
    });
  }
  testState.sessionConfig = undefined;
});

test("sessions.create rejects fork without parentSessionKey", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", { fork: true });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "fork requires parentSessionKey",
  });
});

test("sessions.create rejects fork when the parent exceeds the fork size cap", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        // Fresh persisted usage above DEFAULT_PARENT_FORK_MAX_TOKENS (100K).
        totalTokens: 200_000,
        totalTokensFresh: true,
      }),
    },
  });

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    fork: true,
  });

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain("too large");
  testState.sessionConfig = undefined;
});

test("sessions.create rejects fork while the parent session is active", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parentSessionId = "sess-active-fork-parent";
  await writeSessionStore({ entries: { main: sessionStoreEntry(parentSessionId) } });
  embeddedRunMock.activeIds.add(parentSessionId);
  try {
    const created = await directSessionReq("sessions.create", {
      parentSessionKey: "main",
      fork: true,
    });

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Parent session main is still active; try again in a moment.",
    });
  } finally {
    embeddedRunMock.activeIds.delete(parentSessionId);
    testState.sessionConfig = undefined;
  }
});

test("sessions.create resolves an agent-qualified fork from the parent store", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
  const mainStorePath = storeTemplate.replace("{agentId}", "main");
  const workStorePath = storeTemplate.replace("{agentId}", "work");
  const workDir = path.dirname(workStorePath);
  testState.sessionStorePath = storeTemplate;
  testState.sessionConfig = { scope: "per-sender" };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  try {
    await fs.mkdir(workDir, { recursive: true });
    const parent = await createCheckpointFixture(workDir);
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        main: sessionStoreEntry(parent.sessionId, { sessionFile: parent.sessionFile }),
      },
    });
    await seedSessionTranscript({
      agentId: "work",
      sessionId: parent.sessionId,
      sessionKey: "agent:work:main",
      storePath: workStorePath,
      messages: [
        { role: "user", content: "before compaction" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ],
    });

    const created = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        parentSessionKey?: string;
        sessionFile?: string;
        forkedFromParent?: boolean;
      };
    }>("sessions.create", {
      parentSessionKey: "agent:work:main",
      fork: true,
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:work:main");
    expect(created.payload?.entry?.forkedFromParent).toBe(true);
    const forkedSessionFile = requireNonEmptyString(
      created.payload?.entry?.sessionFile,
      "agent-qualified forked session file",
    );
    await expect(
      loadTranscriptEvents({
        sessionFile: forkedSessionFile,
        sessionId: requireNonEmptyString(
          created.payload?.sessionId,
          "agent-qualified forked session id",
        ),
        sessionKey: created.payload?.key ?? "",
        storePath: mainStorePath,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ content: "before compaction" }),
          type: "message",
        }),
      ]),
    );
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create can start the first agent turn from an initial task", async () => {
  await createSessionStoreDir();
  // Register "ops" so the deleted-agent guard added in #65986 does not
  // reject the auto-started chat.send triggered by `task:`.
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    sessionId?: string;
    runStarted?: boolean;
    runId?: string;
    messageSeq?: number;
  }>(ws, "sessions.create", {
    agentId: "ops",
    label: "Dashboard Chat",
    task: "hello from create",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(created.payload?.runStarted).toBe(true);
  const runId = requireNonEmptyString(created.payload?.runId, "started run id");
  expect(created.payload?.messageSeq).toBe(1);

  const wait = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 1_000 });
  expect(wait.ok).toBe(true);
  expect(wait.payload?.status).toBe("ok");

  ws.close();
});

test("sessions.create rejects replacing its parent key", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-parent-task") } });

  const created = await directSessionReq("sessions.create", {
    key: "main",
    parentSessionKey: "agent:main:main",
    emitCommandHooks: true,
    task: "hello after replacing parent",
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "sessions.create key must differ from parentSessionKey",
  });
});
