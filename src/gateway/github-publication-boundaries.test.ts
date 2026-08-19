import { describe, expect, it } from "vitest";
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
      if (argv.includes("--end-of-options")) {
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
        idempotencyKey: "missing-base",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "workspace_changed" });
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
