import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { waitForFile } from "../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithCanonicalSkillWorkspace } from "../agents/skill-workshop-workspace-context.js";
import { createConfiguredSkillWorkshopTool } from "../agents/tools/skill-workshop-tool-factory.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "../config/sessions/worktree-workspace-migration.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { withTimeout } from "../infra/fs-safe.js";
import { ProjectCloneError } from "../projects/project-clone-runtime.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import {
  getSessionWorkAdmissionRelease,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { inspectSkillProposal } from "../skills/workshop/service.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
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
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
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

async function settleWorkspaceRuns(
  context: { chatAbortControllers: Map<string, ChatAbortControllerEntry> },
  storePath: string,
  sessionKey: string | undefined,
  abort = false,
): Promise<void> {
  const targets = [...context.chatAbortControllers].map(([runId, entry]) => ({ runId, entry }));
  const released = getSessionWorkAdmissionRelease({
    scope: storePath,
    identities: [sessionKey],
  });
  if (abort) {
    for (const { entry } of targets) {
      entry.controller.abort();
    }
  }
  // Error paths revoke registration before persisting failure; the admission
  // retains custody until all dispatch and title work finishes in this test store.
  expect(
    await waitForChatAbortControllerRemoval({
      entries: context.chatAbortControllers,
      targets,
      timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
    }),
  ).toBe(true);
  if (released) {
    await withTimeout(released, SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS, "workspace run cleanup");
  }
}

test.each([
  { worktree: false, sandboxed: false },
  { worktree: true, sandboxed: false },
  { worktree: false, sandboxed: true },
])(
  "sessions.create admits remote project work (worktree=$worktree, sandboxed=$sandboxed) before materialization and dispatches only after authoritative binding",
  async ({ worktree, sandboxed }) => {
    const root = tempDirs.make("openclaw-session-remote-project-startup-");
    const workspace = await initializeRepository(root, "workspace");
    const projectRoot = await initializeRepository(sandboxed ? workspace : root, "project");
    const alias = path.join(root, "workspace-alias");
    await fs.symlink(workspace, alias, directoryLinkType);
    testState.agentConfig = { workspace: alias, sandbox: { mode: sandboxed ? "all" : "off" } };
    const { storePath } = await createSessionStoreDir();
    const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });
    const materialization = createDeferredCore<typeof project>();
    projectCloneMocks.materialize.mockReturnValueOnce(materialization.promise);
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const broadcast = vi.fn();
    const context = {
      broadcast,
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    };
    const events: AgentEventPayload[] = [];
    const unsubscribe = onAgentEvent((event) => events.push(event));

    let key: string | undefined;
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
          ...(worktree ? { worktree: true, worktreeName: "remote-startup" } : {}),
        },
        { ...controlUiClient, context },
      );

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload).toMatchObject({
        key: expect.any(String),
        runId: expect.any(String),
        runStarted: true,
        sessionId: expect.any(String),
      });
      expect(created.payload?.entry).not.toHaveProperty("pendingProjectGitUrl");
      expect(created.payload?.entry).not.toHaveProperty("pendingWorktree");
      const { runId, sessionId } = created.payload!;
      key = created.payload!.key;
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
      await settleWorkspaceRuns(context, storePath, key);
      const error = broadcast.mock.calls.find(
        ([event, payload]) => event === "chat" && payload.state === "error",
      );
      expect(error?.[1]).toBeUndefined();
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      const prepared = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
      expect(prepared).toMatchObject({
        sessionId,
        projectId: project.id,
        ...(worktree
          ? { worktree: { canonicalWorkspaceDir: projectRoot } }
          : {
              spawnedCwd: projectRoot,
              sessionRoot: projectRoot,
            }),
      });
      if (worktree) {
        expect(prepared?.spawnedCwd).not.toBe(projectRoot);
        expect(await fs.readFile(path.join(prepared!.spawnedCwd!, "README.md"), "utf8")).toBe(
          "project\n",
        );
        await managedWorktrees.remove({
          id: prepared!.worktree!.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    } finally {
      materialization.resolve(project);
      await settleWorkspaceRuns(context, storePath, key, true);
      unsubscribe();
    }
  },
);

test.each([false, true])(
  "chat.abort cancels remote project preparation without late binding or agent dispatch (worktree=%s)",
  async (worktree) => {
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

    let key: string | undefined;
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
          ...(worktree ? { worktree: true, worktreeName: "retry-worktree" } : {}),
        },
        { ...controlUiClient, context },
      );

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.runStarted).toBe(true);
      const { runId, sessionId } = created.payload!;
      key = created.payload!.key;
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
      await settleWorkspaceRuns(context, storePath, key);
      expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
        payload: { runId, summary: "aborted" },
      });
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
      await settleWorkspaceRuns(context, storePath, key, true);
    }
  },
);

test.each([false, true])(
  "sessions.create survives Gateway restart after remote project failure and retries preparation on the same session (worktree=%s)",
  async (worktree) => {
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
        ...(worktree ? { worktree: true, worktreeName: "retry-worktree" } : {}),
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
    await settleWorkspaceRuns(context, storePath, key);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId,
        sessionKey: key,
        state: "error",
        errorMessage: expect.stringContaining(failureMessage),
      }),
      expect.anything(),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId,
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.status).not.toBe(
      "running",
    );
    const entryAfterFailure = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });

    // The first chat pane subscribes only after create-and-navigate. Its history
    // must recover the failure without receiving the already-emitted chat event.
    for (const method of ["chat.startup", "chat.history"] as const) {
      const history = await directSessionReq(method, { sessionKey: key }, controlUiClient);
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      expect(history.payload).toMatchObject({
        sessionInfo: {
          sessionId,
          status: "failed",
          hasActiveRun: false,
          lastRunId: runId,
          lastRunError: expect.stringContaining(failureMessage),
        },
        messages: [expect.objectContaining({ role: "user" })],
      });
    }

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
      expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.lastRunError).toBe(
        undefined,
      );
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
      await settleWorkspaceRuns(restartedContext, storePath, key);
      const error = broadcast.mock.calls.find(
        ([event, payload]) =>
          event === "chat" && payload.runId === "remote-project-retry" && payload.state === "error",
      );
      expect(error?.[1]).toBeUndefined();
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      const preparedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
      expect(preparedEntry).toMatchObject({
        sessionId,
        projectId: project.id,
        ...(worktree
          ? { worktree: { canonicalWorkspaceDir: projectRoot } }
          : { spawnedCwd: projectRoot, sessionRoot: projectRoot }),
      });
      expect(preparedEntry).not.toHaveProperty("pendingProjectGitUrl");
      expect(preparedEntry).not.toHaveProperty("pendingWorktree");
      if (preparedEntry?.worktree) {
        await managedWorktrees.remove({
          id: preparedEntry.worktree.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    } finally {
      retriedMaterialization.resolve(project);
      await settleWorkspaceRuns(restartedContext, storePath, key, true);
    }
  },
);

test("chat.send rechecks setup scope when a write-only caller retries an admin's failed worktree", async () => {
  const root = tempDirs.make("openclaw-session-worktree-retry-scope-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const setup = path.join(workspace, ".openclaw");
  await fs.mkdir(setup);
  const starts = path.join(setup, "starts");
  await fs.writeFile(
    path.join(setup, "worktree-setup.sh"),
    '#!/bin/sh\necho started >> "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/starts"\nexit 1\n',
    { mode: 0o755 },
  );
  const context = {
    broadcast: vi.fn(),
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    dedupe: new Map(),
  };
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  let key: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      runId: string;
      sessionId: string;
      runStarted: boolean;
    }>(
      "sessions.create",
      {
        agentId: "main",
        message: "Start work in the checkout",
        worktree: true,
        worktreeName: "setup-scope-retry",
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never, context },
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.runStarted).toBe(true);
    key = created.payload!.key;
    await waitForFile(starts, SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
    await settleWorkspaceRuns(context, storePath, key);
    expect(context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: created.payload!.runId,
        state: "error",
        errorMessage: expect.stringContaining("worktree setup failed"),
      }),
      expect.anything(),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

    const retried = await directSessionReq(
      "chat.send",
      {
        agentId: "main",
        sessionKey: key,
        message: "Continue without repository setup",
        idempotencyKey: "write-only-setup-retry",
      },
      { ...controlUiClient, context },
    );
    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    await settleWorkspaceRuns(context, storePath, key);
    expect(await fs.readFile(starts, "utf8")).toBe("started\n");
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(entry).toMatchObject({
      sessionId: created.payload!.sessionId,
      worktree: { canonicalWorkspaceDir: workspace },
    });
    expect(entry).not.toHaveProperty("pendingWorktree");
  } finally {
    await settleWorkspaceRuns(context, storePath, key, true);
    const owned = key ? managedWorktrees.findLiveByOwner("session", key) : undefined;
    if (owned) {
      await managedWorktrees.remove({
        id: owned.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});

test.each([false, true])(
  "concurrent sends retain one bound worktree after deferred setup (abort first=%s)",
  async (abortFirst) => {
    const root = tempDirs.make("openclaw-session-worktree-concurrent-");
    const workspace = await initializeRepository(root, "workspace");
    testState.agentConfig = { workspace };
    const { storePath } = await createSessionStoreDir();
    const setup = path.join(workspace, ".openclaw");
    await fs.mkdir(setup);
    const firstStarted = path.join(setup, "first-started");
    const secondStarted = path.join(setup, "second-started");
    const starts = path.join(setup, "starts");
    const release = path.join(setup, "release");
    await fs.writeFile(
      path.join(setup, "worktree-setup.sh"),
      '#!/bin/sh\necho started >> "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/starts"\nif [ -f "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/first-started" ]; then touch "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/second-started"; else touch "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/first-started"; fi\nwhile [ ! -f "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/release" ]; do sleep 0.05; done\n',
      { mode: 0o755 },
    );
    const context = {
      broadcast: vi.fn(),
      chatAbortControllers: new Map(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
    };
    const options = { client: { connect: { scopes: ["operator.admin"] } } as never, context };
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    let key: string | undefined;
    try {
      const created = await directSessionReq<{ key: string; runId: string; runStarted: boolean }>(
        "sessions.create",
        {
          agentId: "main",
          message: "Start during setup",
          worktree: true,
          label: "Concurrent setup",
        },
        options,
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.runStarted).toBe(true);
      key = created.payload!.key;
      await waitForFile(firstStarted, SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
      expect(await fs.readFile(starts, "utf8")).toBe("started\n");
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.pendingWorktree,
      ).toBeDefined();
      const sent = await directSessionReq(
        "chat.send",
        {
          agentId: "main",
          sessionKey: key,
          message: "Continue after setup",
          idempotencyKey: "second-worktree-send",
        },
        options,
      );
      expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
      if (abortFirst) {
        const aborted = await directSessionReq(
          "chat.abort",
          { sessionKey: key, runId: created.payload!.runId },
          options,
        );
        expect(aborted.ok, JSON.stringify(aborted.error)).toBe(true);
        await waitForFile(secondStarted, SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
        expect(await fs.readFile(starts, "utf8")).toBe("started\nstarted\n");
      }
      await fs.writeFile(release, "ready\n");
      await settleWorkspaceRuns(context, storePath, key);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(abortFirst ? 1 : 2);
      const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
      expect(entry).not.toHaveProperty("pendingWorktree");
      expect(entry?.worktree?.canonicalWorkspaceDir).toBe(workspace);
      const owned = managedWorktrees.findLiveByOwner("session", key!);
      expect(owned?.id).toBe(entry?.worktree?.id);
      await expect(fs.readFile(path.join(entry!.spawnedCwd!, "README.md"), "utf8")).resolves.toBe(
        "workspace\n",
      );
      expect(
        context.broadcast.mock.calls.filter(
          ([event, payload]) => event === "chat" && payload.state === "error",
        ),
      ).toEqual([]);
    } finally {
      await fs.writeFile(release, "release setup\n");
      await settleWorkspaceRuns(context, storePath, key, true);
      const owned = key ? managedWorktrees.findLiveByOwner("session", key) : undefined;
      if (owned) {
        await managedWorktrees.remove({
          id: owned.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    }
  },
);

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
  const context = { broadcast, chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };

  const sent = await directSessionReq(
    "chat.send",
    {
      agentId: "main",
      sessionKey,
      message: "Do not use the default workspace",
      idempotencyKey: "corrupt-project-intent",
    },
    { ...controlUiClient, context },
  );

  expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
  await settleWorkspaceRuns(context, storePath, sessionKey);
  expect(broadcast).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({
      runId: "corrupt-project-intent",
      sessionKey,
      state: "error",
      errorMessage: expect.stringContaining("Saved project repository is invalid"),
    }),
    expect.anything(),
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
  const context = { broadcast, chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };

  let key: string | undefined;
  try {
    const created = await directSessionReq<{ key: string; runId: string; runStarted: boolean }>(
      "sessions.create",
      {
        agentId: "main",
        message: "Inspect the sandboxed project",
        projectGitUrl: "https://github.com/openclaw/openclaw.git",
      },
      { ...controlUiClient, context },
    );

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.runStarted).toBe(true);
    const { runId } = created.payload!;
    key = created.payload!.key;
    await vi.waitFor(() => expect(projectCloneMocks.materialize).toHaveBeenCalledOnce());
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

    materialization.resolve(project);
    await settleWorkspaceRuns(context, storePath, key);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId,
        sessionKey: key,
        state: "error",
        errorMessage: expect.stringContaining(
          "sessions.create project is outside the sandboxed agent workspace",
        ),
      }),
      expect.anything(),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.projectId).toBe(
      undefined,
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.status).not.toBe(
      "running",
    );
  } finally {
    materialization.resolve(project);
    await settleWorkspaceRuns(context, storePath, key, true);
  }
});

test.each(["workspace", "registered"])(
  "sessions.create starts in a sandboxed %s project through a workspace alias",
  async (kind) => {
    const root = tempDirs.make("openclaw-session-workspace-project-");
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    await fs.mkdir(workspace);
    await fs.symlink(workspace, alias, directoryLinkType);
    testState.agentConfig = { workspace: alias, sandbox: { mode: "all" } };
    const { storePath } = await createSessionStoreDir();
    const projectRoot =
      kind === "workspace" ? workspace : await initializeRepository(workspace, "project");
    const projectId =
      kind === "workspace"
        ? "workspace:main"
        : (await registerProjectRegistry({ path: projectRoot })).id;

    const created = await directSessionReq<{
      key: string;
      entry?: { sessionRoot?: string; spawnedCwd?: string };
    }>(
      "sessions.create",
      { agentId: "main", projectId },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry).toMatchObject({
      sessionRoot: projectRoot,
      spawnedCwd: projectRoot,
    });
    expect(loadSessionEntry({ sessionKey: created.payload!.key, storePath })).toMatchObject({
      sessionRoot: projectRoot,
      spawnedCwd: projectRoot,
    });
  },
);

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
  let sessionKey: string | undefined;
  const context = { chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };
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
    sessionKey = created.payload?.key ?? "";
    dispatchInboundMessageMock.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const reused = await directSessionReq<{ worktree?: { id: string }; runStarted: boolean }>(
      "sessions.create",
      {
        key: sessionKey,
        agentId: "main",
        projectId: project.id,
        worktree: true,
        message: "Continue in this checkout",
      },
      { ...controlUiClient, context },
    );
    expect(reused.ok, JSON.stringify(reused.error)).toBe(true);
    expect(reused.payload).toMatchObject({ worktree: { id: worktreeId }, runStarted: true });
    await settleWorkspaceRuns(context, storePath, sessionKey);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
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
    await settleWorkspaceRuns(context, storePath, sessionKey, true);
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
