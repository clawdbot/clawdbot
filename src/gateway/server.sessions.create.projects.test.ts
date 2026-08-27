import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithCanonicalSkillWorkspace } from "../agents/skill-workshop-workspace-context.js";
import { createConfiguredSkillWorkshopTool } from "../agents/tools/skill-workshop-tool-factory.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "../config/sessions/worktree-workspace-migration.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { ProjectCloneError } from "../projects/project-clone-runtime.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { inspectSkillProposal } from "../skills/workshop/service.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const projectCloneMocks = vi.hoisted(() => ({ materialize: vi.fn() }));

vi.mock("../projects/project-clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../projects/project-clone.js")>();
  return { ...actual, materializeProjectClone: projectCloneMocks.materialize };
});

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const controlUiClient = {
  client: {
    connect: {
      scopes: ["operator.write"],
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "dev",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    },
  } as never,
};

afterEach(() => {
  projectCloneMocks.materialize.mockReset();
  dispatchInboundMessageMock.mockReset();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

async function initializeRepository(root: string, name: string): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await fs.writeFile(path.join(repo, "README.md"), `${name}\n`);
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  return await fs.realpath(repo);
}

test("sessions.create admits remote project work before materialization and dispatches only after authoritative binding", async () => {
  const root = tempDirs.make("openclaw-session-remote-project-startup-");
  const workspace = await initializeRepository(root, "workspace");
  const projectRoot = await initializeRepository(root, "project");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });
  const materialization = createDeferredCore<typeof project>();
  projectCloneMocks.materialize.mockReturnValueOnce(materialization.promise);
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  const broadcast = vi.fn();
  const events: AgentEventPayload[] = [];
  const unsubscribe = onAgentEvent((event) => events.push(event));

  try {
    const created = await directSessionReq<{
      entry: { sessionId: string };
      key: string;
      runId: string;
      runStarted: boolean;
      sessionId: string;
    }>(
      "sessions.create",
      {
        agentId: "main",
        message: "Inspect the remote project",
        projectGitUrl: "git@github.com:OpenClaw/OpenClaw.git",
      },
      { ...controlUiClient, context: { broadcast } },
    );

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload).toMatchObject({
      key: expect.any(String),
      runId: expect.any(String),
      runStarted: true,
      sessionId: expect.any(String),
    });
    expect(created.payload?.entry).not.toHaveProperty("pendingProjectGitUrl");
    const { key, runId, sessionId } = created.payload!;
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId,
      pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
    });
    await vi.waitFor(() => expect(projectCloneMocks.materialize).toHaveBeenCalledOnce());
    expect(projectCloneMocks.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ gitUrl: "https://github.com/openclaw/openclaw.git" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        runId,
        stream: "run_status",
        data: expect.objectContaining({ phase: "preparing_workspace" }),
      }),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

    materialization.resolve(project);

    await vi.waitFor(() => {
      const error = broadcast.mock.calls.find(
        ([event, payload]) => event === "chat" && payload.state === "error",
      );
      expect(error?.[1]).toBeUndefined();
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId,
      projectId: project.id,
      spawnedCwd: projectRoot,
      sessionRoot: projectRoot,
    });
  } finally {
    materialization.resolve(project);
    unsubscribe();
  }
});

test("chat.abort cancels remote project preparation without late binding or agent dispatch", async () => {
  const root = tempDirs.make("openclaw-session-remote-project-abort-");
  const workspace = await initializeRepository(root, "workspace");
  const projectRoot = await initializeRepository(root, "project");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });
  const materialization = createDeferredCore<typeof project>();
  projectCloneMocks.materialize.mockReturnValueOnce(materialization.promise);
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  const broadcast = vi.fn();
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const context = {
    broadcast,
    chatAbortControllers,
    chatRunState: createChatRunState(),
    dedupe: new Map(),
  };

  try {
    const created = await directSessionReq<{
      key: string;
      runId: string;
      runStarted: boolean;
      sessionId: string;
    }>(
      "sessions.create",
      {
        agentId: "main",
        message: "Cancel the remote project",
        projectGitUrl: "https://github.com/openclaw/openclaw.git",
      },
      { ...controlUiClient, context },
    );

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.runStarted).toBe(true);
    const { key, runId, sessionId } = created.payload!;
    await vi.waitFor(() => expect(projectCloneMocks.materialize).toHaveBeenCalledOnce());
    const signal = chatAbortControllers.get(runId)?.controller.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(projectCloneMocks.materialize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal }),
    );
    expect(signal?.aborted).toBe(false);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

    const aborted = await directSessionReq<{ aborted: boolean; runIds: string[] }>(
      "chat.abort",
      { agentId: "main", sessionKey: key, runId },
      { ...controlUiClient, context },
    );

    expect(aborted.ok, JSON.stringify(aborted.error)).toBe(true);
    expect(aborted.payload).toMatchObject({ aborted: true, runIds: [runId] });
    expect(signal?.aborted).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId, sessionKey: key, state: "aborted" }),
      expect.anything(),
    );

    materialization.resolve(project);

    await vi.waitFor(() =>
      expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
        payload: { runId, summary: "aborted" },
      }),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId,
      pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.projectId).toBe(
      undefined,
    );
    expect(context.chatRunState.runs.get(runId)?.abortMarker).toBeDefined();
  } finally {
    materialization.resolve(project);
  }
});

test("sessions.create survives Gateway restart after remote project failure and retries preparation on the same session", async () => {
  const root = tempDirs.make("openclaw-session-remote-project-failure-");
  const workspace = await initializeRepository(root, "workspace");
  const projectRoot = await initializeRepository(root, "project");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });
  const materialization = createDeferredCore<never>();
  projectCloneMocks.materialize.mockReturnValueOnce(materialization.promise);
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  const broadcast = vi.fn();
  const context = { broadcast, chatAbortControllers: new Map(), dedupe: new Map() };

  const created = await directSessionReq<{
    key: string;
    runId: string;
    runStarted: boolean;
    sessionId: string;
  }>(
    "sessions.create",
    {
      agentId: "main",
      message: "Inspect the unavailable project",
      projectGitUrl: "https://github.com/openclaw/openclaw.git",
    },
    { ...controlUiClient, context },
  );

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload).toMatchObject({ runStarted: true, runId: expect.any(String) });
  const { key, runId, sessionId } = created.payload!;
  const entryAfterCreation = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  const failureMessage =
    "Git clone could not reach GitHub. Check the Gateway network connection and retry.";
  materialization.reject(new ProjectCloneError("network", failureMessage));

  await vi.waitFor(() =>
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId,
        sessionKey: key,
        state: "error",
        errorMessage: expect.stringContaining(failureMessage),
      }),
      expect.anything(),
    ),
  );
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
    sessionId,
  });
  await vi.waitFor(() =>
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.status).not.toBe(
      "running",
    ),
  );
  const entryAfterFailure = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });

  const retriedMaterialization = createDeferredCore<typeof project>();
  projectCloneMocks.materialize.mockReturnValueOnce(retriedMaterialization.promise);
  const restartedContext = { broadcast, chatAbortControllers: new Map(), dedupe: new Map() };

  try {
    const retried = await directSessionReq<{ runId: string; status: string }>(
      "chat.send",
      {
        sessionKey: key,
        agentId: "main",
        message: "Retry the remote project",
        idempotencyKey: "remote-project-retry",
      },
      { ...controlUiClient, context: restartedContext },
    );

    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    expect(retried.payload).toMatchObject({
      runId: "remote-project-retry",
      status: "started",
    });
    await vi.waitFor(() => expect(projectCloneMocks.materialize).toHaveBeenCalledTimes(2));
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(entryAfterCreation).toMatchObject({
      sessionId,
      pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
    });
    expect(entryAfterFailure).toMatchObject({
      sessionId,
      pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId,
      pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
    });

    retriedMaterialization.resolve(project);

    await vi.waitFor(() => {
      const error = broadcast.mock.calls.find(
        ([event, payload]) =>
          event === "chat" && payload.runId === "remote-project-retry" && payload.state === "error",
      );
      expect(error?.[1]).toBeUndefined();
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    });
    const preparedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(preparedEntry).toMatchObject({
      sessionId,
      projectId: project.id,
      spawnedCwd: projectRoot,
      sessionRoot: projectRoot,
    });
    expect(preparedEntry).not.toHaveProperty("pendingProjectGitUrl");
  } finally {
    retriedMaterialization.resolve(project);
  }
});

test("sessions.create rejects conflicting, unsupported, and invalid remote project preparation before admission", async () => {
  const root = tempDirs.make("openclaw-session-remote-project-invalid-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const validRemote = "https://github.com/openclaw/openclaw.git";
  const existing = await directSessionReq<{ key: string }>(
    "sessions.create",
    { agentId: "main", key: "agent:main:existing-project-session" },
    controlUiClient,
  );
  expect(existing.ok, JSON.stringify(existing.error)).toBe(true);

  for (const params of [
    { message: "Start", projectGitUrl: validRemote, projectId: "workspace:main" },
    { message: "Start", projectGitUrl: validRemote, cwd: workspace },
    { message: "Start", projectGitUrl: validRemote, worktree: true },
    { projectGitUrl: validRemote },
    { message: "Start", projectGitUrl: "   " },
    { message: "Start", projectGitUrl: "file:///tmp/untrusted-project" },
    { message: "Start", projectGitUrl: "https://token@github.com/openclaw/openclaw.git" },
    { key: existing.payload?.key, message: "Start", projectGitUrl: validRemote },
  ]) {
    const created = await directSessionReq(
      "sessions.create",
      { agentId: "main", ...params },
      controlUiClient,
    );
    expect(created, JSON.stringify(params)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  }

  expect(projectCloneMocks.materialize).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test("chat.send visibly rejects corrupt persisted project intent without default-workspace dispatch", async () => {
  const root = tempDirs.make("openclaw-session-remote-project-corrupt-");
  testState.agentConfig = { workspace: await initializeRepository(root, "workspace") };
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq<{ key: string }>(
    "sessions.create",
    { agentId: "main", key: "agent:main:corrupt-project-session" },
    controlUiClient,
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const sessionKey = created.payload!.key;
  const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
  expect(entry).toBeDefined();
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    { ...entry!, pendingProjectGitUrl: "https://token@github.com/openclaw/openclaw.git" },
  );
  const broadcast = vi.fn();

  const sent = await directSessionReq(
    "chat.send",
    {
      agentId: "main",
      sessionKey,
      message: "Do not use the default workspace",
      idempotencyKey: "corrupt-project-intent",
    },
    { ...controlUiClient, context: { broadcast } },
  );

  expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
  await vi.waitFor(() =>
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "corrupt-project-intent",
        sessionKey,
        state: "error",
        errorMessage: expect.stringContaining("Saved project repository is invalid"),
      }),
      expect.anything(),
    ),
  );
  expect(projectCloneMocks.materialize).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test("sessions.create terminalizes remote project preparation outside a sandboxed agent workspace", async () => {
  const root = tempDirs.make("openclaw-session-remote-project-sandbox-");
  const workspace = await initializeRepository(root, "workspace");
  const outside = await initializeRepository(root, "outside");
  testState.agentConfig = { workspace, sandbox: { mode: "all" } };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: outside, name: "Outside" });
  const materialization = createDeferredCore<typeof project>();
  projectCloneMocks.materialize.mockReturnValueOnce(materialization.promise);
  const broadcast = vi.fn();

  try {
    const created = await directSessionReq<{ key: string; runId: string; runStarted: boolean }>(
      "sessions.create",
      {
        agentId: "main",
        message: "Inspect the sandboxed project",
        projectGitUrl: "https://github.com/openclaw/openclaw.git",
      },
      { ...controlUiClient, context: { broadcast } },
    );

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.runStarted).toBe(true);
    const { key, runId } = created.payload!;
    await vi.waitFor(() => expect(projectCloneMocks.materialize).toHaveBeenCalledOnce());
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

    materialization.resolve(project);

    await vi.waitFor(() =>
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId,
          sessionKey: key,
          state: "error",
          errorMessage: expect.stringMatching(/outside the sandboxed agent workspace/u),
        }),
        expect.anything(),
      ),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.projectId).toBe(
      undefined,
    );
    await vi.waitFor(() =>
      expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.status).not.toBe(
        "running",
      ),
    );
  } finally {
    materialization.resolve(project);
  }
});

test("sessions.create starts directly in a synthesized non-Git workspace project", async () => {
  const root = tempDirs.make("openclaw-session-workspace-project-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  testState.agentConfig = { workspace };
  await createSessionStoreDir();

  const created = await directSessionReq<{ entry?: { spawnedCwd?: string } }>(
    "sessions.create",
    { agentId: "main", projectId: "workspace:main" },
    { client: { connect: { scopes: ["operator.write"] } } as never },
  );

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.spawnedCwd).toBe(workspace);
});

test("sessions.create starts directly in an outside registered project at write scope", async () => {
  const root = tempDirs.make("openclaw-session-direct-project-");
  const workspace = await initializeRepository(root, "workspace");
  const projectRoot = await initializeRepository(root, "project");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });

  const created = await directSessionReq<{
    key?: string;
    entry?: { projectId?: string; spawnedCwd?: string };
  }>(
    "sessions.create",
    { agentId: "main", projectId: project.id },
    { client: { connect: { scopes: ["operator.write"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.spawnedCwd).toBe(projectRoot);
  expect(created.payload?.entry?.projectId).toBe(project.id);
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: created.payload?.key ?? "",
      storePath,
    })?.projectId,
  ).toBe(project.id);
});

test("sessions.create provisions a managed worktree from a registered project at write scope", async () => {
  const root = tempDirs.make("openclaw-session-registered-project-");
  const workspace = await initializeRepository(root, "workspace");
  const projectRoot = await initializeRepository(root, "project");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key?: string;
      entry?: {
        spawnedCwd?: string;
        worktree?: {
          id: string;
          branch: string;
          repoRoot: string;
          canonicalWorkspaceDir?: string;
        };
      };
      worktree?: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", projectId: project.id, worktree: true },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );

    expect(created.ok).toBe(true);
    worktreeId = created.payload?.worktree?.id;
    expect(created.payload?.entry?.spawnedCwd).toBe(created.payload?.worktree?.path);
    expect(created.payload?.entry?.worktree?.canonicalWorkspaceDir).toBe(projectRoot);
    const sessionKey = created.payload?.key ?? "";
    const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    if (!entry?.worktree) {
      throw new Error("expected persisted project worktree session");
    }
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        ...entry,
        worktree: {
          id: entry.worktree.id,
          branch: entry.worktree.branch,
          repoRoot: entry.worktree.repoRoot,
        },
      },
    );
    await migrateManagedWorktreeCanonicalWorkspaces({
      agentId: "main",
      cfg: getRuntimeConfig(),
      storePath,
    });
    const migrated = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    const canonicalWorkspaceDir = migrated?.worktree?.canonicalWorkspaceDir;
    const spawnedCwd = migrated?.spawnedCwd;
    if (!canonicalWorkspaceDir || !spawnedCwd) {
      throw new Error("expected migrated project worktree session");
    }
    expect(canonicalWorkspaceDir).toBe(projectRoot);
    const proposal = await runWithCanonicalSkillWorkspace(canonicalWorkspaceDir, async () => {
      const tool = createConfiguredSkillWorkshopTool({
        workspaceDir: spawnedCwd,
        config: getRuntimeConfig(),
        agentId: "main",
        sessionKey,
      });
      return await tool.execute("legacy-project-proposal", {
        action: "create",
        name: "legacy-project-learning",
        description: "Preserve learning from a resumed project worktree.",
        proposal_content: "# Legacy Project Learning\n\nPersist this in the project workspace.\n",
      });
    });
    const proposalDetails = proposal.details as { id: string };
    const inspected = await inspectSkillProposal(proposalDetails.id, {
      agentId: "main",
      workspaceDir: projectRoot,
    });
    expect(inspected?.record.target.skillFile).toBe(
      path.join(projectRoot, "skills", "legacy-project-learning", "SKILL.md"),
    );
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});

test("sessions.create rejects projectId combined with raw placement params", async () => {
  for (const params of [
    { projectId: "workspace:main", cwd: "/tmp/repo" },
    { projectId: "workspace:main", execNode: "macbook" },
  ]) {
    const created = await directSessionReq("sessions.create", params);
    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create projectId cannot be combined with cwd or execNode",
      },
    });
  }
});

test("sessions.create returns a typed error for an unknown project", async () => {
  const created = await directSessionReq("sessions.create", { projectId: "missing" });
  expect(created).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "unknown project id: missing" },
  });
});

test.each(["missing", "non-directory"] as const)(
  "sessions.create reports an unavailable %s registered project with truthful recovery guidance",
  async (state) => {
    const root = tempDirs.make("openclaw-session-stale-project-");
    const repo = await initializeRepository(root, "project");
    const project = await registerProjectRegistry({ path: repo });
    await fs.rm(repo, { recursive: true, force: true });
    if (state === "non-directory") {
      await fs.writeFile(repo, "not a directory\n");
    }

    const created = await directSessionReq("sessions.create", { projectId: project.id });
    expect(created.ok).toBe(false);
    expect(created.error?.code).toBe("UNAVAILABLE");
    expect(created.error?.message).toMatch(
      /; update the agent workspace path or re-register the project$/u,
    );
  },
);

test("sessions.create rejects an outside project for a sandboxed agent", async () => {
  const root = tempDirs.make("openclaw-session-sandbox-project-");
  const workspace = await initializeRepository(root, "workspace");
  const outside = await initializeRepository(root, "outside");
  testState.agentConfig = { workspace, sandbox: { mode: "all" } };
  await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: outside });

  for (const worktree of [false, true]) {
    const created = await directSessionReq("sessions.create", {
      projectId: project.id,
      ...(worktree ? { worktree: true } : {}),
    });
    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create project is outside the sandboxed agent workspace",
      },
    });
  }
});
