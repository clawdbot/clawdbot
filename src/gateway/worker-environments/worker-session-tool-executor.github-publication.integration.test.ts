import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { PreparedGitHubPublicationIdentity } from "../../agents/github-tool-identity.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { runCommandBuffered as RunCommandBuffered } from "../../process/exec.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { githubPublicationBaseLookupArgs } from "../github-publication-base.js";
import {
  githubPublicationCreatePullRequestArgs,
  githubPublicationPullRequestLookupArgs,
} from "../github-publication-pull-requests.js";
import {
  hasGitHubPublicationStore,
  readGitHubPublicationRequest,
} from "../github-publication-store.js";
import { createGitHubPublicationCoordinator } from "../github-publication.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionTurnClaim,
} from "./placement-store.js";
import { bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import { createWorkerSessionToolExecutor } from "./worker-session-tool-executor.js";

type BufferedCommandRunner = typeof RunCommandBuffered;

const identityHarness = vi.hoisted(() => ({
  matches: vi.fn(),
  prepare: vi.fn(),
  refresh: vi.fn(),
}));
const commandHarness = vi.hoisted(() => ({
  actual: null as BufferedCommandRunner | null,
  run: vi.fn<BufferedCommandRunner>(),
}));

vi.mock("../../agents/github-tool-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/github-tool-identity.js")>();
  return {
    ...actual,
    matchesPreparedGitHubPublicationIdentity: identityHarness.matches,
    prepareGitHubPublicationIdentity: identityHarness.prepare,
  };
});

vi.mock("../github-oauth-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-oauth-lifecycle.js")>();
  return {
    ...actual,
    requestCurrentGitHubOAuthRefresh: identityHarness.refresh,
  };
});

vi.mock("../../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process/exec.js")>();
  commandHarness.actual = actual.runCommandBuffered;
  return { ...actual, runCommandBuffered: commandHarness.run };
});

const AGENT_ID = "main";
const SESSION_ID = "publication-session";
const SESSION_KEY = "agent:main:dashboard:publication";
const ENVIRONMENT_ID = "publication-environment";
const OWNER_EPOCH = 7;
const CLAIM_ID = "publication-claim";
const RUN_ID = "publication-run";
const WORKTREE_ID = "publication-worktree";
const BRANCH = "proof/brokered-publication";
const GITHUB_REPOSITORY = "proof-owner/proof-repository";
const GITHUB_REMOTE = `https://github.com/${GITHUB_REPOSITORY}.git`;
const TITLE = "Publish the accepted worker workspace";
const BODY = "This publication crossed the Gateway broker.";
const TOOL_CALL_ID = "github-publication-tool-call";
const TEST_GITHUB_TOKEN = "github-publication-test-token";

const PREPARED_IDENTITY: PreparedGitHubPublicationIdentity = Object.freeze({
  source: "system-configured",
  profileId: `ghp_${"1".repeat(32)}`,
  account: {
    accountId: 42,
    login: "publication-bot",
    avatarUrl: null,
  },
  env: Object.freeze({
    GH_TOKEN: TEST_GITHUB_TOKEN,
    GH_PROMPT_DISABLED: "1",
  }),
});

const REPOSITORY_LOOKUP_ARGS = [
  "gh",
  "api",
  "--hostname",
  "github.com",
  `repos/${GITHUB_REPOSITORY}`,
  "--jq",
  "{fork, default_branch, parent: {name: .parent.name, default_branch: .parent.default_branch, owner: {login: .parent.owner.login}}}",
];

type CommandObservation = {
  postInputs: Array<Record<string, unknown>>;
  postRemoteHeads: string[];
  postTokens: Array<string | undefined>;
  pushArgs: string[][];
  pushTokens: Array<string | undefined>;
};

type RawWorkerPublicationExecutor = (request: {
  identity: WorkerConnectionIdentity;
  toolName: string;
  request: {
    toolCallId: string;
    title?: string;
    body?: string;
  };
}) => Promise<{ resultJson: string }>;

type PublicationFixture = {
  root: string;
  repo: string;
  bareRemote: string;
  baseHead: string;
  sourceHead: string;
  claim: WorkerSessionTurnClaim;
  identity: WorkerConnectionIdentity;
  placements: ReturnType<typeof createWorkerSessionPlacementStore>;
  coordinator: ReturnType<typeof createGitHubPublicationCoordinator>;
  execute: RawWorkerPublicationExecutor;
  commandObservation: CommandObservation;
  claims: WorkerSessionTurnClaim[];
  delegatedAuthorities: AgentRunDelegatedAuthority[];
  rootAdmission: NonNullable<ReturnType<typeof tryBeginGatewayRootWorkAdmission>>;
  dispose: () => Promise<void>;
};

type FixtureCleanupState = {
  root: string;
  claims: WorkerSessionTurnClaim[];
  delegatedAuthorities: AgentRunDelegatedAuthority[];
  placements?: ReturnType<typeof createWorkerSessionPlacementStore>;
  rootAdmission?: NonNullable<ReturnType<typeof tryBeginGatewayRootWorkAdmission>>;
  disposed: boolean;
};

const activeFixtureCleanups = new Set<FixtureCleanupState>();

function commandResult(stdout = "", code = 0) {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

function exactArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

async function runActual(
  argv: string[],
  options: Parameters<BufferedCommandRunner>[1] = {},
): Promise<Awaited<ReturnType<BufferedCommandRunner>>> {
  const actual = commandHarness.actual;
  if (!actual) {
    throw new Error("real command runner was not installed");
  }
  return await actual(argv, options);
}

async function requireActual(
  argv: string[],
  options: Parameters<BufferedCommandRunner>[1] = {},
): Promise<string> {
  const result = await runActual(argv, options);
  if (result.code !== 0) {
    throw new Error(
      `${argv.join(" ")} failed: ${result.stderr.toString("utf8").trim() || result.code}`,
    );
  }
  return result.stdout.toString("utf8").trim();
}

function activateWorkerPlacement(
  placements: ReturnType<typeof createWorkerSessionPlacementStore>,
): void {
  let placement = placements.startDispatch({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    agentId: AGENT_ID,
    executionMode: "worker-turn",
  });
  placement = placements.transition({
    sessionId: SESSION_ID,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: ENVIRONMENT_ID },
  });
  placement = placements.transition({
    sessionId: SESSION_ID,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: "a".repeat(64) },
  });
  placement = placements.transition({
    sessionId: SESSION_ID,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      remoteWorkspaceDir: "/worker/publication",
      workspaceBaseManifestRef: "publication-base-manifest",
    },
  });
  placements.transition({
    sessionId: SESSION_ID,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: OWNER_EPOCH },
  });
}

async function configureCommandBoundary(params: {
  bareRemote: string;
  baseHead: string;
  observation: CommandObservation;
}): Promise<void> {
  const pullRequestLookup = githubPublicationPullRequestLookupArgs({
    repository: GITHUB_REPOSITORY,
    owner: "proof-owner",
    branch: BRANCH,
    baseBranch: "main",
  });
  const pullRequestCreate = githubPublicationCreatePullRequestArgs(GITHUB_REPOSITORY);
  const baseLookup = githubPublicationBaseLookupArgs(GITHUB_REPOSITORY, "main");

  commandHarness.run.mockImplementation(async (argv, options = {}) => {
    if (argv[0] === "git") {
      const networkCommand = argv.some((argument) =>
        ["clone", "fetch", "ls-remote", "push"].includes(argument),
      );
      if (networkCommand && !argv.includes(GITHUB_REMOTE)) {
        throw new Error(`unexpected Git network command: ${argv.join(" ")}`);
      }
      if (
        argv.some(
          (argument) => /^(?:git|https?|ssh):\/\//u.test(argument) && argument !== GITHUB_REMOTE,
        )
      ) {
        throw new Error(`unexpected Git remote: ${argv.join(" ")}`);
      }
      const rewritten = argv.map((argument) =>
        argument === GITHUB_REMOTE ? params.bareRemote : argument,
      );
      return await runActual(rewritten, options);
    }
    if (exactArgs(argv, REPOSITORY_LOOKUP_ARGS)) {
      return commandResult(JSON.stringify({ fork: false, default_branch: "main" }));
    }
    if (exactArgs(argv, baseLookup)) {
      return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: params.baseHead }));
    }
    if (exactArgs(argv, pullRequestLookup)) {
      return commandResult("[]");
    }
    if (exactArgs(argv, pullRequestCreate)) {
      const input =
        typeof options.input === "string"
          ? options.input
          : Buffer.from(options.input ?? "").toString("utf8");
      params.observation.postInputs.push(JSON.parse(input) as Record<string, unknown>);
      params.observation.postTokens.push(options.env?.GH_TOKEN);
      const remoteHead = await requireActual([
        "git",
        "--git-dir",
        params.bareRemote,
        "rev-parse",
        `refs/heads/${BRANCH}`,
      ]);
      params.observation.postRemoteHeads.push(remoteHead);
      return commandResult(
        JSON.stringify({ html_url: "https://github.com/proof-owner/proof-repository/pull/1" }),
      );
    }
    throw new Error(`unexpected publication command: ${argv.join(" ")}`);
  });

  const delegate = commandHarness.run.getMockImplementation();
  commandHarness.run.mockImplementation(async (argv, options = {}) => {
    if (argv[0] === "git" && argv.includes("push") && argv.includes(GITHUB_REMOTE)) {
      params.observation.pushArgs.push([...argv]);
      params.observation.pushTokens.push(options.env?.GH_TOKEN);
    }
    if (!delegate) {
      throw new Error("publication command delegate disappeared");
    }
    return await delegate(argv, options);
  });
}

async function disposeFixtureState(state: FixtureCleanupState): Promise<void> {
  if (state.disposed) {
    return;
  }
  state.disposed = true;
  activeFixtureCleanups.delete(state);
  try {
    if (state.placements) {
      for (const claim of state.claims.toReversed()) {
        if (!state.placements.validateTurnClaim(claim)) {
          continue;
        }
        const pending = state.placements
          .listPendingWorkspaceResults()
          .find((result) => result.claimId === claim.claimId && result.runId === claim.runId);
        if (
          pending?.workspaceAcceptedAtMs !== null &&
          pending?.workspaceAcceptedAtMs !== undefined
        ) {
          state.placements.completeWorkspaceResultAndReleaseTurn(claim);
        } else {
          await state.placements.closeWorkerTurnToolState(claim);
          state.placements.releaseTurn(claim);
        }
      }
    }
  } finally {
    for (const authority of state.delegatedAuthorities) {
      releaseAgentRunDelegatedAuthority(authority);
    }
    state.rootAdmission?.release();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetGatewayWorkAdmission();
    vi.unstubAllEnvs();
    await fs.rm(state.root, { recursive: true, force: true });
  }
}

async function createFixture(): Promise<PublicationFixture> {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetGatewayWorkAdmission();
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-publication-")),
  );
  const stateDir = path.join(root, "state");
  const sourceRepo = path.join(root, "source");
  const repo = path.join(root, "repo");
  const bareRemote = path.join(root, "remote.git");
  const cleanupState: FixtureCleanupState = {
    root,
    claims: [],
    delegatedAuthorities: [],
    disposed: false,
  };
  activeFixtureCleanups.add(cleanupState);
  await fs.mkdir(stateDir, { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

  await requireActual(["git", "init", "--bare", "--initial-branch=main", bareRemote]);
  await requireActual(["git", "init", "--initial-branch=main", sourceRepo]);
  await requireActual(["git", "-C", sourceRepo, "config", "user.name", "Fixture Author"]);
  await requireActual(["git", "-C", sourceRepo, "config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(path.join(sourceRepo, "proof.txt"), "base bytes\n");
  await requireActual(["git", "-C", sourceRepo, "add", "proof.txt"]);
  await requireActual(["git", "-C", sourceRepo, "commit", "-m", "base"]);
  const baseHead = await requireActual(["git", "-C", sourceRepo, "rev-parse", "HEAD"]);
  await requireActual(["git", "-C", sourceRepo, "remote", "add", "seed", bareRemote]);
  await requireActual(["git", "-C", sourceRepo, "push", "seed", "main"]);
  await requireActual(["git", "-C", sourceRepo, "remote", "remove", "seed"]);
  await requireActual(["git", "-C", sourceRepo, "remote", "add", "origin", GITHUB_REMOTE]);
  await requireActual(["git", "-C", sourceRepo, "worktree", "add", "-b", BRANCH, repo, "main"]);
  await fs.writeFile(path.join(repo, "committed.txt"), "source commit bytes\n");
  await requireActual(["git", "-C", repo, "add", "committed.txt"]);
  await requireActual(["git", "-C", repo, "commit", "-m", "source"]);
  const sourceHead = await requireActual(["git", "-C", repo, "rev-parse", "HEAD"]);
  await fs.writeFile(path.join(repo, "proof.txt"), "accepted staged bytes\n");
  await requireActual(["git", "-C", repo, "add", "proof.txt"]);
  await fs.writeFile(path.join(repo, "workspace.txt"), "accepted untracked bytes\n");

  const repository = await managedWorktrees.resolveRepositoryIdentity(repo);
  expect(repository.checkoutRoot).toBe(repo);
  insertRegistryWorktree(process.env, {
    id: WORKTREE_ID,
    name: "publication-proof",
    repoRoot: repository.repoRoot,
    repoFingerprint: repository.fingerprint,
    path: repo,
    branch: BRANCH,
    baseRef: "origin/main",
    ownerKind: "session",
    ownerId: SESSION_KEY,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });
  const storePath = resolveSessionStorePathCore(undefined, {
    agentId: AGENT_ID,
    env: process.env,
  });
  await replaceSessionEntry({ agentId: AGENT_ID, sessionKey: SESSION_KEY, storePath }, {
    sessionId: SESSION_ID,
    updatedAt: Date.now(),
    worktree: {
      id: WORKTREE_ID,
      branch: BRANCH,
      repoRoot: repository.repoRoot,
    },
  } satisfies InternalSessionEntry);

  const database = openOpenClawStateDatabase({ env: process.env });
  const placements = createWorkerSessionPlacementStore({ database });
  cleanupState.placements = placements;
  activateWorkerPlacement(placements);
  const claim = placements.claimTurn({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    agentId: AGENT_ID,
    claimId: CLAIM_ID,
    runId: RUN_ID,
    owner: {
      kind: "worker",
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
    },
  });
  cleanupState.claims.push(claim);
  placements.authorizeWorkerTurnTools(claim, ["github_publish"]);

  const delegatedAuthorities = cleanupState.delegatedAuthorities;
  const operationalRun = createOperationalRunInstanceRef(RUN_ID);
  delegatedAuthorities.push(claimAgentRunDelegatedAuthority(operationalRun));
  const rootAdmission = tryBeginGatewayRootWorkAdmission("worker-publication-proof");
  if (!rootAdmission) {
    throw new Error("worker publication fixture could not admit its root");
  }
  cleanupState.rootAdmission = rootAdmission;
  await rootAdmission.run(async () => {
    bindWorkerTurnOwner(
      placements,
      claim,
      undefined,
      operationalRun,
      { agentId: AGENT_ID, sessionKey: SESSION_KEY },
      () => undefined,
    );
  });

  const identity: WorkerConnectionIdentity = {
    environmentId: ENVIRONMENT_ID,
    credentialHash: "credential-hash",
    bundleHash: "a".repeat(64),
    sessionId: SESSION_ID,
    runId: RUN_ID,
    turnClaim: claim,
    ownerEpoch: OWNER_EPOCH,
    rpcSetVersion: 1,
    protocolFeatures: ["worker-session-tools-v1"],
    credentialExpiresAtMs: Date.now() + 60_000,
  };
  const commandObservation: CommandObservation = {
    postInputs: [],
    postRemoteHeads: [],
    postTokens: [],
    pushArgs: [],
    pushTokens: [],
  };
  await configureCommandBoundary({ bareRemote, baseHead, observation: commandObservation });
  identityHarness.prepare.mockReset().mockResolvedValue(PREPARED_IDENTITY);
  identityHarness.matches.mockReset().mockReturnValue(true);
  identityHarness.refresh.mockReset().mockResolvedValue(undefined);

  const coordinator = createGitHubPublicationCoordinator({ placements });
  const execute = createWorkerSessionToolExecutor({
    resolveGatewayContext: () => undefined,
    placements,
    environments: { get: () => undefined },
    dispatchChild: async () => {
      throw new Error("unexpected child dispatch");
    },
    githubPublication: coordinator,
    portals: {
      getService: () => undefined,
      carrier: {
        open: async () => {
          throw new Error("unexpected portal open");
        },
      },
      onChanged: () => undefined,
    } as never,
  }) as RawWorkerPublicationExecutor;

  return {
    root,
    repo,
    bareRemote,
    baseHead,
    sourceHead,
    claim,
    identity,
    placements,
    coordinator,
    execute,
    commandObservation,
    claims: cleanupState.claims,
    delegatedAuthorities,
    rootAdmission,
    dispose: async () => await disposeFixtureState(cleanupState),
  };
}

async function requestPublication(
  fixture: PublicationFixture,
  identity: WorkerConnectionIdentity = fixture.identity,
) {
  return await fixture.execute({
    identity,
    toolName: "github_publish",
    request: {
      toolCallId: TOOL_CALL_ID,
      title: TITLE,
      body: BODY,
    },
  });
}

function publicationRowCount(): number {
  if (!hasGitHubPublicationStore()) {
    return 0;
  }
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT COUNT(*) AS count FROM github_publication_requests")
    .get() as { count: number };
  return row.count;
}

async function expectRemoteUnchanged(fixture: PublicationFixture): Promise<void> {
  await expect(
    requireActual([
      "git",
      "--git-dir",
      fixture.bareRemote,
      "show-ref",
      "--verify",
      `refs/heads/${BRANCH}`,
    ]),
  ).rejects.toThrow();
  await expect(
    requireActual(["git", "--git-dir", fixture.bareRemote, "rev-parse", "refs/heads/main"]),
  ).resolves.toBe(fixture.baseHead);
  expect(fixture.commandObservation.pushArgs).toEqual([]);
  expect(fixture.commandObservation.postInputs).toEqual([]);
}

afterEach(async () => {
  for (const cleanup of activeFixtureCleanups) {
    await disposeFixtureState(cleanup);
  }
  commandHarness.run.mockReset();
  identityHarness.matches.mockReset();
  identityHarness.prepare.mockReset();
  identityHarness.refresh.mockReset();
});

describe("worker GitHub publication integration", () => {
  it("publishes the accepted workspace through the broker with exact Git and PR effects", async () => {
    const fixture = await createFixture();
    try {
      const response = await requestPublication(fixture);
      const requested = readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
        sessionId: SESSION_ID,
        idempotencyKey: TOOL_CALL_ID,
      });
      const expectedWorkerResult = {
        requestId: requested!.request_id,
        publisher: {
          source: PREPARED_IDENTITY.source,
          accountId: PREPARED_IDENTITY.account.accountId,
          login: PREPARED_IDENTITY.account.login,
        },
        status: "requested",
        message:
          "Publication was accepted. Finish the turn so the Gateway can reconcile and publish the workspace.",
      };
      expect(JSON.parse(response.resultJson)).toEqual({
        content: [{ type: "text", text: JSON.stringify(expectedWorkerResult, null, 2) }],
        details: expectedWorkerResult,
      });
      expect(response.resultJson).not.toContain(PREPARED_IDENTITY.env.GH_TOKEN!);
      expect(requested).toMatchObject({
        status: "requested",
        claim_id: CLAIM_ID,
        run_id: RUN_ID,
        source_head_commit: null,
        source_index_tree: null,
        workspace_tree: null,
      });

      fixture.placements.markWorkspaceResultPending(fixture.claim);
      await fixture.coordinator.prepareClaimWorkspace(fixture.claim);
      const prepared = readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
        requestId: requested!.request_id,
      });
      expect(prepared).toMatchObject({
        status: "requested",
        source_head_commit: fixture.sourceHead,
      });
      expect(prepared?.source_index_tree).toMatch(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
      expect(prepared?.workspace_tree).toMatch(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
      expect(fixture.placements.isWorkerTurnToolAuthorized(fixture.claim, "github_publish")).toBe(
        false,
      );

      fixture.placements.acceptWorkspaceResult(fixture.claim);
      const [published] = await fixture.coordinator.processClaim(fixture.claim);
      expect(published).toMatchObject({
        requestId: requested!.request_id,
        status: "published",
        repository: GITHUB_REPOSITORY,
        branch: BRANCH,
        url: "https://github.com/proof-owner/proof-repository/pull/1",
      });
      if (!published || published.status !== "published") {
        throw new Error("expected a published GitHub publication result");
      }
      const persisted = readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
        requestId: requested!.request_id,
      });
      expect(persisted).toMatchObject({
        status: "published",
        source_head_commit: fixture.sourceHead,
        workspace_tree: prepared!.workspace_tree,
        pull_request_url: "https://github.com/proof-owner/proof-repository/pull/1",
      });

      const remoteHead = await requireActual([
        "git",
        "--git-dir",
        fixture.bareRemote,
        "rev-parse",
        `refs/heads/${BRANCH}`,
      ]);
      expect(remoteHead).toBe(published.headCommit);
      await expect(
        requireActual(["git", "--git-dir", fixture.bareRemote, "rev-parse", `${remoteHead}^`]),
      ).resolves.toBe(fixture.sourceHead);
      await expect(
        requireActual([
          "git",
          "--git-dir",
          fixture.bareRemote,
          "rev-parse",
          `${remoteHead}^{tree}`,
        ]),
      ).resolves.toBe(prepared!.workspace_tree);
      await expect(
        requireActual(["git", "--git-dir", fixture.bareRemote, "show", `${remoteHead}:proof.txt`]),
      ).resolves.toBe("accepted staged bytes");
      await expect(
        requireActual([
          "git",
          "--git-dir",
          fixture.bareRemote,
          "show",
          `${remoteHead}:workspace.txt`,
        ]),
      ).resolves.toBe("accepted untracked bytes");
      await expect(
        requireActual([
          "git",
          "--git-dir",
          fixture.bareRemote,
          "show",
          `${remoteHead}:committed.txt`,
        ]),
      ).resolves.toBe("source commit bytes");
      await expect(
        requireActual([
          "git",
          "--git-dir",
          fixture.bareRemote,
          "show",
          "-s",
          "--format=%B",
          remoteHead,
        ]),
      ).resolves.toContain(`OpenClaw-Publication: ${requested!.request_id}`);
      await expect(
        requireActual(["git", "--git-dir", fixture.bareRemote, "rev-parse", "refs/heads/main"]),
      ).resolves.toBe(fixture.baseHead);

      expect(fixture.commandObservation.pushArgs).toHaveLength(1);
      expect(fixture.commandObservation.pushTokens).toEqual([TEST_GITHUB_TOKEN]);
      const refspec = fixture.commandObservation.pushArgs[0]!.at(-1);
      expect(refspec).toBe(`${remoteHead}:refs/heads/${BRANCH}`);
      expect(refspec).not.toContain("HEAD");
      expect(fixture.commandObservation.postRemoteHeads).toEqual([remoteHead]);
      expect(fixture.commandObservation.postTokens).toEqual([TEST_GITHUB_TOKEN]);
      expect(fixture.commandObservation.postInputs).toEqual([
        expect.objectContaining({
          title: TITLE,
          body: expect.stringContaining(`<!-- openclaw-publication:${requested!.request_id} -->`),
          head: `proof-owner:${BRANCH}`,
          base: "main",
          draft: true,
        }),
      ]);
      expect(publicationRowCount()).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    {
      label: "stale identity",
      mutate: async (fixture: PublicationFixture) => {
        const staleClaim = { ...fixture.claim, runId: "stale-run" };
        return {
          ...fixture.identity,
          runId: staleClaim.runId,
          turnClaim: staleClaim,
        };
      },
    },
    {
      label: "closed admission",
      mutate: async (fixture: PublicationFixture) => {
        fixture.placements.closeWorkerTurnToolAdmission(fixture.claim);
        return fixture.identity;
      },
    },
    {
      label: "reassigned claim",
      mutate: async (fixture: PublicationFixture) => {
        await fixture.placements.closeWorkerTurnToolState(fixture.claim);
        fixture.placements.releaseTurn(fixture.claim);
        const replacement = fixture.placements.claimTurn({
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: AGENT_ID,
          claimId: "replacement-claim",
          runId: "replacement-run",
          owner: {
            kind: "worker",
            environmentId: ENVIRONMENT_ID,
            ownerEpoch: OWNER_EPOCH,
          },
        });
        fixture.placements.authorizeWorkerTurnTools(replacement, ["github_publish"]);
        fixture.claims.push(replacement);
        const operationalRun = createOperationalRunInstanceRef(replacement.runId);
        fixture.delegatedAuthorities.push(claimAgentRunDelegatedAuthority(operationalRun));
        await fixture.rootAdmission.run(async () => {
          bindWorkerTurnOwner(
            fixture.placements,
            replacement,
            undefined,
            operationalRun,
            { agentId: AGENT_ID, sessionKey: SESSION_KEY },
            () => undefined,
          );
        });
        return fixture.identity;
      },
    },
  ])("rejects $label without publication state or external effects", async ({ mutate }) => {
    const fixture = await createFixture();
    try {
      const attemptedIdentity = await mutate(fixture);
      await expect(requestPublication(fixture, attemptedIdentity)).rejects.toThrow();
      expect(publicationRowCount()).toBe(0);
      await expectRemoteUnchanged(fixture);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects replaced operational authority with a live claim and zero publication effects", async () => {
    const fixture = await createFixture();
    const preparationStarted = createDeferredCore();
    const finishPreparation = createDeferredCore<PreparedGitHubPublicationIdentity>();
    identityHarness.prepare.mockImplementation(async () => {
      preparationStarted.resolve();
      return await finishPreparation.promise;
    });
    try {
      const publication = requestPublication(fixture);
      await preparationStarted.promise;
      expect(fixture.placements.validateTurnClaim(fixture.claim)).toBe(true);
      expect(fixture.placements.isWorkerTurnToolAuthorized(fixture.claim, "github_publish")).toBe(
        true,
      );

      const originalAuthority = fixture.delegatedAuthorities[0]!;
      expect(releaseAgentRunDelegatedAuthority(originalAuthority)).toBe(true);
      fixture.delegatedAuthorities.push(
        claimAgentRunDelegatedAuthority(originalAuthority.operationalRunInstance),
      );
      expect(fixture.placements.validateTurnClaim(fixture.claim)).toBe(true);
      expect(fixture.placements.isWorkerTurnToolAuthorized(fixture.claim, "github_publish")).toBe(
        true,
      );

      finishPreparation.resolve(PREPARED_IDENTITY);
      await expect(publication).rejects.toThrow("worker turn authority changed");
      expect(fixture.placements.validateTurnClaim(fixture.claim)).toBe(true);
      expect(fixture.placements.isWorkerTurnToolAuthorized(fixture.claim, "github_publish")).toBe(
        true,
      );
      expect(publicationRowCount()).toBe(0);
      await expectRemoteUnchanged(fixture);
    } finally {
      finishPreparation.resolve(PREPARED_IDENTITY);
      await fixture.dispose();
    }
  });
});
