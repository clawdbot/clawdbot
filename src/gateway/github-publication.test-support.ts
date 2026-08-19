import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createGitHubPublicationRuntime as createRuntime } from "./github-publication-runtime.js";
import { createGitHubPublicationCoordinator as createCoordinator } from "./github-publication.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";

const mocks = vi.hoisted(() => ({
  matchesIdentity: vi.fn(),
  prepareIdentity: vi.fn(),
  runCommand: vi.fn(),
  findWorktree: vi.fn(),
  resolveRepository: vi.fn(),
  loadSession: vi.fn(),
  getConfigSnapshot: vi.fn(),
  attribution: vi.fn(),
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

vi.mock("../agents/git-coauthor-attribution.js", () => ({
  resolveGitCoauthorAttribution: mocks.attribution,
}));

vi.mock("../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    findLiveByOwner: mocks.findWorktree,
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
        base_branch, source_head_commit, workspace_tree, head_commit, pull_request_url,
        error_code, next_action, created_at_ms, updated_at_ms, reported_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
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
      params.headCommit ?? NEW_HEAD,
      1_000,
      1_001,
    );
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

export function installGitHubPublicationTestHarness(): void {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-publication-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    commands = [];
    commandCalls = [];
    mocks.attribution.mockReset().mockReturnValue({
      trailers: ["Co-authored-by: alice <7+alice@users.noreply.github.com>"],
      logins: ["alice"],
      prompt: "",
    });
    mocks.getConfigSnapshot.mockReset().mockReturnValue(null);
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
          command.startsWith("gh api repos/openclaw/openclaw --jq {fork, default_branch, parent:")
        ) {
          return commandResult('{"fork":false,"default_branch":"main"}\n');
        }
        const baseRefPrefix = "gh api repos/openclaw/openclaw/git/ref/heads/";
        if (command.startsWith(baseRefPrefix)) {
          const branch = command.slice(baseRefPrefix.length).split(" --jq", 1)[0];
          return commandResult(JSON.stringify({ ref: `refs/heads/${branch}` }));
        }
        if (command === "git show -s --format=%B HEAD") {
          return commandResult("existing commit\n");
        }
        if (
          command ===
          "git config --includes --get-regexp ^(filter\\..*|url\\..*\\.(insteadof|pushinsteadof)|include(if)?\\..*|http\\..*|push\\..*|core\\.worktree)$"
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
        if (command.includes(" repos/openclaw/openclaw/pulls ") && command.includes("state=open")) {
          return commandResult("[]\n");
        }
        if (command === "gh api --method POST repos/openclaw/openclaw/pulls --input -") {
          return commandResult('{"html_url":"https://github.com/openclaw/openclaw/pull/125200"}\n');
        }
        return commandResult();
      });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
}
