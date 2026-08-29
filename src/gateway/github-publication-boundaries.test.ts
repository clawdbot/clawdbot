import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveGitHubPublicationFailure } from "./github-publication-failure.js";
import {
  BASE_HEAD,
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  SESSION_ID,
  SESSION_KEY,
  WORKSPACE_TREE,
  commandResult,
  commands,
  createTestGitHubPublicationCoordinator,
  createTestGitHubPublicationRuntime as createGitHubPublicationRuntime,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
  seedLocalPublication,
  setPublicationSessionTitle,
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

  it("explains how to remove unsupported Git transport configuration", () => {
    expect(
      resolveGitHubPublicationFailure(
        new Error("GitHub publication workspace has unsupported Git transport configuration."),
      ),
    ).toEqual({
      code: "workspace_changed",
      nextAction:
        "Remove the unsupported Git transport or replacement configuration from the session worktree, then retry.",
    });
  });

  it.each([false, true])(
    "rejects the local base branch with automatic naming %s",
    async (automatic) => {
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
          label: "A descriptive sidebar summary",
          worktree: {
            id: "worktree-1",
            branch: "main",
            repoRoot: "/repo",
            ...(automatic ? { naming: "automatic" } : {}),
          },
        },
      });
      const fallback = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        const command = argv.join(" ");
        if (command === "git symbolic-ref --quiet --short HEAD") {
          return commandResult("main\n");
        }
        if (command === "git reflog show --format=%H --end-of-options refs/heads/main") {
          return commandResult(`${BASE_HEAD}\n`);
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
          idempotencyKey: "base-branch",
        }),
      ).resolves.toMatchObject({ status: "failed", code: "workspace_changed" });
      expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
        false,
      );
    },
  );

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
    setPublicationSessionTitle({ automatic: true });
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.join(" ") === `git rev-parse ${BASE_HEAD}^{tree}`) {
        return commandResult(`${WORKSPACE_TREE}\n`);
      }
      return await fallback(argv, options);
    });
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
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
    expect(
      database.db
        .prepare("SELECT repository FROM github_publication_requests WHERE idempotency_key = ?")
        .get("no-tree-change"),
    ).toEqual({ repository: null });
    mocks.runCommand.mockImplementation(fallback);
    setPublicationSessionTitle({ automatic: true, label: "Summarize the real changes" });
    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "now-has-tree-change",
      }),
    ).resolves.toMatchObject({
      status: "published",
      branch: expect.stringMatching(/^openclaw\/summarize-the-real-changes-[a-f0-9]{12}$/u),
    });
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

  it("requeues a publication when execution loses live session authority", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    let competingClaim: ReturnType<typeof placements.claimTurn> | undefined;
    mocks.resolveRepository.mockImplementationOnce(async () => {
      competingClaim = placements.claimTurn({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        claimId: "claim-during-publication",
        runId: "run-during-publication",
        owner: { kind: "local" },
      });
      return {
        checkoutRoot: "/repo/worktree",
        repoRoot: "/repo",
        originUrl: "git@github.com:openclaw/openclaw.git",
        fingerprint: "fingerprint-1",
      };
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });

    const queued = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "lost-publication-authority",
    });

    expect(queued).toMatchObject({ status: "requested" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
    expect(competingClaim).toBeDefined();
    placements.releaseTurn(competingClaim!);

    await coordinator.resumeSessionRequests();

    expect(coordinator.read(queued.requestId)).toMatchObject({ status: "published" });
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
    { name: "an ancestor commit", remoteHead: BASE_HEAD },
    { name: "an unrelated commit", remoteHead: "f".repeat(40) },
  ])("never overwrites an automatic destination occupied by $name", async ({ remoteHead }) => {
    setPublicationSessionTitle({ automatic: true, label: "Name this pull request" });
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("ls-remote")) {
        return commandResult(`${remoteHead}\t${argv.at(-1)}\n`);
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
        idempotencyKey: "occupied-auto-destination",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "push_rejected",
      nextAction: expect.stringContaining("new worktree"),
    });
    expect(commands.some((argv) => argv.includes("push") || argv.includes("POST"))).toBe(false);
  });

  it.each(
    (["publishing", "published"] as const).flatMap((status) =>
      [false, true].map((diverged) => ({ status, diverged })),
    ),
  )(
    "updates a previously owned $status destination only without divergence ($diverged)",
    async ({ status, diverged }) => {
      const branch = "openclaw/previously-published-summary";
      const remoteHead = "f".repeat(40);
      setPublicationSessionTitle({ automatic: true, label: "A later title" });
      const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const coordinator = createTestGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database }),
      });
      coordinator.read("create-schema");
      seedLocalPublication(database, {
        requestId: "previous-owned-publication",
        status,
        branch,
        headCommit: status === "published" ? "e".repeat(40) : remoteHead,
      });
      const fallback = mocks.runCommand.getMockImplementation()!;
      let remoteLookups = 0;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (argv.includes("ls-remote")) {
          remoteLookups += 1;
          return commandResult(
            `${remoteLookups === 1 ? remoteHead : NEW_HEAD}\trefs/heads/${branch}\n`,
          );
        }
        if (argv.join(" ") === `git merge-base --is-ancestor ${remoteHead} ${NEW_HEAD}`) {
          return commandResult("", diverged ? 1 : 0);
        }
        return await fallback(argv, options);
      });

      await expect(
        coordinator.requestForSession({
          sessionKey: SESSION_KEY,
          agentId: "main",
          idempotencyKey: "update-owned-publication",
        }),
      ).resolves.toMatchObject(
        diverged ? { status: "failed", code: "push_rejected" } : { status: "published", branch },
      );
      const pushes = commands.filter((argv) => argv.includes("push"));
      expect(pushes).toHaveLength(diverged ? 0 : 1);
      if (!diverged) {
        expect(pushes[0]).toContain(`--force-with-lease=refs/heads/${branch}:${remoteHead}`);
      }
    },
  );

  it("does not record the source head as a candidate when commit creation fails", async () => {
    setPublicationSessionTitle({ automatic: true, label: "Publish only a real candidate" });
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) =>
      argv.includes("commit-tree") ? commandResult("", 1) : await fallback(argv, options),
    );
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "failed-candidate-creation",
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(
      database.db
        .prepare(
          "SELECT source_head_commit, head_commit FROM github_publication_requests WHERE request_id = ?",
        )
        .get(result.requestId),
    ).toEqual({ source_head_commit: OLD_HEAD, head_commit: null });
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
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
    for (const [, options] of mocks.runCommand.mock.calls) {
      expect(options?.env).toMatchObject({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: os.devNull,
      });
    }
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

    await resumed.resumeSessionRequests();

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

    await coordinator.resumeSessionRequests();

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

    await coordinator.resumeSessionRequests();

    expect(coordinator.read(requestId)).toMatchObject({
      status: "failed",
      code: "workspace_changed",
    });
    expect(commands.some((argv) => argv.join(" ") === "git rev-parse --git-path index")).toBe(
      false,
    );
  });

  it.each([
    { label: "no live claim", claimRunId: undefined, expectedRunId: undefined },
    { label: "another active turn", claimRunId: "run-active", expectedRunId: undefined },
    { label: "a mismatched run identity", claimRunId: "run-active", expectedRunId: "run-other" },
  ])("queues a cloud session publication with $label", async ({ claimRunId, expectedRunId }) => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const active = seedActivePlacement(placements, {
      environmentId: "environment-deferred-request",
      ownerEpoch: 2,
    });
    if (claimRunId) {
      placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: "claim-active",
        runId: claimRunId,
        owner: { kind: "worker", environmentId: "environment-deferred-request", ownerEpoch: 2 },
      });
    }
    const coordinator = createTestGitHubPublicationCoordinator({ placements });

    const result = await coordinator.requestForSession({
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "deferred-cloud-request",
      ...(expectedRunId ? { expectedRunId } : {}),
    });

    expect(result).toMatchObject({ status: "requested" });
    expect(
      database.db
        .prepare(
          "SELECT claim_id, run_id, environment_id, owner_epoch, placement_generation, source_head_commit, source_index_tree, workspace_tree FROM github_publication_requests WHERE request_id = ?",
        )
        .get(result.requestId),
    ).toEqual({
      claim_id: null,
      run_id: null,
      environment_id: null,
      owner_epoch: null,
      placement_generation: null,
      source_head_commit: null,
      source_index_tree: null,
      workspace_tree: null,
    });
    expect(commands).toEqual([]);
  });

  it("publishes deferred session requests alongside an accepted turn claim", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const active = seedActivePlacement(placements, {
      environmentId: "environment-accepted-deferred",
      ownerEpoch: 2,
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });
    const deferred = await coordinator.requestForSession({
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "accepted-deferred-session",
    });
    const claim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-accepted-deferred",
      runId: "run-accepted-deferred",
      owner: { kind: "worker", environmentId: "environment-accepted-deferred", ownerEpoch: 2 },
    });
    const claimed = await coordinator.requestForClaim({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "accepted-claim-session",
    });
    placements.markWorkspaceResultPending(claim);
    await coordinator.prepareClaimWorkspace(claim);
    placements.acceptWorkspaceResult(claim);

    await expect(coordinator.processClaim(claim)).resolves.toEqual([
      expect.objectContaining({ requestId: claimed.requestId, status: "published" }),
      expect.objectContaining({ requestId: deferred.requestId, status: "published" }),
    ]);
  });

  it("defers an orphaned turn request and publishes it when the workspace is quiescent", async () => {
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

    coordinator.deferOrphanedRequests();

    expect(coordinator.read(accepted.requestId)).toMatchObject({ status: "requested" });
    expect(coordinator.listUnreportedResults()).toEqual([]);
    expect(commands).toEqual([]);

    await coordinator.resumeSessionRequests();

    expect(coordinator.read(accepted.requestId)).toMatchObject({ status: "published" });
    expect(coordinator.listUnreportedResults()).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ status: "published" }) }),
    ]);
  });

  it("defers snapshot preparation failures without blocking workspace acceptance", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const active = seedActivePlacement(placements, {
      environmentId: "environment-snapshot-failure",
      ownerEpoch: 2,
    });
    const claim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-snapshot-failure",
      runId: "run-snapshot-failure",
      owner: {
        kind: "worker",
        environmentId: "environment-snapshot-failure",
        ownerEpoch: 2,
      },
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
      idempotencyKey: "snapshot-failure",
    });
    placements.markWorkspaceResultPending(claim);
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) =>
      argv.includes("--get-regexp")
        ? commandResult("filter.attacker.clean ./run-attacker\n")
        : await fallback(argv, options),
    );

    await expect(runtime.prepareAcceptedWorkspacePublication(claim)).resolves.toBeUndefined();
    expect(
      database.db
        .prepare(
          "SELECT claim_id, run_id, environment_id, owner_epoch, placement_generation, gateway_instance_id FROM github_publication_requests WHERE request_id = ?",
        )
        .get(requested.requestId),
    ).toEqual({
      claim_id: null,
      run_id: null,
      environment_id: null,
      owner_epoch: null,
      placement_generation: null,
      gateway_instance_id: null,
    });
    expect(() => placements.acceptWorkspaceResult(claim)).not.toThrow();
    await runtime.coordinator.resumeSessionRequests();
    expect(runtime.coordinator.read(requested.requestId)).toMatchObject({ status: "requested" });
    mocks.runCommand.mockImplementation(fallback);
    placements.completeWorkspaceResultAndReleaseTurn(claim);

    await runtime.coordinator.resumeSessionRequests();

    expect(runtime.coordinator.read(requested.requestId)).toMatchObject({ status: "published" });
  });
});
