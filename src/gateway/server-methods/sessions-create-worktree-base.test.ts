import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { refreshProjectClone } from "../../projects/project-clone.js";
import {
  registerClonedProjectRegistry,
  registerProjectRegistry,
} from "../../projects/project-registry.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import {
  controlUiClient,
  initializeRepository,
  settleWorkspaceRuns,
} from "../server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "../test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const execFileAsync = promisify(execFile);
const projectCloneMocks = vi.hoisted(() => ({ materialize: vi.fn() }));

vi.mock("../../projects/project-clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../projects/project-clone.js")>();
  return { ...actual, materializeProjectClone: projectCloneMocks.materialize };
});

afterEach(() => {
  projectCloneMocks.materialize.mockReset();
  dispatchInboundMessageMock.mockReset();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

test("sessions.create revalidates an unavailable remote base before retrying", async () => {
  const root = tempDirs.make("openclaw-session-invalid-remote-worktree-base-");
  const workspace = await initializeRepository(root, "workspace");
  const publisher = await initializeRepository(root, "publisher");
  const upstream = path.join(root, "upstream.git");
  await execFileAsync("git", ["clone", "--bare", publisher, upstream]);
  const projectRoot = path.join(root, "project");
  await execFileAsync("git", ["clone", "--no-local", upstream, projectRoot]);
  // The registry, not mutable origin configuration, owns the requested repository.
  const unrelated = await initializeRepository(root, "unrelated");
  await execFileAsync("git", ["-C", unrelated, "branch", "missing-remote-base"]);
  await execFileAsync("git", ["-C", projectRoot, "remote", "set-url", "origin", unrelated]);
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const project = await registerClonedProjectRegistry({
    path: projectRoot,
    name: "Project",
    originUrl: upstream,
  });
  projectCloneMocks.materialize.mockResolvedValue(project);
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  const broadcast = vi.fn();
  const context = { broadcast, chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };
  const created = await directSessionReq<{ key: string; runId: string }>(
    "sessions.create",
    {
      agentId: "main",
      message: "Start from the requested remote branch",
      projectGitUrl: "https://github.com/openclaw/openclaw.git",
      worktree: true,
      worktreeBaseRef: "origin/missing-remote-base",
    },
    { ...controlUiClient, context },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const sessionKey = created.payload!.key;

  try {
    await settleWorkspaceRuns(context, storePath, sessionKey);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: created.payload!.runId,
        sessionKey,
        state: "error",
        errorMessage: expect.stringContaining("does not resolve to a commit"),
      }),
      expect.anything(),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey, storePath })?.pendingWorktree,
    ).toMatchObject({ baseRef: "origin/missing-remote-base" });

    await execFileAsync("git", ["-C", publisher, "branch", "missing-remote-base"]);
    await execFileAsync("git", [
      "-C",
      publisher,
      "push",
      upstream,
      "refs/heads/missing-remote-base:refs/heads/missing-remote-base",
    ]);

    const retried = await directSessionReq(
      "chat.send",
      {
        agentId: "main",
        sessionKey,
        message: "Retry after the requested branch is available",
        idempotencyKey: "retry-invalid-remote-base",
      },
      { ...controlUiClient, context },
    );
    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    await settleWorkspaceRuns(context, storePath, sessionKey);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
      "pendingWorktree",
    );
    expect(managedWorktrees.findLiveByOwner("session", sessionKey)?.baseRef).toBe(
      "origin/missing-remote-base",
    );
  } finally {
    await settleWorkspaceRuns(context, storePath, sessionKey, true);
    const owned = managedWorktrees.findLiveByOwner("session", sessionKey);
    if (owned) {
      await managedWorktrees.remove({
        id: owned.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});

test("sessions.create accepts a fresh valid remote base without refreshing the clone", async () => {
  const root = tempDirs.make("openclaw-session-valid-remote-worktree-base-");
  const workspace = await initializeRepository(root, "workspace");
  const publisher = await initializeRepository(root, "publisher");
  const upstream = path.join(root, "upstream.git");
  await execFileAsync("git", ["clone", "--bare", publisher, upstream]);
  const projectRoot = path.join(root, "project");
  await execFileAsync("git", ["clone", "--no-local", upstream, projectRoot]);
  await execFileAsync("git", [
    "-C",
    projectRoot,
    "remote",
    "set-url",
    "origin",
    path.join(root, "unavailable.git"),
  ]);
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const project = await registerClonedProjectRegistry({
    path: projectRoot,
    name: "Project",
    originUrl: "https://github.com/openclaw/openclaw.git",
  });
  projectCloneMocks.materialize.mockResolvedValue(project);
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  const context = {
    broadcast: vi.fn(),
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
  };
  const created = await directSessionReq<{ key: string }>(
    "sessions.create",
    {
      agentId: "main",
      message: "Start from the cloned default branch",
      projectGitUrl: "https://github.com/openclaw/openclaw.git",
      worktree: true,
      worktreeBaseRef: "main",
    },
    { ...controlUiClient, context },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const sessionKey = created.payload!.key;

  try {
    await settleWorkspaceRuns(context, storePath, sessionKey);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(managedWorktrees.findLiveByOwner("session", sessionKey)?.baseRef).toBe("main");
  } finally {
    await settleWorkspaceRuns(context, storePath, sessionKey, true);
    const owned = managedWorktrees.findLiveByOwner("session", sessionKey);
    if (owned) {
      await managedWorktrees.remove({
        id: owned.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});

test("remote retry refresh does not mutate a registered project checkout", async () => {
  const root = tempDirs.make("openclaw-session-registered-project-refresh-");
  const publisher = await initializeRepository(root, "publisher");
  const upstream = path.join(root, "upstream.git");
  await execFileAsync("git", ["clone", "--bare", publisher, upstream]);
  const projectRoot = path.join(root, "project");
  await execFileAsync("git", ["clone", "--no-local", upstream, projectRoot]);
  const project = await registerProjectRegistry({ path: projectRoot, name: "Registered" });

  await execFileAsync("git", ["-C", publisher, "branch", "operator-owned-branch"]);
  await execFileAsync("git", [
    "-C",
    publisher,
    "push",
    upstream,
    "refs/heads/operator-owned-branch:refs/heads/operator-owned-branch",
  ]);
  await refreshProjectClone(project);

  await expect(
    execFileAsync("git", [
      "-C",
      projectRoot,
      "rev-parse",
      "--verify",
      "refs/remotes/origin/operator-owned-branch",
    ]),
  ).rejects.toBeDefined();
});

test("sessions.create rejects an invalid worktree base before persisting the session", async () => {
  const root = tempDirs.make("openclaw-session-invalid-worktree-base-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:invalid-worktree-base";

  const created = await directSessionReq(
    "sessions.create",
    {
      agentId: "main",
      key: sessionKey,
      message: "Start from the requested change",
      worktree: true,
      worktreeBaseRef: "126887",
    },
    controlUiClient,
  );

  expect(created).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("does not resolve to a commit"),
    },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test.each(["local", "remote"] as const)(
  "chat.send keeps an accepted %s base pinned after setup fails and its branch moves",
  async (source) => {
    const root = tempDirs.make("openclaw-session-pinned-worktree-base-");
    const workspace = await initializeRepository(root, "workspace");
    await execFileAsync("git", ["-C", workspace, "branch", "accepted-base"]);
    const acceptedCommit = (
      await execFileAsync("git", ["-C", workspace, "rev-parse", "accepted-base"])
    ).stdout.trim();
    const setup = path.join(workspace, ".openclaw", "worktree-setup.sh");
    await fs.mkdir(path.dirname(setup));
    await fs.writeFile(setup, "#!/bin/sh\nexit 23\n", { mode: 0o755 });
    testState.agentConfig = { workspace };
    const { storePath } = await createSessionStoreDir();
    const gitUrl = "https://github.com/openclaw/openclaw.git";
    if (source === "remote") {
      projectCloneMocks.materialize.mockResolvedValue(
        await registerClonedProjectRegistry({
          path: workspace,
          name: "Pinned",
          originUrl: gitUrl,
        }),
      );
    }
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const context = {
      broadcast: vi.fn(),
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    };
    const options = { client: { connect: { scopes: ["operator.admin"] } } as never, context };
    const created = await directSessionReq<{ key: string }>(
      "sessions.create",
      {
        agentId: "main",
        message: "Start from the selected commit",
        worktree: true,
        worktreeName: "pinned-base",
        worktreeBaseRef: "accepted-base",
        ...(source === "remote" ? { projectGitUrl: gitUrl } : {}),
      },
      options,
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const sessionKey = created.payload!.key;
    try {
      await settleWorkspaceRuns(context, storePath, sessionKey);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        status: "failed",
        lastRunError: expect.stringContaining("23"),
        pendingWorktree: { baseRef: "accepted-base", baseCommit: acceptedCommit },
      });
      expect(managedWorktrees.findLiveByOwner("session", sessionKey)).toBeUndefined();
      await execFileAsync("git", ["-C", workspace, "commit", "--allow-empty", "-m", "move base"]);
      await execFileAsync("git", ["-C", workspace, "branch", "-f", "accepted-base", "HEAD"]);
      await fs.writeFile(setup, "#!/bin/sh\nexit 0\n");
      const sent = await directSessionReq(
        "chat.send",
        {
          agentId: "main",
          sessionKey,
          message: "Retry the accepted worktree",
          idempotencyKey: "retry-pinned-base",
        },
        options,
      );
      expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
      await settleWorkspaceRuns(context, storePath, sessionKey);
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      const worktree = managedWorktrees.findLiveByOwner("session", sessionKey);
      if (!worktree) {
        throw new Error("expected a managed worktree");
      }
      expect(worktree.baseRef).toBe("accepted-base");
      expect(
        (await execFileAsync("git", ["-C", worktree.path, "rev-parse", "HEAD"])).stdout.trim(),
      ).toBe(acceptedCommit);
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "pendingWorktree",
      );
    } finally {
      await settleWorkspaceRuns(context, storePath, sessionKey, true);
      const owned = managedWorktrees.findLiveByOwner("session", sessionKey);
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
