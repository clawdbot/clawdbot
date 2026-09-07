import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { insertGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createGitHubPublicationRuntime as createRuntime } from "./github-publication-runtime.js";
import { createGitHubPublicationCoordinator as createCoordinator } from "./github-publication.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = vi.hoisted(() => ({
  matchesIdentity: vi.fn(),
  prepareIdentity: vi.fn(),
  runCommand: vi.fn(),
  findWorktree: vi.fn(),
  findWorktreeById: vi.fn(),
  resolveRepository: vi.fn(),
  loadSession: vi.fn(),
  getConfigSnapshot: vi.fn(),
  attribution: vi.fn(),
  updateIndex: vi.fn(),
  refreshIdentity: vi.fn(),
}));

export function githubPublicationTestMocks() {
  return mocks;
}

vi.mock("../agents/github-tool-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/github-tool-identity.js")>();
  return {
    ...actual,
    matchesPreparedGitHubPublicationIdentity: mocks.matchesIdentity,
    prepareGitHubPublicationIdentity: mocks.prepareIdentity,
  };
});

vi.mock("./github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: mocks.refreshIdentity,
  requestCurrentPersonalGitHubRefresh: mocks.refreshIdentity,
}));

// Git transport is synthetic in this harness; keep real SQLite lease exclusion.
vi.mock("../agents/worktrees/git-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/git-lock.js")>()),
  lockWorktreeForProcess: vi.fn(async () => undefined),
  unlockWorktree: vi.fn(async () => undefined),
}));

vi.mock("../agents/git-coauthor-attribution.js", () => ({
  resolveGitCoauthorAttribution: mocks.attribution,
}));

vi.mock("../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    findLiveByOwner: mocks.findWorktree,
    findLiveById: mocks.findWorktreeById,
    resolveRepositoryIdentity: mocks.resolveRepository,
  },
}));

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadGatewaySessionEntryReadOnly: mocks.loadSession,
}));

vi.mock("../process/exec.js", () => ({
  runCommandBuffered: mocks.runCommand,
}));

vi.mock("../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: mocks.getConfigSnapshot,
}));

vi.mock("./github-publication-git-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-publication-git-index.js")>()),
  updateGitHubPublicationBranchAndIndex: mocks.updateIndex,
}));

export function createTestGitHubPublicationRuntime(...args: Parameters<typeof createRuntime>) {
  return createRuntime(...args);
}

export function createTestGitHubPublicationCoordinator(
  ...args: Parameters<typeof createCoordinator>
) {
  return createCoordinator(...args);
}

export const SESSION_KEY = "agent:main:dashboard:publication";
export const SESSION_ID = "session-publication";
export const BRANCH = "openclaw/publication";
export const BASE_HEAD = "a".repeat(40);
export const OLD_HEAD = "b".repeat(40);
export const NEW_HEAD = "c".repeat(40);
export const WORKSPACE_TREE = "d".repeat(40);
const BASE_TREE = "e".repeat(40);

export function commandResult(stdout = "", code = 0) {
  return {
    code,
    signal: null,
    killed: false,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
}

export function seedLocalPublication(
  database: OpenClawStateDatabase,
  params: {
    requestId: string;
    status: "requested" | "publishing";
    repositoryFingerprint?: string;
    headCommit?: string;
  },
): void {
  database.db
    .prepare(
      `INSERT INTO github_publication_requests (
        request_id, idempotency_key, request_digest, session_id, session_key, agent_id,
        worktree_id, repository_fingerprint, claim_id, run_id, environment_id, owner_epoch,
        placement_generation, identity_source, identity_profile_id, identity_account_id,
        identity_login, title, body, status, gateway_instance_id, repository, branch,
        base_branch, source_head_commit, source_index_tree, workspace_tree, head_commit,
        pull_request_url,
        error_code, next_action, created_at_ms, updated_at_ms, reported_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
    )
    .run(
      params.requestId,
      `idempotency-${params.requestId}`,
      `digest-${params.requestId}`,
      SESSION_ID,
      SESSION_KEY,
      "main",
      "worktree-1",
      params.repositoryFingerprint ?? "fingerprint-1",
      "system-configured",
      "ghp_11111111111111111111111111111111",
      42,
      "roboclaw-bot",
      "Resume the publication",
      "Recovered after Gateway restart.",
      params.status,
      "previous-gateway-instance",
      "openclaw/openclaw",
      BRANCH,
      "main",
      OLD_HEAD,
      WORKSPACE_TREE,
      WORKSPACE_TREE,
      params.headCommit ?? NEW_HEAD,
      1_000,
      1_001,
    );
  insertGitHubPublicationSessionLifecycle(database.db, {
    publicationKind: "shared",
    requestId: params.requestId,
    lifecycleRevision: mocks.loadSession(SESSION_KEY).entry.lifecycleRevision ?? null,
  });
}

export function publicationTranscriptMessages(events: unknown[], requestId: string) {
  return events.filter(
    (event) =>
      isRecord(event) &&
      event.type === "message" &&
      isRecord(event.message) &&
      event.message.role === "assistant" &&
      event.message.responseId === `github-publication:${requestId}`,
  );
}

export let root: string;
export let commands: string[][];
export let commandCalls: Array<{ argv: string[]; input?: string }>;

/** Publish and reset the same real SQLite owner while transport faults stay synthetic. */
export async function persistPublicationTestSession(sessionKey = SESSION_KEY) {
  setRuntimeConfigSnapshot({
    agents: { list: [{ id: "main", default: true, workspace: path.join(root, "workspace") }] },
    session: { store: path.join(root, "sessions.json") },
  });
  const { loadGatewaySessionEntryReadOnly } =
    await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  const original = mocks.loadSession.getMockImplementation()!;
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath: path.join(root, "sessions.json") },
    { ...original(sessionKey).entry, updatedAt: Date.now(), lifecycleRevision: randomUUID() },
  );
  mocks.loadSession.mockImplementation(
    (key: string, options: Parameters<typeof loadGatewaySessionEntryReadOnly>[1]) =>
      key === sessionKey ? loadGatewaySessionEntryReadOnly(key, options) : original(key, options),
  );
  const read = () => loadGatewaySessionEntryReadOnly(sessionKey, { agentId: "main" }).entry!;
  return {
    read,
    async reset(placements: WorkerSessionPlacementStore) {
      const before = read();
      const { performGatewaySessionReset } = await import("./session-reset-service.js");
      const result = await performGatewaySessionReset({
        key: sessionKey,
        agentId: "main",
        reason: "reset",
        commandSource: "gateway",
        workerPlacementContext: { workerSessionPlacementService: placements },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const after = read();
      expect(after.sessionId).toBe(before.sessionId);
      expect(after.lifecycleRevision).not.toBe(before.lifecycleRevision);
      expect(after.repositoryWorkspaceId).toBe(before.repositoryWorkspaceId);
      expect(after.worktree).toEqual(before.worktree);
      return after;
    },
  };
}

export function installGitHubPublicationTestHarness(): void {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-publication-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const syntheticIndex = path.join(root, "synthetic-index");
    await fs.writeFile(syntheticIndex, "synthetic Git transport index");
    insertRegistryWorktree(process.env, {
      id: "worktree-1",
      name: "publication",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: BRANCH,
      baseRef: "origin/main",
      ownerKind: "session",
      ownerId: SESSION_KEY,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    commands = [];
    commandCalls = [];
    mocks.updateIndex
      .mockReset()
      .mockImplementation(
        async (params: {
          cwd: string;
          sourceIndexTree: string;
          workspaceTree: string;
          run: (argv: string[], options?: { cwd?: string }) => Promise<string>;
          updateRef?: () => Promise<void>;
        }) => {
          const currentIndexTree = await params.run(
            [
              "git",
              "-c",
              `core.hooksPath=${os.devNull}`,
              "-c",
              "core.fsmonitor=false",
              "write-tree",
            ],
            { cwd: params.cwd },
          );
          if (
            currentIndexTree !== params.sourceIndexTree &&
            currentIndexTree !== params.workspaceTree
          ) {
            throw new Error(
              "GitHub publication workspace index changed after its accepted snapshot.",
            );
          }
          await params.updateRef?.();
        },
      );
    mocks.attribution.mockReset().mockReturnValue({
      trailers: ["Co-authored-by: alice <7+alice@users.noreply.github.com>"],
      logins: ["alice"],
      prompt: "",
    });
    mocks.getConfigSnapshot.mockReset().mockReturnValue(null);
    mocks.refreshIdentity.mockReset().mockResolvedValue(undefined);
    mocks.matchesIdentity.mockReset().mockReturnValue(true);
    mocks.prepareIdentity.mockReset().mockResolvedValue({
      source: "system-configured",
      profileId: "ghp_11111111111111111111111111111111",
      account: { accountId: 42, login: "roboclaw-bot", avatarUrl: null },
      env: {
        GH_CONFIG_DIR: "/private/github-profile",
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      },
    });
    mocks.findWorktree.mockReset().mockImplementation((_ownerKind, ownerId: string) => ({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: BRANCH,
      baseRef: "origin/main",
      ownerKind: "session",
      ownerId,
    }));
    mocks.findWorktreeById.mockReset().mockReturnValue(undefined);
    mocks.resolveRepository.mockReset().mockResolvedValue({
      checkoutRoot: "/repo/worktree",
      repoRoot: "/repo",
      originUrl: "git@github.com:openclaw/openclaw.git",
      fingerprint: "fingerprint-1",
    });
    mocks.loadSession.mockReset().mockImplementation((sessionKey: string) => ({
      canonicalKey: sessionKey,
      agentId: "main",
      storePath: "/state/sessions.json",
      entry: {
        sessionId: sessionKey === REQUEST.sessionKey ? REQUEST.sessionId : SESSION_ID,
        worktree: { id: "worktree-1", branch: BRANCH, repoRoot: "/repo" },
      },
    }));
    let remoteLookup = 0;
    mocks.runCommand
      .mockReset()
      .mockImplementation(async (argv: string[], options?: { input?: string }) => {
        commands.push(argv);
        commandCalls.push({ argv, input: options?.input });
        const command = argv.join(" ");
        if (command === "git symbolic-ref --quiet --short HEAD") {
          return commandResult(`${BRANCH}\n`);
        }
        if (command === `git symbolic-ref --quiet refs/heads/${BRANCH}`) {
          return commandResult("", 1);
        }
        if (command === "git rev-parse --verify HEAD^{commit}") {
          return commandResult(`${OLD_HEAD}\n`);
        }
        if (
          command.startsWith(
            "gh api --hostname github.com repos/openclaw/openclaw --jq {fork, default_branch, parent:",
          )
        ) {
          return commandResult('{"fork":false,"default_branch":"main"}\n');
        }
        const baseRefPrefix = "gh api --hostname github.com repos/openclaw/openclaw/git/ref/heads/";
        if (command.startsWith(baseRefPrefix)) {
          const branch = command.slice(baseRefPrefix.length).split(" --jq", 1)[0];
          return commandResult(JSON.stringify({ ref: `refs/heads/${branch}`, sha: BASE_HEAD }));
        }
        if (command === "git show -s --format=%B HEAD") {
          return commandResult("existing commit\n");
        }
        if (command === "git config --local --includes --bool --get extensions.worktreeConfig") {
          return commandResult("", 1);
        }
        if (argv.includes("--includes") && argv.includes("--get-regexp")) {
          return commandResult("", 1);
        }
        if (command.startsWith("git ls-tree -r -z --full-tree ")) {
          return commandResult();
        }
        if (argv.includes("rev-parse") && argv.includes("--git-path") && argv.at(-1) === "index") {
          return commandResult(syntheticIndex);
        }
        if (command === "git rev-parse --git-path info/attributes") {
          return commandResult(path.join(root, "missing-info-attributes"));
        }
        if (command === "git rev-parse --git-path info/grafts") {
          return commandResult(path.join(root, "missing-grafts"));
        }
        if (command === "git var GIT_ATTR_GLOBAL" || command === "git var GIT_ATTR_SYSTEM") {
          return commandResult(path.join(root, "missing-global-attributes"));
        }
        if (
          argv[0] === "git" &&
          argv[1] === "config" &&
          (argv.includes("--global") || argv.includes("--system")) &&
          argv.includes("core.attributesFile")
        ) {
          return commandResult("", 1);
        }
        if (command.endsWith("write-tree")) {
          return commandResult(`${WORKSPACE_TREE}\n`);
        }
        if (command === "git rev-parse HEAD^{tree}") {
          return commandResult(`${WORKSPACE_TREE}\n`);
        }
        if (command === `git rev-parse ${BASE_HEAD}^{tree}`) {
          return commandResult(`${BASE_TREE}\n`);
        }
        if (command === "git rev-parse HEAD^") {
          return commandResult(`${OLD_HEAD}\n`);
        }
        if (command === `git reflog show --format=%H --end-of-options refs/heads/${BRANCH}`) {
          return commandResult(`${NEW_HEAD}\n${OLD_HEAD}\n`);
        }
        if (command.startsWith("git commit-tree ")) {
          return commandResult(`${NEW_HEAD}\n`);
        }
        if (command === "git rev-parse --verify --end-of-options origin/main^{commit}") {
          return commandResult(`${BASE_HEAD}\n`);
        }
        if (
          command.startsWith(
            "git -c credential.helper= -c credential.helper=!gh auth git-credential ls-remote",
          )
        ) {
          remoteLookup += 1;
          return commandResult(remoteLookup === 1 ? "" : `${NEW_HEAD}\trefs/heads/${BRANCH}\n`);
        }
        if (command.includes(" repos/openclaw/openclaw/pulls ") && command.includes("state=all")) {
          return commandResult("[]\n");
        }
        if (
          command ===
          "gh api --hostname github.com --method POST repos/openclaw/openclaw/pulls --input -"
        ) {
          return commandResult('{"html_url":"https://github.com/openclaw/openclaw/pull/125200"}\n');
        }
        return commandResult();
      });
  });

  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    // Agent close releases leases through shared state; closing shared state first can
    // reopen it during teardown and leave a Windows handle under the fixture root.
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
}

/** Real local Git/index with synthetic remote effects; no credential helper reaches a subprocess. */
export async function createRealPublicationWorkspace(
  interruptAt: "push" | "observe" | "index" | "create",
) {
  const { runCommandBuffered } =
    await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  const { updateGitHubPublicationBranchAndIndex } = await vi.importActual<
    typeof import("./github-publication-git-index.js")
  >("./github-publication-git-index.js");
  const cwd = path.join(root, "repository");
  const home = path.join(root, "git-home");
  await fs.mkdir(cwd);
  await fs.mkdir(home);
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: "Publication Test",
    GIT_AUTHOR_EMAIL: "publication@example.test",
    GIT_COMMITTER_NAME: "Publication Test",
    GIT_COMMITTER_EMAIL: "publication@example.test",
  };
  const local = async (
    argv: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
  ) =>
    await runCommandBuffered(argv, {
      cwd,
      ...options,
      env: {
        ...env,
        ...options?.env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        GH_CONFIG_DIR: undefined,
      },
      timeoutMs: 10000,
      maxOutputBytes: 256 * 1024,
    });
  const git = async (...args: string[]) => {
    const result = await local(["git", ...args]);
    if (result.code !== 0) {
      throw new Error(result.stderr.toString("utf8"));
    }
    return result.stdout.toString("utf8").trim();
  };
  await git("init", "--initial-branch=main");
  await fs.writeFile(path.join(cwd, "artifact.txt"), "base\n");
  await git("add", "artifact.txt");
  await git("commit", "-m", "base");
  const baseHead = await git("rev-parse", "HEAD");
  await git("checkout", "-b", BRANCH);
  await fs.writeFile(path.join(cwd, "artifact.txt"), "staged\n");
  await git("add", "artifact.txt");
  await fs.writeFile(path.join(cwd, "artifact.txt"), "accepted\n");
  const worktree = { ...mocks.findWorktree("session", SESSION_KEY), path: cwd, repoRoot: cwd };
  mocks.findWorktree.mockReturnValue(worktree);
  mocks.findWorktreeById.mockReturnValue(worktree);
  const loaded = mocks.loadSession(SESSION_KEY);
  mocks.loadSession.mockReturnValue({
    ...loaded,
    entry: { ...loaded.entry, worktree: { ...loaded.entry.worktree, repoRoot: cwd } },
  });
  mocks.resolveRepository.mockResolvedValue({
    checkoutRoot: cwd,
    repoRoot: cwd,
    fingerprint: worktree.repoFingerprint,
    originUrl: "git@github.com:openclaw/openclaw.git",
  });
  mocks.updateIndex.mockImplementation(updateGitHubPublicationBranchAndIndex);
  const remote = mocks.runCommand.getMockImplementation()!;
  let interrupted = false;
  let remoteHead = "";
  const effects: string[] = [];
  mocks.runCommand.mockImplementation(
    async (argv: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) => {
      if (argv[0] === "gh") {
        if (argv.some((arg) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))) {
          return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: baseHead }));
        }
        if (argv.includes("POST")) {
          effects.push("pull_request");
          if (!interrupted && interruptAt === "create") {
            interrupted = true;
            throw new Error("synthetic PR response lost");
          }
        }
        return await remote(argv, options);
      }
      if (argv.includes("fetch")) {
        return commandResult();
      }
      if (argv.includes("push")) {
        effects.push("push");
        remoteHead = await git("rev-parse", "HEAD");
        if (!interrupted && interruptAt === "push") {
          interrupted = true;
          throw new Error("synthetic push response lost");
        }
        return commandResult();
      }
      if (argv.includes("ls-remote")) {
        if (!interrupted && interruptAt === "observe" && remoteHead) {
          interrupted = true;
          throw new Error("synthetic remote observation unavailable");
        }
        return commandResult(remoteHead ? `${remoteHead}\trefs/heads/${BRANCH}\n` : "");
      }
      const result = await local(argv, options);
      if (!interrupted && interruptAt === "index" && argv.includes("update-ref")) {
        interrupted = true;
        throw new Error("synthetic ref update response lost");
      }
      return result;
    },
  );
  return { cwd, git, effects };
}
