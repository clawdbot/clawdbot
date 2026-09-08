import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import {
  currentGitHubPublicationConfig,
  resolveLocalGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import {
  githubPublicationBaseFetchArgs,
  githubPublicationBaseLineageArgs,
  githubPublicationBaseLookupArgs,
  githubPublicationBranchCreationArgs,
  parseGitHubPublicationBaseRef,
} from "./github-publication-base.js";
import {
  createGitHubPublicationExecutionIdentity,
  GitHubPublicationAuthorityLostError,
} from "./github-publication-execution-identity.js";
import {
  GitHubPublicationKnownFailure,
  GitHubPublicationWorkspaceChangedError,
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
  createGitHubPublicationCommandRunner,
  githubPublicationPushArgs,
  githubPublicationRemoteHeadArgs,
  githubPublicationUpdateRefArgs,
  requirePublicationCommand as requireCommand,
  runPublicationCommand as runCommand,
} from "./github-publication-git-transport.js";
import {
  githubPublicationCreatePullRequestArgs,
  findGitHubPublicationPullRequest,
} from "./github-publication-pull-requests.js";
import { recoverGitHubPublicationWorkspace } from "./github-publication-recovery.js";
import type { GitHubPublicationExecutionRow } from "./github-publication-store.js";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";

const PUBLICATION_MARKER = "OpenClaw-Publication";

type PublicationRow = GitHubPublicationExecutionRow;

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

export async function executeGitHubPublication<Row extends PublicationRow>(params: {
  initial: Row;
  identity?: {
    prepare: () => Promise<PreparedGitHubPublicationIdentity>;
    isCurrent: (identity: PreparedGitHubPublicationIdentity) => boolean;
  };
  target?: { pushRepository: string; repository: string; baseBranch: string };
  recordEffect?: (
    effect: "push" | "pull_request",
    observed?: { headCommit?: string; url?: string },
  ) => void;
  validateAuthority: () => boolean;
  projectResult: (row: Row) => SessionGitHubPublicationResult;
  bindWorkspaceSnapshot: (input: {
    row: Row;
    sourceHeadCommit: string;
    sourceIndexTree: string;
    workspaceTree: string;
  }) => Row;
  updatePublishingFacts: (input: {
    row: Row;
    repository: string;
    branch: string;
    baseBranch: string;
    sourceHeadCommit: string;
    workspaceTree: string;
    headCommit: string;
  }) => Row;
  complete: (row: Row, result: SessionGitHubPublicationResult) => Row;
  defer?: (row: Row) => Row;
  interrupt?: () => Row;
}): Promise<SessionGitHubPublicationResult> {
  const { initial } = params;
  if (initial.status === "published" || initial.status === "failed") {
    return params.projectResult(initial);
  }
  let effectPending = false;
  const currentWorktree = () => resolveLocalGitHubPublicationWorktreeOwner(initial);
  const { assertCurrent: assertAuthority, refreshIdentity } =
    createGitHubPublicationExecutionIdentity({
      row: initial,
      identity: params.identity,
      validateAuthority: params.validateAuthority,
      assertWorkspace: () => {
        currentWorktree();
      },
    });
  const { step, run, require: command } = createGitHubPublicationCommandRunner(assertAuthority);
  try {
    const { loaded, worktree } = currentWorktree();
    await step(() => assertSafeGitPublicationWorkspace(worktree.path, runCommand));
    await step(() => recoverGitHubPublicationWorkspace(initial, requireCommand, assertAuthority));
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
    if (row.identity_source === "personal") {
      // Recover the request-owned index first. Confirmation must then validate the
      // live workspace inside this execution so a proven mismatch becomes its retained result.
      let snapshot;
      try {
        snapshot = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: worktree.path,
          assertCurrent: assertAuthority,
        });
      } catch (error) {
        // Failed observation is not proof of drift; leave the original request reconfirmable.
        throw new GitHubPublicationRecoveryPendingError(
          "My GitHub workspace snapshot could not be verified; retry confirmation after local Git operations finish.",
          { cause: error },
        );
      }
      if (
        snapshot.workspaceTree !== workspaceTree ||
        (snapshot.sourceIndexTree !== sourceIndexTree && snapshot.sourceIndexTree !== workspaceTree)
      ) {
        throw new GitHubPublicationWorkspaceChangedError(
          "GitHub publication workspace changed after its accepted snapshot.",
        );
      }
    }
    let headCommit = await command(["git", "rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: worktree.path,
    });
    let identity = await refreshIdentity();
    const { pushRepository, repository, branch, baseBranch, pushOwner } =
      await prepareGitHubPublicationTarget({ worktree, identity, assertCurrent: assertAuthority });
    if (
      params.target &&
      (params.target.pushRepository !== pushRepository ||
        params.target.repository !== repository ||
        params.target.baseBranch !== baseBranch)
    ) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication accepted repository target changed.",
      );
    }
    const remoteBaseResult = await run(githubPublicationBaseLookupArgs(repository, baseBranch), {
      env: identity.env,
    });
    if (remoteBaseResult.code !== 0) {
      throw new Error("GitHub publication workspace base branch could not be verified.");
    }
    const remoteBaseSha = parseGitHubPublicationBaseRef(
      remoteBaseResult.stdout.toString("utf8"),
      baseBranch,
    );
    await step(() => assertSafeGitPublicationWorkspace(worktree.path, runCommand));
    identity = await refreshIdentity();
    const baseTransportEnv = {
      ...identity.env,
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    };
    const baseFetched = await run(githubPublicationBaseFetchArgs(repository, remoteBaseSha), {
      cwd: worktree.path,
      env: baseTransportEnv,
    });
    if (baseFetched.code !== 0) {
      throw new Error("GitHub publication workspace base could not be materialized.");
    }
    const creation = await run(githubPublicationBranchCreationArgs(branch), { cwd: worktree.path });
    const creationEntries = creation.stdout.toString("utf8").trim().split(/\r?\n/u);
    const creationBase = creationEntries.at(-1) ?? "";
    if (creation.code !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(creationBase)) {
      throw new Error("GitHub publication workspace creation base could not be verified.");
    }
    const creationOwnsRemote = await run(
      githubPublicationBaseLineageArgs(creationBase, remoteBaseSha),
      { cwd: worktree.path },
    );
    const creationOwnsSource = await run(
      githubPublicationBaseLineageArgs(creationBase, sourceHeadCommit),
      { cwd: worktree.path },
    );
    if (creationOwnsRemote.code !== 0 || creationOwnsSource.code !== 0) {
      throw new Error("GitHub publication workspace base lineage could not be verified.");
    }
    const baseTree = await command(["git", "rev-parse", `${remoteBaseSha}^{tree}`], {
      cwd: worktree.path,
    });
    if (baseTree === workspaceTree) {
      throw new GitHubPublicationKnownFailure("GitHub publication has no changes to publish.", {
        code: "no_changes",
        nextAction: "Make or restore a repository change, then retry.",
      });
    }
    const marker = `${PUBLICATION_MARKER}: ${row.request_id}`;
    const pullRequestMarker = `<!-- openclaw-publication:${row.request_id} -->`;
    const findPullRequest = () =>
      findGitHubPublicationPullRequest({
        repository,
        pushOwner,
        branch,
        baseBranch,
        headCommit,
        marker: pullRequestMarker,
        refreshIdentity,
        recordObserved: (url) => {
          params.recordEffect?.("pull_request", { url });
          effectPending = false;
        },
        assertCurrent: assertAuthority,
      });
    const currentMessage = await command(["git", "show", "-s", "--format=%B", "HEAD"], {
      cwd: worktree.path,
    });
    const markerPresent = currentMessage.split(/\r?\n/u).includes(marker);
    const currentTree = await command(["git", "rev-parse", "HEAD^{tree}"], { cwd: worktree.path });
    if (markerPresent) {
      const markerParent = await command(["git", "rev-parse", "HEAD^"], { cwd: worktree.path });
      if (markerParent !== sourceHeadCommit || currentTree !== workspaceTree) {
        throw new GitHubPublicationWorkspaceChangedError(
          "GitHub publication workspace changed after its accepted snapshot.",
        );
      }
    } else if (headCommit !== sourceHeadCommit) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication workspace changed after its accepted snapshot.",
      );
    }
    await step(findPullRequest);
    row = params.updatePublishingFacts({
      row,
      repository,
      branch,
      baseBranch,
      sourceHeadCommit,
      workspaceTree,
      headCommit,
    });

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
    if (!markerPresent) {
      await command(["git", "cat-file", "-e", `${workspaceTree}^{tree}`], {
        cwd: worktree.path,
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
      const commit = await command(
        ["git", "commit-tree", "--no-gpg-sign", workspaceTree, "-p", headCommit],
        { cwd: worktree.path, env: authorEnv, input: `${message}\n` },
      );
      await assertGitHubPublicationBranchRef(
        branch,
        async (argv) => (await run(argv, { cwd: worktree.path })).code ?? -1,
      );
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
      requestId: row.request_id,
      branch,
      previousHead: previousBranchHead,
      sourceIndexTree,
      workspaceTree,
      headCommit,
      env: identity.env,
      assertCurrent: assertAuthority,
      run: command,
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

    await step(() => assertSafeGitPublicationWorkspace(worktree.path, runCommand));
    const httpsRemote = `https://github.com/${pushRepository}.git`;
    identity = await refreshIdentity();
    let transportEnv = {
      ...identity.env,
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    };
    const pushArgs = githubPublicationPushArgs(httpsRemote, headCommit, branch);
    const observeRemoteHead = async () => {
      const observed = await requireCommand(githubPublicationRemoteHeadArgs(httpsRemote, branch), {
        cwd: worktree.path,
        env: transportEnv,
      });
      return observed.split(/\s+/u)[0] ?? "";
    };
    let remoteHead = await step(observeRemoteHead);
    if (remoteHead !== headCommit) {
      assertAuthority();
      params.recordEffect?.("push");
      effectPending = true;
      const pushed = await runCommand(pushArgs, { cwd: worktree.path, env: transportEnv });
      params.recordEffect?.("push", pushed.code === 0 ? { headCommit } : {});
      assertAuthority();
      identity = await refreshIdentity();
      transportEnv = {
        ...identity.env,
        GIT_CONFIG_GLOBAL: gitNullConfigPath(),
        GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      };
      remoteHead = await step(observeRemoteHead);
      if (remoteHead !== headCommit) {
        throw new Error(
          pushed.code === 0 ? "GitHub push verification failed." : "GitHub push was rejected.",
        );
      }
      params.recordEffect?.("push", { headCommit });
      effectPending = false;
    }

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
      assertAuthority();
      params.recordEffect?.("pull_request");
      effectPending = true;
      const created = await runCommand(githubPublicationCreatePullRequestArgs(repository), {
        env: identity.env,
        input: JSON.stringify({
          title: row.title?.trim() || `Publish ${branch}`,
          body,
          head: `${pushOwner}:${branch}`,
          base: baseBranch,
          draft: true,
        }),
      });
      if (created.code === 0) {
        pullRequestUrl = readNonBlankString(
          parseJsonObject(created.stdout.toString("utf8"), "GitHub pull request creation").html_url,
        );
      }
      params.recordEffect?.("pull_request", pullRequestUrl ? { url: pullRequestUrl } : {});
      assertAuthority();
      pullRequestUrl ??= await step(findPullRequest);
    }
    if (!pullRequestUrl) {
      throw new Error("GitHub pull request creation was rejected.");
    }
    if (effectPending) {
      params.recordEffect?.("pull_request", { url: pullRequestUrl });
    }
    effectPending = false;
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
    if (
      params.interrupt &&
      (effectPending || initial.last_effect) &&
      !(error instanceof GitHubPublicationKnownFailure)
    ) {
      // Unavailable observations cannot settle dispatched effects; only an owner's
      // definitive outcome ends recovery, retaining any already-recorded effects.
      assertAuthority();
      return params.projectResult(params.interrupt());
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
