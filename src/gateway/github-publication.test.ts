import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  BASE_HEAD,
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  SESSION_ID,
  SESSION_KEY,
  WORKSPACE_TREE,
  commandCalls,
  commandResult,
  commands,
  createTestGitHubPublicationCoordinator as createGitHubPublicationCoordinator,
  createTestGitHubPublicationRuntime as createGitHubPublicationRuntime,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  publicationTranscriptMessages,
  root,
  seedLocalPublication,
} from "./github-publication.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();

describe("Gateway GitHub publication", () => {
  installGitHubPublicationTestHarness();
  it("publishes through exact HTTPS and replays the durable terminal result", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const coordinator = createGitHubPublicationCoordinator({ placements });
    const request = {
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "publish-1",
      title: "Publish the reconciled fix",
    };

    const first = await coordinator.requestForSession(request);
    expect(first).toEqual({
      requestId: expect.any(String),
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/125200",
      repository: "openclaw/openclaw",
      branch: BRANCH,
      headCommit: NEW_HEAD,
    });
    expect(commands.some((argv) => argv.includes("https://github.com/openclaw/openclaw.git"))).toBe(
      true,
    );
    expect(commands.some((argv) => argv.some((arg) => arg.includes("roboclaw-token")))).toBe(false);
    expect(
      commands.some(
        (argv) =>
          argv[0] === "git" &&
          argv.includes("credential.helper=!gh auth git-credential") &&
          argv.includes("push"),
      ),
    ).toBe(true);
    for (const argv of commands.filter(
      (candidate) =>
        candidate.includes("update-ref") ||
        candidate.includes("read-tree") ||
        candidate.includes("add") ||
        candidate.includes("reset") ||
        candidate.includes("push"),
    )) {
      expect(argv, argv.join(" ")).toContain(`core.hooksPath=${os.devNull}`);
    }
    for (const argv of commands.filter(
      (candidate) =>
        candidate.includes("read-tree") || candidate.includes("add") || candidate.includes("reset"),
    )) {
      expect(argv).toContain("core.fsmonitor=false");
    }
    const push = commands.find((argv) => argv.includes("push"));
    expect(push).toEqual(
      expect.arrayContaining([
        "--no-follow-tags",
        "--recurse-submodules=no",
        `${NEW_HEAD}:refs/heads/${BRANCH}`,
      ]),
    );
    expect(push).not.toContain(`HEAD:refs/heads/${BRANCH}`);
    const fetch = commands.find((argv) => argv.includes("fetch"));
    expect(fetch).toEqual(
      expect.arrayContaining([
        `core.hooksPath=${os.devNull}`,
        "core.fsmonitor=false",
        "maintenance.auto=false",
        "gc.auto=0",
        "--no-auto-maintenance",
        "--recurse-submodules=no",
      ]),
    );
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(post?.argv).toEqual([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "POST",
      "repos/openclaw/openclaw/pulls",
      "--input",
      "-",
    ]);
    expect(JSON.parse(post?.input ?? "null")).toEqual({
      title: "Publish the reconciled fix",
      body: `Published by the Gateway after authoritative workspace reconciliation.\n\n## Worked on by\n\n- @alice\n\n<!-- openclaw-publication:${first.requestId} -->`,
      head: `openclaw:${BRANCH}`,
      base: "main",
      draft: true,
    });
    const persisted = database.db
      .prepare("SELECT * FROM github_publication_requests WHERE session_id = ?")
      .get(SESSION_ID);
    expect(JSON.stringify(persisted)).not.toContain("GH_CONFIG_DIR");
    expect(JSON.stringify(persisted)).not.toContain("token");

    const commandCount = commands.length;
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const afterRestart = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database: reopened }),
    });
    await expect(afterRestart.requestForSession(request)).resolves.toEqual(first);
    expect(commands).toHaveLength(commandCount);
  });

  it("reuses an existing upstream pull request for a fork head", async () => {
    mocks.resolveRepository.mockResolvedValue({
      checkoutRoot: "/repo/worktree",
      repoRoot: "/repo",
      originUrl: "git@github.com:roboclaw-bot/openclaw.git",
      fingerprint: "fingerprint-1",
    });
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const command = argv.join(" ");
      if (command.startsWith("gh api --hostname github.com repos/roboclaw-bot/openclaw --jq")) {
        return commandResult(
          '{"fork":true,"default_branch":"main","parent":{"name":"openclaw","default_branch":"main","owner":{"login":"openclaw"}}}\n',
        );
      }
      if (command.includes("ls-remote") && command.includes("roboclaw-bot/openclaw.git")) {
        return commandResult(`${NEW_HEAD}\trefs/heads/${BRANCH}\n`);
      }
      if (command.includes("repos/openclaw/openclaw/pulls") && command.includes("state=all")) {
        return commandResult(
          JSON.stringify([
            {
              url: "https://github.com/openclaw/openclaw/pull/125201",
              userId: 42,
              state: "open",
              body: "",
              headSha: NEW_HEAD,
              headRef: BRANCH,
              baseRef: "main",
            },
          ]),
        );
      }
      return await fallback(argv, options);
    });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "fork-existing-pr",
    });

    expect(result).toMatchObject({
      status: "published",
      repository: "openclaw/openclaw",
      url: "https://github.com/openclaw/openclaw/pull/125201",
    });
    expect(
      mocks.runCommand.mock.calls.some(([argv]) =>
        argv.includes("head=roboclaw-bot:openclaw/publication"),
      ),
    ).toBe(true);
    expect(mocks.runCommand.mock.calls.some(([argv]) => argv.includes("POST"))).toBe(false);
  });

  it("pushes a fork and creates its pull request in the upstream repository", async () => {
    mocks.resolveRepository.mockResolvedValue({
      checkoutRoot: "/repo/worktree",
      repoRoot: "/repo",
      originUrl: "git@github.com:roboclaw-bot/openclaw.git",
      fingerprint: "fingerprint-1",
    });
    const fallback = mocks.runCommand.getMockImplementation()!;
    let remoteLookups = 0;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const command = argv.join(" ");
      if (command.startsWith("gh api --hostname github.com repos/roboclaw-bot/openclaw --jq")) {
        return commandResult(
          '{"fork":true,"default_branch":"main","parent":{"name":"openclaw","default_branch":"trunk","owner":{"login":"openclaw"}}}\n',
        );
      }
      if (command.includes("ls-remote") && command.includes("roboclaw-bot/openclaw.git")) {
        remoteLookups += 1;
        return commandResult(remoteLookups === 1 ? "" : `${NEW_HEAD}\trefs/heads/${BRANCH}\n`);
      }
      if (command.includes("repos/openclaw/openclaw/pulls") && command.includes("state=all")) {
        return commandResult("[]\n");
      }
      if (
        command ===
        "gh api --hostname github.com --method POST repos/openclaw/openclaw/pulls --input -"
      ) {
        return commandResult('{"html_url":"https://github.com/openclaw/openclaw/pull/125202"}\n');
      }
      return await fallback(argv, options);
    });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "fork-create-pr",
      title: "Publish from the fork",
    });

    expect(result).toMatchObject({
      status: "published",
      repository: "openclaw/openclaw",
      url: "https://github.com/openclaw/openclaw/pull/125202",
    });
    expect(
      mocks.runCommand.mock.calls.some(([argv]) =>
        argv.includes("https://github.com/roboclaw-bot/openclaw.git"),
      ),
    ).toBe(true);
    const post = mocks.runCommand.mock.calls.find(([argv]) => argv.includes("POST"));
    expect(post?.[0]).toEqual([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "POST",
      "repos/openclaw/openclaw/pulls",
      "--input",
      "-",
    ]);
    expect(JSON.parse(post?.[1]?.input ?? "null")).toEqual({
      title: "Publish from the fork",
      body: `Published by the Gateway after authoritative workspace reconciliation.\n\n## Worked on by\n\n- @alice\n\n<!-- openclaw-publication:${result.requestId} -->`,
      head: `roboclaw-bot:${BRANCH}`,
      base: "trunk",
      draft: true,
    });
  });

  it.each([
    { state: "open" as const, expectedStatus: "published" as const },
    { state: "closed" as const, expectedStatus: "failed" as const },
  ])(
    "handles a $state pull request after a lost POST response",
    async ({ state, expectedStatus }) => {
      const fallback = mocks.runCommand.getMockImplementation()!;
      let pullLookups = 0;
      let createdBody = "";
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        const command = argv.join(" ");
        if (command.includes("repos/openclaw/openclaw/pulls") && command.includes("state=all")) {
          pullLookups += 1;
          return commandResult(
            pullLookups < 3
              ? "[]\n"
              : JSON.stringify([
                  {
                    url: "https://github.com/openclaw/openclaw/pull/125203",
                    userId: 42,
                    state,
                    body: createdBody,
                    headSha: NEW_HEAD,
                    headRef: BRANCH,
                    baseRef: "main",
                  },
                ]),
          );
        }
        if (
          command ===
          "gh api --hostname github.com --method POST repos/openclaw/openclaw/pulls --input -"
        ) {
          createdBody = String(JSON.parse(options?.input ?? "{}").body ?? "");
          return commandResult("", 1);
        }
        return await fallback(argv, options);
      });
      const coordinator = createGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({
          database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
        }),
      });

      const result = await coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "lost-post-response",
      });

      expect(result).toMatchObject(
        expectedStatus === "published"
          ? {
              status: "published",
              url: "https://github.com/openclaw/openclaw/pull/125203",
            }
          : {
              status: "failed",
              code: "github_rejected",
              nextAction:
                "Reopen the closed pull request or retry to create a new publication request.",
            },
      );
      expect(mocks.runCommand.mock.calls.filter(([argv]) => argv.includes("POST"))).toHaveLength(1);
      expect(pullLookups).toBe(3);
    },
  );

  it("does not reuse an open pull request targeting a different base branch", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const command = argv.join(" ");
      if (command.includes("repos/openclaw/openclaw/pulls") && command.includes("state=all")) {
        return commandResult(
          JSON.stringify([
            {
              url: "https://github.com/openclaw/openclaw/pull/old-base",
              userId: 42,
              state: "open",
              body: "",
              headSha: NEW_HEAD,
              headRef: BRANCH,
              baseRef: "release",
            },
          ]),
        );
      }
      if (
        command ===
        "gh api --hostname github.com --method POST repos/openclaw/openclaw/pulls --input -"
      ) {
        return commandResult(
          '{"html_url":"https://github.com/openclaw/openclaw/pull/right-base"}\n',
        );
      }
      return await fallback(argv, options);
    });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "wrong-base-pr",
    });

    expect(result).toMatchObject({
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/right-base",
    });
    const lookup = mocks.runCommand.mock.calls.find(
      ([argv]) => argv.includes("state=all") && argv.includes("head=openclaw:openclaw/publication"),
    );
    expect(lookup?.[0]).toContain("base=main");
    expect(mocks.runCommand.mock.calls.filter(([argv]) => argv.includes("POST"))).toHaveLength(1);
  });

  it("rejects an effective clean filter before snapshotting workspace content", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("ls-tree")) {
        return commandResult(`100644 blob ${"f".repeat(40)}\t.GITATTRIBUTES\0`);
      }
      if (argv.includes("cat-file") && argv.includes("blob")) {
        return commandResult("*.bin filter=lfs\n");
      }
      return await fallback(argv, options);
    });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "active-clean-filter",
      }),
    ).rejects.toThrow("unsupported Git clean filter");
    expect(commands.some((argv) => argv.includes("commit-tree"))).toBe(false);
  });

  it("rejects a repository checkout redirected outside the managed worktree", async () => {
    mocks.resolveRepository.mockResolvedValue({
      checkoutRoot: "/tmp/other-checkout",
      repoRoot: "/repo",
      originUrl: "git@github.com:openclaw/openclaw.git",
      fingerprint: "fingerprint-1",
    });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "redirected-checkout",
    });

    expect(result).toMatchObject({ status: "failed", code: "workspace_changed" });
    expect(commands.some((argv) => argv.includes("commit-tree"))).toBe(false);
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("rejects a symbolic publication branch before updating any ref", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) =>
      argv.join(" ") === `git symbolic-ref --quiet refs/heads/${BRANCH}`
        ? commandResult("refs/heads/main\n")
        : await fallback(argv, options),
    );
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "symbolic-branch",
    });

    expect(result).toMatchObject({ status: "failed", code: "workspace_changed" });
    expect(commands.some((argv) => argv.includes("update-ref"))).toBe(false);
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("fails a restarted request when the branch advanced beyond its accepted snapshot", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });
    coordinator.read("create-schema");
    const requestId = "publication-stale-snapshot";
    seedLocalPublication(database, { requestId, status: "publishing" });
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const command = argv.join(" ");
      if (command === "git rev-parse --verify HEAD^{commit}") {
        return commandResult(`${"f".repeat(40)}\n`);
      }
      if (command === "git show -s --format=%B HEAD") {
        return commandResult("A later local commit\n");
      }
      return await fallback(argv, options);
    });

    await coordinator.resumeSessionRequests();

    expect(coordinator.read(requestId)).toMatchObject({
      status: "failed",
      code: "workspace_changed",
    });
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("passes one active resolved and source config snapshot to publication identity", async () => {
    const resolved = { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } };
    const source = {
      ...resolved,
      gateway: {
        controlUi: {
          github: { token: { source: "env", provider: "default", id: "GH_TOKEN" } },
        },
      },
    };
    mocks.getConfigSnapshot.mockReturnValue({ config: resolved, sourceConfig: source });
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });

    await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "publication-config-snapshot",
    });

    expect(mocks.refreshIdentity).toHaveBeenCalledWith("main");
    expect(mocks.refreshIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepareIdentity.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.prepareIdentity).toHaveBeenCalledWith({
      config: resolved,
      sourceConfig: source,
      agentId: "main",
    });
  });

  it("singleflights concurrent coordinators before any Git or GitHub mutation", async () => {
    let releaseRepository: (() => void) | undefined;
    const repositoryReady = new Promise<void>((resolve) => {
      releaseRepository = resolve;
    });
    mocks.resolveRepository.mockImplementationOnce(async () => {
      await repositoryReady;
      return {
        checkoutRoot: "/repo/worktree",
        repoRoot: "/repo",
        originUrl: "git@github.com:openclaw/openclaw.git",
        fingerprint: "fingerprint-1",
      };
    });
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const first = createGitHubPublicationCoordinator({ placements });
    const second = createGitHubPublicationCoordinator({ placements });
    const request = {
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "publication-concurrent",
      title: "Publish once",
    };

    const firstResult = first.requestForSession(request);
    const secondResult = second.requestForSession(request);
    await vi.waitFor(() => expect(mocks.resolveRepository).toHaveBeenCalledOnce());
    releaseRepository?.();

    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
      expect.objectContaining({ status: "published" }),
      expect.objectContaining({ status: "published" }),
    ]);
    expect(commands.filter((argv) => argv.includes("commit-tree"))).toHaveLength(1);
    const fetchIndex = commands.findIndex((argv) => argv.includes("fetch"));
    const commitIndex = commands.findIndex((argv) => argv.includes("commit-tree"));
    const updateRefIndex = commands.findIndex((argv) => argv.includes("update-ref"));
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(fetchIndex);
    expect(updateRefIndex).toBeGreaterThan(commitIndex);
    expect(commands.filter((argv) => argv.includes("push"))).toHaveLength(1);
    expect(commands.filter((argv) => argv[0] === "gh" && argv.includes("POST"))).toHaveLength(1);
  });

  it("rejects a stale turn claim after awaited identity verification", async () => {
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
      claimId: "claim-1",
      runId: "run-1",
      owner: { kind: "worker", environmentId: "environment-1", ownerEpoch: 2 },
    });
    let resolveIdentity: ((value: unknown) => void) | undefined;
    mocks.prepareIdentity.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveIdentity = resolve;
        }),
    );
    const coordinator = createGitHubPublicationCoordinator({ placements });
    const pending = coordinator.requestForClaim({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "publish-stale",
    });
    await vi.waitFor(() => expect(resolveIdentity).toBeTypeOf("function"));
    placements.releaseTurn(claim);
    resolveIdentity?.({
      source: "system-configured",
      profileId: "ghp_11111111111111111111111111111111",
      account: { accountId: 42, login: "roboclaw-bot", avatarUrl: null },
      env: {},
    });

    await expect(pending).rejects.toThrow("lost the live session turn claim after verification");
  });

  it("rejects reuse of a worker publication idempotency key by a later turn", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const active = seedActivePlacement(placements, {
      environmentId: "environment-idempotency",
      ownerEpoch: 2,
    });
    const firstClaim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-first",
      runId: "run-first",
      owner: { kind: "worker", environmentId: "environment-idempotency", ownerEpoch: 2 },
    });
    const coordinator = createGitHubPublicationCoordinator({ placements });
    await coordinator.requestForClaim({
      claim: firstClaim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "reused-worker-call",
    });
    placements.releaseTurn(firstClaim);
    const secondClaim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-second",
      runId: "run-second",
      owner: { kind: "worker", environmentId: "environment-idempotency", ownerEpoch: 2 },
    });

    await expect(
      coordinator.requestForClaim({
        claim: secondClaim,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        idempotencyKey: "reused-worker-call",
      }),
    ).rejects.toThrow("idempotency key was reused");
  });

  it("binds the accepted worker snapshot before acceptance and never recaptures it", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const active = seedActivePlacement(placements, {
      environmentId: "environment-snapshot",
      ownerEpoch: 2,
    });
    const claim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-snapshot",
      runId: "run-snapshot",
      owner: { kind: "worker", environmentId: "environment-snapshot", ownerEpoch: 2 },
    });
    const runtime = createGitHubPublicationRuntime({
      placements,
      loadSessionRuntime: async () => {
        throw new Error("not used");
      },
      warn: () => undefined,
    });
    const requested = await runtime.coordinator.requestForClaim({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "accepted-snapshot",
    });
    placements.markWorkspaceResultPending(claim);

    await runtime.prepareAcceptedWorkspacePublication(claim);

    const stored = database.db
      .prepare(
        "SELECT source_head_commit, source_index_tree, workspace_tree FROM github_publication_requests WHERE request_id = ?",
      )
      .get(requested.requestId);
    expect(stored).toEqual({
      source_head_commit: OLD_HEAD,
      source_index_tree: WORKSPACE_TREE,
      workspace_tree: WORKSPACE_TREE,
    });
    const snapshotCommandCount = commands.filter((argv) => argv.includes("write-tree")).length;
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) =>
      argv.join(" ") === "git write-tree"
        ? commandResult(`${"f".repeat(40)}\n`)
        : await fallback(argv, options),
    );
    await expect(runtime.prepareAcceptedWorkspacePublication(claim)).resolves.toBeUndefined();
    expect(commands.filter((argv) => argv.includes("write-tree"))).toHaveLength(
      snapshotCommandCount,
    );
  });

  it("fails closed when worktree authority changes during an awaited publication step", async () => {
    mocks.resolveRepository.mockImplementationOnce(async () => {
      mocks.findWorktree.mockImplementation((_ownerKind, ownerId: string) => ({
        id: "worktree-1",
        repoRoot: "/repo",
        repoFingerprint: "replacement-fingerprint",
        path: "/repo/worktree",
        branch: BRANCH,
        baseRef: "origin/main",
        ownerKind: "session",
        ownerId,
      }));
      return {
        checkoutRoot: "/repo/worktree",
        repoRoot: "/repo",
        originUrl: "git@github.com:openclaw/openclaw.git",
        fingerprint: "fingerprint-1",
      };
    });
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "publish-stale-worktree-await",
        title: "Publish safely",
      }),
    ).resolves.toEqual({
      requestId: expect.any(String),
      status: "failed",
      code: "workspace_changed",
      message: "GitHub publication failed.",
      nextAction:
        "Wait for the current turn to finish, inspect the reconciled workspace, and retry.",
    });
    expect(commands.some((argv) => argv.includes("commit-tree"))).toBe(false);
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
    expect(commands.some((argv) => argv.includes("POST"))).toBe(false);
  });

  it.each([
    { phase: "commit", remoteInitiallyPublished: false, pullRequestExists: false },
    { phase: "push", remoteInitiallyPublished: true, pullRequestExists: false },
    { phase: "pull request", remoteInitiallyPublished: true, pullRequestExists: true },
  ])(
    "resumes after $phase without duplicating completed publication steps",
    async ({ phase, remoteInitiallyPublished, pullRequestExists }) => {
      const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const first = createGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database }),
      });
      first.read("create-schema");
      const requestId = `publication-after-${phase.replaceAll(" ", "-")}`;
      seedLocalPublication(database, { requestId, status: "publishing" });
      closeOpenClawStateDatabaseForTest();

      let remoteLookups = 0;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
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
          return commandResult(`${NEW_HEAD}\n`);
        }
        if (
          command.startsWith(
            "gh api --hostname github.com repos/openclaw/openclaw --jq {fork, default_branch",
          )
        ) {
          return commandResult('{"fork":false,"default_branch":"main"}\n');
        }
        if (
          command.startsWith(
            "gh api --hostname github.com repos/openclaw/openclaw/git/ref/heads/main --jq",
          )
        ) {
          return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: BASE_HEAD }));
        }
        if (command === "git show -s --format=%B HEAD") {
          return commandResult(`Resume the publication\n\nOpenClaw-Publication: ${requestId}\n`);
        }
        if (command === "git rev-parse HEAD^{tree}") {
          return commandResult(`${WORKSPACE_TREE}\n`);
        }
        if (command.endsWith("write-tree")) {
          return commandResult(`${WORKSPACE_TREE}\n`);
        }
        if (command === "git rev-parse HEAD^") {
          return commandResult(`${OLD_HEAD}\n`);
        }
        if (command === `git reflog show --format=%H --end-of-options refs/heads/${BRANCH}`) {
          return commandResult(`${NEW_HEAD}\n${OLD_HEAD}\n`);
        }
        if (command === "git config --local --includes --bool --get extensions.worktreeConfig") {
          return commandResult("", 1);
        }
        if (argv.includes("--includes") && argv.includes("--get-regexp")) {
          return commandResult("", 1);
        }
        if (command === `git rev-parse ${BASE_HEAD}^{tree}`) {
          return commandResult(`${"e".repeat(40)}\n`);
        }
        if (
          command.startsWith(
            "git -c credential.helper= -c credential.helper=!gh auth git-credential ls-remote",
          )
        ) {
          remoteLookups += 1;
          return commandResult(
            remoteInitiallyPublished || remoteLookups > 1
              ? `${NEW_HEAD}\trefs/heads/${BRANCH}\n`
              : "",
          );
        }
        if (command.includes(" repos/openclaw/openclaw/pulls ") && command.includes("state=all")) {
          return commandResult(
            pullRequestExists
              ? JSON.stringify([
                  {
                    url: "https://github.com/openclaw/openclaw/pull/125200",
                    userId: 42,
                    state: "open",
                    body: "",
                    headSha: NEW_HEAD,
                    headRef: BRANCH,
                    baseRef: "main",
                  },
                ])
              : "[]\n",
          );
        }
        if (
          command ===
          "gh api --hostname github.com --method POST repos/openclaw/openclaw/pulls --input -"
        ) {
          return commandResult('{"html_url":"https://github.com/openclaw/openclaw/pull/125200"}\n');
        }
        return commandResult();
      });
      const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const resumed = createGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database: reopened }),
      });

      await resumed.resumeSessionRequests();

      expect(resumed.read(requestId)).toEqual({
        requestId,
        status: "published",
        url: "https://github.com/openclaw/openclaw/pull/125200",
        repository: "openclaw/openclaw",
        branch: BRANCH,
        headCommit: NEW_HEAD,
      });
      expect(commands.filter((argv) => argv.includes("commit-tree"))).toHaveLength(0);
      expect(commands.filter((argv) => argv.includes("--force"))).toHaveLength(0);
      expect(commands.filter((argv) => argv.includes("push"))).toHaveLength(
        remoteInitiallyPublished ? 0 : 1,
      );
      expect(commands.filter((argv) => argv[0] === "gh" && argv.includes("POST"))).toHaveLength(
        pullRequestExists ? 0 : 1,
      );
      const commandCount = commands.length;
      await resumed.resumeSessionRequests();
      expect(commands).toHaveLength(commandCount);
    },
  );

  it("projects an accepted worker publication exactly once across transcript-report restart", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const active = seedActivePlacement(placements, {
      environmentId: "environment-publication",
      ownerEpoch: 2,
    });
    const claim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-publication-integration",
      runId: "run-publication-integration",
      owner: {
        kind: "worker",
        environmentId: "environment-publication",
        ownerEpoch: 2,
      },
    });
    await upsertSessionEntryCore(
      { agentId: REQUEST.agentId, sessionKey: REQUEST.sessionKey },
      { sessionId: REQUEST.sessionId, updatedAt: 1 },
    );
    const loadSessionRuntime = async () => {
      const runtime = await import("./session-utils.js");
      return {
        resolveCanonicalSessionEntryFromStoreKeys:
          runtime.resolveCanonicalSessionEntryFromStoreKeys,
        resolveGatewaySessionStoreTargetWithStore:
          runtime.resolveGatewaySessionStoreTargetWithStore,
      };
    };
    const warnings: string[] = [];
    const runtime = createGitHubPublicationRuntime({
      placements,
      loadSessionRuntime,
      warn: (message) => warnings.push(message),
    });
    const requested = await runtime.coordinator.requestForClaim({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "accepted-workspace-publication",
      title: "Publish the accepted workspace",
    });
    placements.markWorkspaceResultPending(claim);
    await runtime.prepareAcceptedWorkspacePublication(claim);
    placements.acceptWorkspaceResult(claim);
    const processClaim = vi
      .spyOn(runtime.coordinator, "processClaim")
      .mockRejectedValueOnce(new Error("transient publication failure"));
    await expect(runtime.publishAcceptedWorkspace(claim)).rejects.toThrow(
      "transient publication failure",
    );
    expect(warnings).toEqual([expect.stringContaining("GitHub publication deferred")]);
    processClaim.mockRestore();
    warnings.length = 0;
    vi.spyOn(runtime.coordinator, "markReported").mockImplementationOnce(() => {
      throw new Error("Gateway stopped after transcript append");
    });

    await expect(runtime.publishAcceptedWorkspace(claim)).resolves.toBeUndefined();
    expect(warnings).toEqual([
      expect.stringContaining("GitHub publication result reporting deferred"),
    ]);
    expect(runtime.coordinator.read(requested.requestId)).toMatchObject({ status: "published" });
    expect(runtime.coordinator.listUnreportedResults()).toHaveLength(1);
    let events = await loadTranscriptEvents({
      agentId: REQUEST.agentId,
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
    });
    expect(publicationTranscriptMessages(events, requested.requestId)).toHaveLength(1);

    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const restarted = createGitHubPublicationRuntime({
      placements: createWorkerSessionPlacementStore({ database: reopened }),
      loadSessionRuntime,
      warn: (message) => warnings.push(message),
    });
    await restarted.reconcilePublications();
    await restarted.reconcilePublications();

    events = await loadTranscriptEvents({
      agentId: REQUEST.agentId,
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
    });
    expect(publicationTranscriptMessages(events, requested.requestId)).toHaveLength(1);
    expect(restarted.coordinator.listUnreportedResults()).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
