import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";
import { controlUiClient } from "./server.sessions.create.projects.test-support.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  projectCloneMocks.materialize.mockReset();
  dispatchInboundMessageMock.mockReset();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

test("sessions.create retains a cloud repository across replay without creating a Gateway checkout", async () => {
  const root = tempDirs.make("openclaw-session-cloud-repository-");
  const workspace = path.join(root, "must-not-be-created");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const repository = { url: "git@github.com:OpenClaw/OpenClaw.git", ref: "release/next" };
  const created = await directSessionReq<{
    key: string;
    entry: { repositoryWorkspaceId: string };
  }>("sessions.create", { agentId: "main", repository }, controlUiClient);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const { key, entry } = created.payload!;
  expect(entry.repositoryWorkspaceId).toEqual(expect.any(String));
  expect(created.payload).not.toHaveProperty("worktree");
  const saved = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(saved).toMatchObject({ repositoryWorkspaceId: entry.repositoryWorkspaceId });
  for (const field of [
    "worktree",
    "projectId",
    "pendingProjectGitUrl",
    "pendingWorktree",
    "spawnedCwd",
    "sessionRoot",
    "sessionDiffBaselineCapture",
  ]) {
    expect(saved).not.toHaveProperty(field);
  }
  closeOpenClawStateDatabaseForTest();
  const replay = await directSessionReq<{ entry: { repositoryWorkspaceId: string } }>(
    "sessions.create",
    { agentId: "main", key, repository },
    controlUiClient,
  );
  expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
  expect(replay.payload?.entry.repositoryWorkspaceId).toBe(entry.repositoryWorkspaceId);
  const listed = await directSessionReq<{
    sessions: Array<{
      key: string;
      repositoryWorkspaceId?: string;
      repository?: { url: string; ref?: string; branch: string };
    }>;
  }>("sessions.list", { agentId: "main", limit: 100 }, controlUiClient);
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  expect(listed.payload?.sessions.find((row) => row.key === key)).toMatchObject({
    repositoryWorkspaceId: entry.repositoryWorkspaceId,
    repository: {
      url: "https://github.com/openclaw/openclaw.git",
      ref: "release/next",
      branch: expect.stringMatching(/^openclaw\//u),
    },
  });
  const gitOutput = vi.fn().mockResolvedValue("unrelated-gateway-branch");
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([]));
  const cacheLifetime = new AbortController();
  onTestFinished(() => cacheLifetime.abort());
  const params = { sessionKey: key, agentId: "main" };
  await loadControlUiSessionPullRequests(params, {
    cacheSignal: cacheLifetime.signal,
    fetchImpl,
    resolveGitRoot: async () => workspace,
    gitOutput: async (_root, args) =>
      args[0] === "rev-parse"
        ? "previous-local-branch"
        : args[0] === "remote"
          ? "https://github.com/openclaw/openclaw.git"
          : "origin/main",
    resolveBranchLanding: async () => ({
      pushedSha: null,
      statsBase: null,
      hasLandedPullRequest: false,
      provenNewPushedWork: false,
    }),
  });
  expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(3);
  const preview = await loadControlUiSessionPullRequests(params, {
    cacheSignal: cacheLifetime.signal,
    gitOutput,
    fetchImpl,
  });
  expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(1);
  expect(preview.branch).toMatchObject({
    owner: "openclaw",
    repo: "openclaw",
    branch: `openclaw/${entry.repositoryWorkspaceId}`,
  });
  expect(gitOutput).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalled();
  cacheLifetime.abort();
  expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(0);
  for (const changedSource of [
    undefined,
    { ...repository, ref: "main" },
    { url: "https://github.com/octocat/hello-world.git" },
  ]) {
    const changed = await directSessionReq(
      "sessions.create",
      { agentId: "main", key, ...(changedSource ? { repository: changedSource } : {}) },
      controlUiClient,
    );
    expect(changed).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  }
  expect(await fs.stat(workspace).catch(() => undefined)).toBeUndefined();
  expect(projectCloneMocks.materialize).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test.each([
  { repository: { url: "file:///tmp/repository" } },
  { repository: { url: "https://token@github.com/openclaw/openclaw.git" } },
  {
    repository: { url: "https://github.com/openclaw/openclaw.git", ref: "--upload-pack=anything" },
  },
  { cwd: "/tmp/repository" },
  { execNode: "device" },
  { projectId: "workspace:main" },
  { projectGitUrl: "https://github.com/openclaw/openclaw.git" },
  { worktree: true },
  { worktreeBaseRef: "main" },
  { message: "Start before dispatch" },
])(
  "sessions.create rejects conflicting cloud repository input before admission: %j",
  async (options) => {
    await createSessionStoreDir();
    const created = await directSessionReq(
      "sessions.create",
      {
        agentId: "main",
        repository: { url: "https://github.com/openclaw/openclaw.git" },
        ...options,
      },
      controlUiClient,
    );
    expect(created).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(projectCloneMocks.materialize).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  },
);
