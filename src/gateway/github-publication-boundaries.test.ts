import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  BASE_HEAD,
  BRANCH,
  SESSION_ID,
  SESSION_KEY,
  WORKSPACE_TREE,
  commandResult,
  commands,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
  seedLocalPublication,
} from "./github-publication.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();

describe("Gateway GitHub publication boundaries", () => {
  installGitHubPublicationTestHarness();

  it.each([
    ["URL rewrite", "url.https://attacker.invalid/.insteadof https://github.com/"],
    ["HTTP proxy", "http.proxy https://attacker.invalid/"],
    ["push expansion", "push.followtags true"],
    ["worktree redirect", "core.worktree /tmp/other-checkout"],
    ["alternate refs command", "core.alternaterefscommand ./steal-profile"],
    ["askpass command", "core.askpass ./steal-profile"],
    ["fsmonitor command", "core.fsmonitor ./steal-profile"],
    ["credential helper", "credential.helper ./steal-profile"],
    ["remote upload-pack", "remote.origin.uploadpack ./steal-profile"],
    ["upload-pack hook", "uploadpack.packobjectshook ./steal-profile"],
  ])("rejects repository-local %s before snapshot or transport", async (label, configLine) => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("--includes") && argv.includes("--get-regexp")) {
        return commandResult(`${configLine}\n`);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: `unsafe-${label}`,
      }),
    ).rejects.toThrow("unsupported Git transport configuration");
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("rejects unsafe worktree-scoped transport config when the scope is enabled", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const command = argv.join(" ");
      if (command === "git config --local --includes --bool --get extensions.worktreeConfig") {
        return commandResult("true\n");
      }
      if (argv.includes("--get-regexp")) {
        return argv.includes("--worktree")
          ? commandResult("credential.helper ./steal-profile\n")
          : commandResult("", 1);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "unsafe-worktree-config",
      }),
    ).rejects.toThrow("unsupported Git transport configuration");
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("rejects the pull request base branch before any repository mutation", async () => {
    mocks.findWorktree.mockReturnValue({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: "main",
      baseRef: "origin/main",
      ownerKind: "session",
      ownerId: SESSION_KEY,
    });
    mocks.loadSession.mockReturnValue({
      canonicalKey: SESSION_KEY,
      agentId: "main",
      storePath: "/state/sessions.json",
      entry: {
        sessionId: SESSION_ID,
        worktree: { id: "worktree-1", branch: "main", repoRoot: "/repo" },
      },
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "base-branch",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "workspace_changed" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("publishes a feature worktree whose base metadata is HEAD", async () => {
    mocks.findWorktree.mockImplementation((_ownerKind, ownerId: string) => ({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: BRANCH,
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId,
    }));
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "head-base-metadata",
      }),
    ).resolves.toMatchObject({ status: "published", branch: BRANCH });
    expect(commands.some((argv) => argv.join(" ").includes("git/ref/heads/main"))).toBe(true);
  });

  it("rejects an accepted tree identical to the base before creating a marker commit", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.join(" ") === `git rev-parse ${BASE_HEAD}^{tree}`) {
        return commandResult(`${WORKSPACE_TREE}\n`);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "no-tree-change",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "no_changes" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("fails closed when no local base commit can be verified", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv[0] === "git" && argv[1] === "reflog") {
        return commandResult();
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "missing-base",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "workspace_changed" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("rejects a local turn that starts and finishes during snapshot capture", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const fallback = mocks.runCommand.getMockImplementation()!;
    let raced = false;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (!raced && argv.includes("add")) {
        raced = true;
        const claim = placements.claimTurn({
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          claimId: "claim-during-snapshot",
          runId: "run-during-snapshot",
          owner: { kind: "local" },
        });
        placements.releaseTurn(claim);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "local-turn-during-snapshot",
      }),
    ).rejects.toThrow("session authority changed during snapshot");
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("fails before mutation when the local base is outside the authenticated remote lineage", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv[0] === "git" && argv[1] === "merge-base") {
        return commandResult("", 1);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "unrelated-base-lineage",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "workspace_changed" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("fails before mutation when the authenticated remote base cannot be materialized", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("fetch")) {
        return commandResult("", 1);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "missing-remote-base-object",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "workspace_changed" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("fails before mutation when the target repository base branch is unavailable", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.join(" ").includes("/git/ref/heads/main")) {
        return commandResult("", 1);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "missing-remote-base",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "workspace_changed" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("refuses a matching pull request owned by another GitHub account", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const command = argv.join(" ");
      if (command.includes(" repos/openclaw/openclaw/pulls ")) {
        return commandResult(
          JSON.stringify([
            {
              url: "https://github.com/openclaw/openclaw/pull/foreign",
              userId: 99,
              state: "open",
              body: "",
              headSha: "b".repeat(40),
              headRef: BRANCH,
              baseRef: "main",
            },
          ]),
        );
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "foreign-pr",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "github_rejected" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it.each([
    { label: "invalid JSON", response: "truncated" },
    { label: "non-array JSON", response: "{}" },
    { label: "invalid candidate", response: "[{}]" },
  ])("fails closed for $label in pull request ownership", async ({ label, response }) => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.join(" ").includes(" repos/openclaw/openclaw/pulls ")) {
        return commandResult(response);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: `invalid-pr-ownership-${label}`,
      }),
    ).resolves.toMatchObject({ status: "failed", code: "github_rejected" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("creates an attributed marker commit when all changes were already committed", async () => {
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "committed-work",
        title: "Publish committed work",
      }),
    ).resolves.toMatchObject({ status: "published", branch: BRANCH });
    expect(commands.filter((argv) => argv.includes("commit-tree"))).toHaveLength(1);
  });

  it("keeps an incomplete Git transaction retryable until index recovery completes", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });
    mocks.updateIndex.mockImplementationOnce(async () => {
      const { GitHubPublicationRecoveryPendingError } = await vi.importActual<
        typeof import("./github-publication-git-index.js")
      >("./github-publication-git-index.js");
      throw new GitHubPublicationRecoveryPendingError("workspace recovery is pending");
    });
    const request = {
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "recover-index-transaction",
    };

    await expect(coordinator.requestForSession(request)).rejects.toThrow(
      "workspace recovery is pending",
    );
    expect(
      database.db
        .prepare("SELECT status FROM github_publication_requests WHERE idempotency_key = ?")
        .get(request.idempotencyKey),
    ).toEqual({ status: "publishing" });
    await expect(coordinator.requestForSession(request)).resolves.toMatchObject({
      status: "published",
    });
  });

  it("terminalizes local recovery when the managed worktree fingerprint changed", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const first = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });
    first.read("create-schema");
    const requestId = "publication-stale-worktree";
    seedLocalPublication(database, {
      requestId,
      status: "requested",
      repositoryFingerprint: "replaced-fingerprint",
    });
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const resumed = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database: reopened }),
    });

    await resumed.resumeLocalRequests();

    expect(resumed.read(requestId)).toEqual({
      requestId,
      status: "failed",
      code: "workspace_changed",
      message: "GitHub publication failed.",
      nextAction:
        "Wait for the current turn to finish, inspect the reconciled workspace, and retry.",
    });
    expect(commands).toEqual([]);
  });

  it("validates the live session owner before recovery can touch Git state", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });
    coordinator.read("create-schema");
    const requestId = "publication-stale-session-owner";
    seedLocalPublication(database, { requestId, status: "requested" });
    mocks.findWorktreeById.mockReturnValue({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: BRANCH,
      baseRef: "origin/main",
      ownerKind: "session",
      ownerId: SESSION_KEY,
    });
    mocks.findWorktree.mockReturnValue({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: BRANCH,
      baseRef: "origin/main",
      ownerKind: "session",
      ownerId: "agent:main:dashboard:replacement",
    });

    await coordinator.resumeLocalRequests();

    expect(coordinator.read(requestId)).toMatchObject({
      status: "failed",
      code: "session_changed",
    });
    expect(commands).toEqual([]);
  });

  it("rejects unsafe Git configuration before starting recovery probes", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });
    coordinator.read("create-schema");
    const requestId = "publication-unsafe-recovery";
    seedLocalPublication(database, { requestId, status: "requested" });
    mocks.findWorktreeById.mockReturnValue({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: BRANCH,
      baseRef: "origin/main",
      ownerKind: "session",
      ownerId: SESSION_KEY,
    });
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("--local") && argv.includes("--get-regexp")) {
        return commandResult("core.fsmonitor ./untrusted-monitor\n");
      }
      return await fallback(argv, options);
    });

    await coordinator.resumeLocalRequests();

    expect(coordinator.read(requestId)).toMatchObject({
      status: "failed",
      code: "workspace_changed",
    });
    expect(commands.some((argv) => argv.join(" ") === "git rev-parse --git-path index")).toBe(
      false,
    );
  });

  it("terminalizes an accepted request whose turn ended before workspace acceptance", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const active = seedActivePlacement(placements, {
      environmentId: "environment-1",
      ownerEpoch: 2,
    });
    const claim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-orphan",
      runId: "run-orphan",
      owner: { kind: "worker", environmentId: "environment-1", ownerEpoch: 2 },
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });
    const accepted = await coordinator.requestForClaim({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "publish-orphan",
    });
    placements.releaseTurn(claim);

    const failed = coordinator.failOrphanedRequests();

    expect(failed).toEqual([
      {
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        result: {
          requestId: accepted.requestId,
          status: "failed",
          code: "session_changed",
          message: "GitHub publication failed.",
          nextAction:
            "The originating turn ended before its workspace result was accepted. Start a new turn and request publication again.",
        },
      },
    ]);
    expect(coordinator.listUnreportedResults()).toEqual(failed);
    expect(commands).toEqual([]);
  });
});
