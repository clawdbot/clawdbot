import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { runCommandBuffered } from "../process/exec.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  resolveGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import {
  githubPublicationBaseFetchArgs,
  githubPublicationBaseLineageArgs,
  githubPublicationBaseLookupArgs,
  parseGitHubPublicationBaseBranch,
  parseGitHubPublicationBaseRef,
} from "./github-publication-base.js";
import {
  assertGitHubPublicationRefCasCompleted,
  updateGitHubPublicationBranchAndIndex,
} from "./github-publication-git-index.js";
import {
  appendGitHubPublicationMessage,
  assertGitHubPublicationBranchRef,
  githubPublicationPushArgs,
  githubPublicationRemoteHeadArgs,
  githubPublicationUpdateRefArgs,
} from "./github-publication-git-transport.js";
import {
  githubPublicationCreatePullRequestArgs,
  githubPublicationPullRequestLookupArgs,
  parseGitHubPublicationPullRequests,
} from "./github-publication-pull-requests.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { resolveGitHubRepositoryTarget } from "./github-repository-target.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";

const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_OUTPUT_LIMIT = 256 * 1024;
const PUBLICATION_MARKER = "OpenClaw-Publication";

type PublicationRow = StateDatabase["github_publication_requests"];
type PublicationFailureCode = Extract<SessionGitHubPublicationResult, { status: "failed" }>["code"];

export function matchesGitHubPublicationIdentityRow(
  row: PublicationRow,
  identity: PreparedGitHubPublicationIdentity,
): boolean {
  return (
    row.identity_source === identity.source &&
    row.identity_profile_id === (identity.profileId ?? null) &&
    row.identity_account_id === identity.account.accountId &&
    row.identity_login.toLowerCase() === identity.account.login.toLowerCase()
  );
}

async function runCommand(
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
) {
  return await runCommandBuffered(argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_LIMIT,
  });
}

async function requireCommand(
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<string> {
  const result = await runCommand(argv, options);
  if (result.code !== 0) {
    throw new Error(`${argv[0]} command failed`);
  }
  return result.stdout.toString("utf8").trim();
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return parsed;
}

async function assertSafeGitPublicationConfig(cwd: string): Promise<void> {
  const unsafe = await runCommand(
    [
      "git",
      "config",
      "--includes",
      "--get-regexp",
      "^(filter\\..*|url\\..*\\.(insteadof|pushinsteadof)|include(if)?\\..*|http\\..*|push\\..*|core\\.worktree)$",
    ],
    {
      cwd,
      env: { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull },
    },
  );
  if (unsafe.code !== 1 || unsafe.stdout.length > 0) {
    throw new Error("GitHub publication workspace has unsupported Git transport configuration.");
  }
}

export async function captureGitHubPublicationWorkspaceSnapshot(params: {
  cwd: string;
  assertCurrent?: () => void;
}): Promise<{ sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string }> {
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    params.assertCurrent?.();
    const result = await operation();
    params.assertCurrent?.();
    return result;
  };
  await step(async () => await assertSafeGitPublicationConfig(params.cwd));
  const sourceHeadCommit = await step(
    async () =>
      await requireCommand(["git", "rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: params.cwd,
      }),
  );
  const sourceIndexTree = await step(
    async () =>
      await requireCommand(
        ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", "write-tree"],
        { cwd: params.cwd },
      ),
  );
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-snapshot-"));
  try {
    const env: NodeJS.ProcessEnv = {
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_INDEX_FILE: path.join(tempDir, "index"),
    };
    await step(async () => {
      await requireCommand(
        [
          "git",
          "-c",
          `core.hooksPath=${os.devNull}`,
          "-c",
          "core.fsmonitor=false",
          "read-tree",
          sourceHeadCommit,
        ],
        { cwd: params.cwd, env },
      );
    });
    await step(async () => {
      await requireCommand(
        ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", "add", "-A"],
        { cwd: params.cwd, env },
      );
    });
    const workspaceTree = await step(
      async () =>
        await requireCommand(
          ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", "write-tree"],
          { cwd: params.cwd, env },
        ),
    );
    return { sourceHeadCommit, sourceIndexTree, workspaceTree };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function resolveGitHubPublicationFailure(error: unknown): {
  code: PublicationFailureCode;
  nextAction: string;
} {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("identity")) {
    return {
      code: message.includes("changed") ? "identity_changed" : "identity_unavailable",
      nextAction:
        "Reconnect the GitHub identity in Agents → Tools, then request publication again.",
    };
  }
  if (message.includes("session") || message.includes("worktree owner")) {
    return {
      code: "session_changed",
      nextAction: "Open the current session worktree and request publication again.",
    };
  }
  if (message.includes("workspace") || message.includes("branch changed")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Wait for the current turn to finish, inspect the reconciled workspace, and retry.",
    };
  }
  if (message.includes("not a git")) {
    return { code: "not_git", nextAction: "Use a session-owned Git worktree to publish." };
  }
  if (message.includes("GitHub remote")) {
    return { code: "not_github", nextAction: "Use a GitHub repository remote to publish." };
  }
  if (message.includes("no changes")) {
    return { code: "no_changes", nextAction: "Make or restore a repository change, then retry." };
  }
  if (message.includes("push")) {
    return {
      code: "push_rejected",
      nextAction:
        "Check repository write access and branch drift, then retry without force-pushing.",
    };
  }
  if (message.includes("pull request") || message.includes("GitHub")) {
    return {
      code: "github_rejected",
      nextAction: "Check pull-request permission for the effective account, then retry.",
    };
  }
  return { code: "unavailable", nextAction: "Retry after the Gateway and GitHub are available." };
}

export async function executeGitHubPublication(params: {
  initial: PublicationRow;
  validateAuthority: () => boolean;
  projectResult: (row: PublicationRow) => SessionGitHubPublicationResult;
  bindWorkspaceSnapshot: (input: {
    row: PublicationRow;
    sourceHeadCommit: string;
    sourceIndexTree: string;
    workspaceTree: string;
  }) => PublicationRow;
  updatePublishingFacts: (input: {
    row: PublicationRow;
    repository: string;
    branch: string;
    baseBranch: string;
    sourceHeadCommit: string;
    workspaceTree: string;
    headCommit: string;
  }) => PublicationRow;
  complete: (row: PublicationRow, result: SessionGitHubPublicationResult) => PublicationRow;
}): Promise<SessionGitHubPublicationResult> {
  const { initial } = params;
  if (initial.status === "published" || initial.status === "failed") {
    return params.projectResult(initial);
  }
  let activeIdentity: PreparedGitHubPublicationIdentity | undefined;
  const currentWorktree = () =>
    resolveGitHubPublicationWorktreeOwner({
      sessionId: initial.session_id,
      sessionKey: initial.session_key,
      agentId: initial.agent_id,
      expected: {
        worktreeId: initial.worktree_id,
        repositoryFingerprint: initial.repository_fingerprint,
        branch: initial.branch,
      },
    });
  const assertAuthority = () => {
    if (!params.validateAuthority()) {
      throw new Error("GitHub publication session authority changed.");
    }
    currentWorktree();
    if (
      activeIdentity &&
      !matchesCurrentGitHubPublicationIdentity({
        agentId: initial.agent_id,
        identity: activeIdentity,
      })
    ) {
      throw new Error("GitHub publication identity changed.");
    }
  };
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertAuthority();
    const value = await operation();
    assertAuthority();
    return value;
  };
  try {
    assertAuthority();
    const { loaded, worktree } = currentWorktree();
    const repositoryIdentity = await step(
      async () => await managedWorktrees.resolveRepositoryIdentity(worktree.path),
    );
    if (
      repositoryIdentity.checkoutRoot !== worktree.path ||
      repositoryIdentity.repoRoot !== worktree.repoRoot ||
      repositoryIdentity.fingerprint !== worktree.repoFingerprint
    ) {
      throw new Error("GitHub publication workspace repository changed.");
    }
    const remote = parseGitHubRemoteUrl(repositoryIdentity.originUrl);
    if (
      !remote ||
      !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
      !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
    ) {
      throw new Error("GitHub publication requires a GitHub remote.");
    }
    const pushRepository = `${remote.owner}/${remote.repo}`;
    const branch = await step(
      async () =>
        await requireCommand(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
          cwd: worktree.path,
        }),
    );
    if (branch !== worktree.branch) {
      throw new Error("GitHub publication branch changed.");
    }
    let row = initial;
    let sourceHeadCommit = row.source_head_commit;
    let sourceIndexTree = row.source_index_tree;
    let workspaceTree = row.workspace_tree;
    if (!sourceHeadCommit || !sourceIndexTree || !workspaceTree) {
      const snapshot = await captureGitHubPublicationWorkspaceSnapshot({
        cwd: worktree.path,
        assertCurrent: assertAuthority,
      });
      row = params.bindWorkspaceSnapshot({ row, ...snapshot });
      sourceHeadCommit = snapshot.sourceHeadCommit;
      sourceIndexTree = snapshot.sourceIndexTree;
      workspaceTree = snapshot.workspaceTree;
    }
    let headCommit = await step(
      async () =>
        await requireCommand(["git", "rev-parse", "--verify", "HEAD^{commit}"], {
          cwd: worktree.path,
        }),
    );
    const refreshIdentity = async (): Promise<PreparedGitHubPublicationIdentity> => {
      const identity = await step(
        async () => await prepareCurrentGitHubPublicationIdentity(initial.agent_id),
      );
      if (!matchesGitHubPublicationIdentityRow(initial, identity)) {
        throw new Error("GitHub publication identity changed.");
      }
      activeIdentity = identity;
      assertAuthority();
      return identity;
    };
    let identity = await refreshIdentity();
    const repositoryTarget = resolveGitHubRepositoryTarget(
      parseJsonObject(
        await step(
          async () =>
            await requireCommand(
              [
                "gh",
                "api",
                "--hostname",
                "github.com",
                `repos/${pushRepository}`,
                "--jq",
                "{fork, default_branch, parent: {name: .parent.name, default_branch: .parent.default_branch, owner: {login: .parent.owner.login}}}",
              ],
              { env: identity.env },
            ),
        ),
        "GitHub repository lookup",
      ),
      { owner: remote.owner, repo: remote.repo },
    );
    if (!repositoryTarget) {
      throw new Error("GitHub repository response omitted its publication target.");
    }
    const repository = `${repositoryTarget.pullRequest.owner}/${repositoryTarget.pullRequest.repo}`;
    const baseBranch = repositoryTarget.fork
      ? repositoryTarget.pullRequest.defaultBranch
      : parseGitHubPublicationBaseBranch(
          worktree.baseRef,
          repositoryTarget.pullRequest.defaultBranch,
        );
    if (!repositoryTarget.fork && branch === baseBranch) {
      throw new Error("GitHub publication branch changed to its pull request base.");
    }
    const remoteBaseResult = await step(
      async () =>
        await runCommand(githubPublicationBaseLookupArgs(repository, baseBranch), {
          env: identity.env,
        }),
    );
    if (remoteBaseResult.code !== 0) {
      throw new Error("GitHub publication workspace base branch could not be verified.");
    }
    const remoteBaseSha = parseGitHubPublicationBaseRef(
      remoteBaseResult.stdout.toString("utf8"),
      baseBranch,
    );
    await step(async () => await assertSafeGitPublicationConfig(worktree.path));
    identity = await refreshIdentity();
    const baseTransportEnv = {
      ...identity.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
    };
    const baseFetched = await step(
      async () =>
        await runCommand(githubPublicationBaseFetchArgs(repository, remoteBaseSha), {
          cwd: worktree.path,
          env: baseTransportEnv,
        }),
    );
    if (baseFetched.code !== 0) {
      throw new Error("GitHub publication workspace base could not be materialized.");
    }
    const baseCandidates = [worktree.baseRef, `refs/remotes/origin/${baseBranch}`];
    let baseCommit: string | undefined;
    for (const candidate of baseCandidates) {
      const resolved = await step(
        async () =>
          await runCommand(
            ["git", "rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`],
            { cwd: worktree.path },
          ),
      );
      if (resolved.code === 0) {
        baseCommit = resolved.stdout.toString("utf8").trim();
        break;
      }
    }
    if (!baseCommit) {
      throw new Error("GitHub publication workspace base could not be verified.");
    }
    const localBaseOwnsRemote = await step(
      async () =>
        await runCommand(githubPublicationBaseLineageArgs(baseCommit, remoteBaseSha), {
          cwd: worktree.path,
        }),
    );
    const localBaseOwnsSource = await step(
      async () =>
        await runCommand(githubPublicationBaseLineageArgs(baseCommit, sourceHeadCommit), {
          cwd: worktree.path,
        }),
    );
    if (localBaseOwnsRemote.code !== 0 || localBaseOwnsSource.code !== 0) {
      throw new Error("GitHub publication workspace base lineage could not be verified.");
    }
    const baseTree = await step(
      async () =>
        await requireCommand(["git", "rev-parse", `${remoteBaseSha}^{tree}`], {
          cwd: worktree.path,
        }),
    );
    if (baseTree === workspaceTree) {
      throw new Error("GitHub publication has no changes to publish.");
    }
    const marker = `${PUBLICATION_MARKER}: ${row.request_id}`;
    const pullRequestMarker = `<!-- openclaw-publication:${row.request_id} -->`;
    const loadOpenPullRequests = async () => {
      const lookupIdentity = await refreshIdentity();
      const raw = await requireCommand(
        githubPublicationPullRequestLookupArgs({
          repository,
          owner: repositoryTarget.push.owner,
          branch,
          baseBranch,
        }),
        { env: lookupIdentity.env },
      );
      const candidates = parseGitHubPublicationPullRequests(raw);
      return {
        accountId: lookupIdentity.account.accountId,
        candidates,
      };
    };
    const initialPullRequests = await step(loadOpenPullRequests);
    const occupiedPullRequest = initialPullRequests.candidates.find(
      (candidate) =>
        candidate.state === "open" &&
        candidate.headRef === branch &&
        candidate.baseRef === baseBranch,
    );
    if (occupiedPullRequest && occupiedPullRequest.userId !== initialPullRequests.accountId) {
      throw new Error("GitHub pull request is owned by another account.");
    }
    row = params.updatePublishingFacts({
      row,
      repository,
      branch,
      baseBranch,
      sourceHeadCommit,
      workspaceTree,
      headCommit,
    });

    const currentMessage = await step(
      async () =>
        await requireCommand(["git", "show", "-s", "--format=%B", "HEAD"], {
          cwd: worktree.path,
        }),
    );
    const markerPresent = currentMessage.split(/\r?\n/u).includes(marker);
    const currentTree = await step(
      async () => await requireCommand(["git", "rev-parse", "HEAD^{tree}"], { cwd: worktree.path }),
    );
    let updateBranchRef: (() => Promise<void>) | undefined;
    if (markerPresent) {
      const markerParent = await step(
        async () => await requireCommand(["git", "rev-parse", "HEAD^"], { cwd: worktree.path }),
      );
      if (markerParent !== sourceHeadCommit || currentTree !== workspaceTree) {
        throw new Error("GitHub publication workspace changed after its accepted snapshot.");
      }
    } else {
      if (headCommit !== sourceHeadCommit) {
        throw new Error("GitHub publication workspace changed after its accepted snapshot.");
      }
      await step(async () => {
        await requireCommand(["git", "cat-file", "-e", `${workspaceTree}^{tree}`], {
          cwd: worktree.path,
        });
      });
      const attribution = resolveGitCoauthorAttribution({
        agentId: row.agent_id,
        config: currentGitHubPublicationConfig(),
        excludeAccountId: identity.account.accountId,
        sessionKey: row.session_key,
        storePath: loaded.storePath,
      });
      const title = row.title?.trim() || `Publish ${branch}`;
      const message = appendGitHubPublicationMessage(title, [
        ...(attribution?.trailers ?? []),
        marker,
      ]);
      const timestamp = new Date(row.created_at_ms).toISOString();
      identity = await refreshIdentity();
      const authorEnv = {
        ...identity.env,
        GIT_AUTHOR_NAME: identity.account.login,
        GIT_COMMITTER_NAME: identity.account.login,
        GIT_AUTHOR_EMAIL: `${identity.account.accountId}+${identity.account.login}@users.noreply.github.com`,
        GIT_COMMITTER_EMAIL: `${identity.account.accountId}+${identity.account.login}@users.noreply.github.com`,
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
      };
      const commit = await step(
        async () =>
          await requireCommand(["git", "commit-tree", workspaceTree, "-p", headCommit], {
            cwd: worktree.path,
            env: authorEnv,
            input: `${message}\n`,
          }),
      );
      await assertGitHubPublicationBranchRef(branch, async (argv) => {
        return (await step(async () => await runCommand(argv, { cwd: worktree.path }))).code ?? -1;
      });
      const previousHead = headCommit;
      updateBranchRef = async () => {
        const result = await runCommand(
          githubPublicationUpdateRefArgs(branch, commit, previousHead),
          { cwd: worktree.path },
        );
        assertGitHubPublicationRefCasCompleted(result);
      };
      headCommit = commit;
    }
    await updateGitHubPublicationBranchAndIndex({
      cwd: worktree.path,
      sourceIndexTree,
      workspaceTree,
      headCommit,
      env: identity.env,
      assertCurrent: assertAuthority,
      run: async (argv, options) => await step(async () => await requireCommand(argv, options)),
      ...(updateBranchRef ? { updateRef: updateBranchRef } : {}),
    });
    row = params.updatePublishingFacts({
      row,
      repository,
      branch,
      baseBranch,
      sourceHeadCommit,
      workspaceTree,
      headCommit,
    });

    await step(async () => await assertSafeGitPublicationConfig(worktree.path));
    const httpsRemote = `https://github.com/${pushRepository}.git`;
    identity = await refreshIdentity();
    let transportEnv = {
      ...identity.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
    };
    const pushArgs = [
      "git",
      "-c",
      `core.hooksPath=${os.devNull}`,
      ...githubPublicationPushArgs(httpsRemote, headCommit, branch).slice(1),
    ];
    const observeRemoteHead = async () => {
      const observed = await requireCommand(githubPublicationRemoteHeadArgs(httpsRemote, branch), {
        cwd: worktree.path,
        env: transportEnv,
      });
      return observed.split(/\s+/u)[0] ?? "";
    };
    let remoteHead = await step(observeRemoteHead);
    if (remoteHead !== headCommit) {
      const pushed = await step(
        async () => await runCommand(pushArgs, { cwd: worktree.path, env: transportEnv }),
      );
      identity = await refreshIdentity();
      transportEnv = {
        ...identity.env,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
      };
      remoteHead = await step(observeRemoteHead);
      if (remoteHead !== headCommit) {
        throw new Error(
          pushed.code === 0 ? "GitHub push verification failed." : "GitHub push was rejected.",
        );
      }
    }

    const findPullRequest = async (): Promise<string | undefined> => {
      const pullRequests = await loadOpenPullRequests();
      const exact = pullRequests.candidates.find(
        (candidate) =>
          candidate.userId === pullRequests.accountId &&
          candidate.headSha === headCommit &&
          candidate.headRef === branch &&
          candidate.baseRef === baseBranch &&
          (candidate.state === "open" || candidate.body.includes(pullRequestMarker)),
      );
      return exact?.url;
    };
    let pullRequestUrl = await step(findPullRequest);
    if (!pullRequestUrl) {
      const attribution = resolveGitCoauthorAttribution({
        agentId: row.agent_id,
        config: currentGitHubPublicationConfig(),
        excludeAccountId: identity.account.accountId,
        sessionKey: row.session_key,
        storePath: loaded.storePath,
      });
      const participantCredit = attribution?.logins.length
        ? `\n\n## Participants\n\n${attribution.logins.map((login) => `- @${login}`).join("\n")}`
        : "";
      const body = `${row.body?.trim() || "Published by the Gateway after authoritative workspace reconciliation."}${participantCredit}\n\n<!-- openclaw-publication:${row.request_id} -->`;
      identity = await refreshIdentity();
      const created = await step(
        async () =>
          await runCommand(githubPublicationCreatePullRequestArgs(repository), {
            env: identity.env,
            input: JSON.stringify({
              title: row.title?.trim() || `Publish ${branch}`,
              body,
              head: `${repositoryTarget.push.owner}:${branch}`,
              base: baseBranch,
              draft: true,
            }),
          }),
      );
      if (created.code === 0) {
        pullRequestUrl = readNonBlankString(
          parseJsonObject(created.stdout.toString("utf8"), "GitHub pull request creation").html_url,
        );
      }
      pullRequestUrl ??= await step(findPullRequest);
    }
    if (!pullRequestUrl) {
      throw new Error("GitHub pull request creation was rejected.");
    }
    return params.projectResult(
      params.complete(row, {
        requestId: row.request_id,
        status: "published",
        url: pullRequestUrl,
        repository,
        branch,
        headCommit,
      }),
    );
  } catch (error) {
    const failure = resolveGitHubPublicationFailure(error);
    const result = params.projectResult(
      params.complete(initial, {
        requestId: initial.request_id,
        status: "failed",
        code: failure.code,
        message: "GitHub publication failed.",
        nextAction: failure.nextAction,
      }),
    );
    if (error instanceof SessionMutationAuthorizationChangedError) {
      throw error;
    }
    return result;
  }
}
