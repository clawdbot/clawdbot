import os from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
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
  githubPublicationBranchCreationArgs,
  parseGitHubPublicationBaseBranch,
  parseGitHubPublicationBaseRef,
} from "./github-publication-base.js";
import {
  GitHubPublicationDestinationOccupiedError,
  resolveGitHubPublicationFailure,
} from "./github-publication-failure.js";
import {
  GitHubPublicationRecoveryPendingError,
  assertGitHubPublicationRefCasCompleted,
  updateGitHubPublicationBranchAndIndex,
} from "./github-publication-git-index.js";
import {
  appendGitHubPublicationMessage,
  assertSafeGitPublicationWorkspace,
  assertGitHubPublicationBranchRef,
  captureGitHubPublicationWorkspaceSnapshot,
  githubPublicationPushArgs,
  githubPublicationRemoteHeadArgs,
  githubPublicationUpdateRefArgs,
  requirePublicationCommand as requireCommand,
  runPublicationCommand as runCommand,
} from "./github-publication-git-transport.js";
import {
  githubPublicationCreatePullRequestArgs,
  githubPublicationPullRequestLookupArgs,
  parseGitHubPublicationPullRequests,
  resolveGitHubPublicationPullRequestUrl,
} from "./github-publication-pull-requests.js";
import { recoverGitHubPublicationWorkspace } from "./github-publication-recovery.js";
import {
  bindGitHubPublicationDestination,
  ownsGitHubPublicationDestination,
} from "./github-publication-store.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { resolveGitHubRepositoryTarget } from "./github-repository-target.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";

const PUBLICATION_MARKER = "OpenClaw-Publication";

type PublicationRow = StateDatabase["github_publication_requests"];

class GitHubPublicationAuthorityLostError extends Error {}

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
    baseBranch: string;
    headCommit: string;
  }) => PublicationRow;
  complete: (row: PublicationRow, result: SessionGitHubPublicationResult) => PublicationRow;
  defer?: (row: PublicationRow) => PublicationRow;
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
        branch: initial.source_branch,
      },
    });
  const assertAuthority = () => {
    if (!params.validateAuthority()) {
      throw new GitHubPublicationAuthorityLostError(
        "GitHub publication session authority changed.",
      );
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
    const { loaded, worktree } = currentWorktree();
    await step(async () => await assertSafeGitPublicationWorkspace(worktree.path, runCommand));
    await step(
      async () => await recoverGitHubPublicationWorkspace(initial, requireCommand, assertAuthority),
    );
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
    const sourceBranch = await step(
      async () =>
        await requireCommand(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
          cwd: worktree.path,
        }),
    );
    if (sourceBranch !== worktree.branch) {
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
    await step(async () => await assertSafeGitPublicationWorkspace(worktree.path, runCommand));
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
    const creation = await step(
      async () =>
        await runCommand(githubPublicationBranchCreationArgs(sourceBranch), {
          cwd: worktree.path,
        }),
    );
    const creationEntries = creation.stdout.toString("utf8").trim().split(/\r?\n/u);
    const creationBase = creationEntries.at(-1) ?? "";
    if (creation.code !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(creationBase)) {
      throw new Error("GitHub publication workspace creation base could not be verified.");
    }
    const creationOwnsRemote = await step(
      async () =>
        await runCommand(githubPublicationBaseLineageArgs(creationBase, remoteBaseSha), {
          cwd: worktree.path,
        }),
    );
    const creationOwnsSource = await step(
      async () =>
        await runCommand(githubPublicationBaseLineageArgs(creationBase, sourceHeadCommit), {
          cwd: worktree.path,
        }),
    );
    if (creationOwnsRemote.code !== 0 || creationOwnsSource.code !== 0) {
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
    assertAuthority();
    row = bindGitHubPublicationDestination({
      row,
      repository,
      entry: currentWorktree().loaded.entry,
    });
    const branch = row.branch;
    if (!repositoryTarget.fork && (sourceBranch === baseBranch || branch === baseBranch)) {
      throw new Error("GitHub publication branch changed to its pull request base.");
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
    const config = currentGitHubPublicationConfig();
    const attribution = resolveGitCoauthorAttribution({
      agentId: row.agent_id,
      config,
      excludeAccountId: identity.account.accountId,
      sessionKey: row.session_key,
      storePath: loaded.storePath,
    });
    const contributorCredit = attribution?.logins.map((login) => `- @${login}`).join("\n");
    const previousBranchHead = headCommit;
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
      const title = row.title?.trim() || `Publish ${branch}`;
      const commitBody = contributorCredit
        ? `${title}\n\nWorked on by:\n${contributorCredit}`
        : title;
      const message = appendGitHubPublicationMessage(commitBody, [
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
          await requireCommand(
            ["git", "commit-tree", "--no-gpg-sign", workspaceTree, "-p", headCommit],
            {
              cwd: worktree.path,
              env: authorEnv,
              input: `${message}\n`,
            },
          ),
      );
      await assertGitHubPublicationBranchRef(sourceBranch, async (argv) => {
        return (await step(async () => await runCommand(argv, { cwd: worktree.path }))).code ?? -1;
      });
      const previousHead = headCommit;
      updateBranchRef = async () => {
        const result = await runCommand(
          githubPublicationUpdateRefArgs(sourceBranch, commit, previousHead),
          { cwd: worktree.path },
        );
        assertGitHubPublicationRefCasCompleted(result);
      };
      headCommit = commit;
    }
    await updateGitHubPublicationBranchAndIndex({
      cwd: worktree.path,
      requestId: row.request_id,
      branch: sourceBranch,
      previousHead: previousBranchHead,
      sourceIndexTree,
      workspaceTree,
      headCommit,
      env: identity.env,
      assertCurrent: assertAuthority,
      run: async (argv, options) => await step(async () => await requireCommand(argv, options)),
      ...(updateBranchRef ? { updateRef: updateBranchRef } : {}),
    });
    // Only the validated publication commit proves a recoverable remote candidate;
    // recording the source HEAD earlier would claim an unrelated occupied branch.
    row = params.updatePublishingFacts({
      row,
      baseBranch,
      headCommit,
    });

    await step(async () => await assertSafeGitPublicationWorkspace(worktree.path, runCommand));
    const httpsRemote = `https://github.com/${pushRepository}.git`;
    identity = await refreshIdentity();
    let transportEnv = {
      ...identity.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
    };
    const observeRemoteHead = async () => {
      const observed = await requireCommand(githubPublicationRemoteHeadArgs(httpsRemote, branch), {
        cwd: worktree.path,
        env: transportEnv,
      });
      return observed.split(/\s+/u)[0] ?? "";
    };
    let remoteHead = await step(observeRemoteHead);
    if (remoteHead !== headCommit) {
      const namedDestination = branch !== sourceBranch;
      if (namedDestination && remoteHead) {
        if (!ownsGitHubPublicationDestination(row, remoteHead)) {
          throw new GitHubPublicationDestinationOccupiedError(
            "GitHub push destination is occupied by another publication.",
          );
        }
        const ancestry = await step(
          async () =>
            await runCommand(githubPublicationBaseLineageArgs(remoteHead, headCommit), {
              cwd: worktree.path,
            }),
        );
        if (ancestry.code !== 0) {
          throw new Error("GitHub push destination has diverged.");
        }
      }
      const pushArgs = githubPublicationPushArgs(
        httpsRemote,
        headCommit,
        branch,
        namedDestination ? remoteHead : undefined,
      );
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
      return resolveGitHubPublicationPullRequestUrl(pullRequests.candidates, {
        accountId: pullRequests.accountId,
        headCommit,
        branch,
        baseBranch,
        marker: pullRequestMarker,
      });
    };
    let pullRequestUrl = await step(findPullRequest);
    if (!pullRequestUrl) {
      const sessionUrl = resolveControlUiSessionUrl(config, {
        sessionKey: row.session_key,
        fallbackAgentId: row.agent_id,
        exactKey: true,
      });
      const description = (
        row.body?.trim() || "Published by the Gateway after authoritative workspace reconciliation."
      )
        .replace(/(?:\s*---\s*\n\[View the OpenClaw team session\]\([^\r\n)]*\)\s*)+$/u, "")
        .replace(
          /(?:^|\n\n)## Worked on by\n\n(?:- @[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\n)*- @[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?=\n\n|$)/gu,
          "",
        )
        .trimEnd();
      const participantCredit = contributorCredit
        ? `\n\n## Worked on by\n\n${contributorCredit}`
        : "";
      const footer = sessionUrl?.startsWith("https://")
        ? `\n\n---\n[View the OpenClaw team session](${sessionUrl})`
        : "";
      const body = `${description}${participantCredit}\n\n${pullRequestMarker}${footer}`;
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
    if (error instanceof GitHubPublicationRecoveryPendingError) {
      throw error;
    }
    if (error instanceof GitHubPublicationAuthorityLostError && params.defer) {
      return params.projectResult(params.defer(initial));
    }
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
