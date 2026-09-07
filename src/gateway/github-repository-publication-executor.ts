import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { currentGitHubPublicationConfig } from "./github-publication-availability.js";
import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import {
  createGitHubPublicationExecutionIdentity,
  type GitHubPublicationIdentityOwner,
} from "./github-publication-execution-identity.js";
import {
  GitHubPublicationKnownFailure,
  GitHubPublicationWorkspaceChangedError,
  resolveGitHubPublicationFailure,
} from "./github-publication-failure.js";
import {
  appendGitHubPublicationMessage,
  requirePublicationCommand,
  runPublicationCommand,
} from "./github-publication-git-transport.js";
import {
  findGitHubPublicationPullRequest,
  githubPublicationCreatePullRequestArgs,
} from "./github-publication-pull-requests.js";
import { projectGitHubPublicationResult } from "./github-publication-store.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import {
  readGitHubRepositoryPublicationBlob,
  type GitHubRepositoryPublicationSnapshot,
} from "./github-repository-publication-snapshot.js";
import type { RepositoryGitHubPublicationExecution } from "./github-repository-publication-store.js";
import { resolveGitHubRepositoryTarget } from "./github-repository-target.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";

function apiArgs(endpoint: string, method = "GET"): string[] {
  return [
    "gh",
    "api",
    "--hostname",
    "github.com",
    "--method",
    method,
    endpoint,
    ...(method === "GET" ? [] : ["--input", "-"]),
  ];
}

async function api(
  endpoint: string,
  identity: PreparedGitHubPublicationIdentity,
  assertCurrent: () => void,
  body?: unknown,
): Promise<unknown> {
  assertCurrent();
  const raw = await requirePublicationCommand(
    apiArgs(endpoint, body === undefined ? "GET" : "POST"),
    {
      env: identity.env,
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
    },
  );
  assertCurrent();
  return JSON.parse(raw);
}

function objectSha(value: unknown): string {
  if (!isRecord(value) || typeof value.sha !== "string" || !/^[a-f0-9]{40}$/u.test(value.sha)) {
    throw new Error("GitHub returned an invalid Git object identity.");
  }
  return value.sha;
}

export async function prepareRepositoryGitHubPublicationTarget(
  workspace: SessionRepositoryWorkspaceRecord,
  identity: PreparedGitHubPublicationIdentity,
  assertCurrent: () => void,
) {
  const remote = parseGitHubRemoteUrl(workspace.url);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    throw new Error("GitHub publication requires a GitHub remote.");
  }
  const pushRepository = remote.owner + "/" + remote.repo;
  const value = await api("repos/" + pushRepository, identity, assertCurrent);
  const target = resolveGitHubRepositoryTarget(value, remote);
  if (!target) {
    throw new Error("GitHub repository response omitted its publication target.");
  }
  let baseBranch = target.fork
    ? target.pullRequest.defaultBranch
    : parseGitHubPublicationBaseBranch(
        workspace.requestedRef ?? "HEAD",
        target.pullRequest.defaultBranch,
      );
  if (!target.fork && baseBranch !== target.pullRequest.defaultBranch) {
    const refs = await api(
      "repos/" + pushRepository + "/git/matching-refs/heads/" + encodeURIComponent(baseBranch),
      identity,
      assertCurrent,
    );
    if (!Array.isArray(refs)) {
      throw new Error("GitHub publication base branch lookup was invalid.");
    }
    if (!refs.some((ref) => isRecord(ref) && ref.ref === "refs/heads/" + baseBranch)) {
      // Tags and detached commits select source contents, not a pull-request base branch.
      baseBranch = target.pullRequest.defaultBranch;
    }
  }
  if (workspace.branch === baseBranch) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication branch is its pull request base.",
    );
  }
  return {
    pushRepository,
    repository: target.pullRequest.owner + "/" + target.pullRequest.repo,
    baseBranch,
  };
}

/** GitHub receives only accepted normalized objects; the Gateway never fetches source history. */
export async function executeRepositoryGitHubPublication(params: {
  execution: RepositoryGitHubPublicationExecution;
  snapshot: GitHubRepositoryPublicationSnapshot;
  snapshotRoot: string;
  storePath: string;
  assertWorkspace: () => void;
  validateAuthority: () => boolean;
  identity?: GitHubPublicationIdentityOwner;
}) {
  const { execution, snapshot } = params;
  const row = execution.row;
  const { assertCurrent, refreshIdentity } = createGitHubPublicationExecutionIdentity({
    row,
    identity: params.identity,
    assertWorkspace: params.assertWorkspace,
    validateAuthority: () => params.validateAuthority() && execution.ownsExecution(),
  });
  let dispatched = row.last_effect !== null;
  try {
    assertCurrent();
    const { push_repository: pushRepository, repository, base_branch: baseBranch, branch } = row;
    if (
      !pushRepository ||
      !repository ||
      !baseBranch ||
      snapshot.baseCommit !== row.source_head_commit ||
      snapshot.baseTree !== row.source_index_tree ||
      snapshot.workspaceTree !== row.workspace_tree
    ) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication accepted checkpoint changed.",
      );
    }
    let identity = await refreshIdentity();
    const endpoint = "repos/" + pushRepository + "/git/";
    const sourceRepository = await api("repos/" + pushRepository, identity, assertCurrent);
    if (
      !isRecord(sourceRepository) ||
      typeof sourceRepository.node_id !== "string" ||
      !sourceRepository.node_id
    ) {
      throw new Error("GitHub publication repository identity is unavailable.");
    }
    const base = await api(endpoint + "commits/" + snapshot.baseCommit, identity, assertCurrent);
    if (
      !isRecord(base) ||
      objectSha(base.tree) !== snapshot.baseTree ||
      objectSha(base) !== snapshot.baseCommit
    ) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication pinned repository base changed.",
      );
    }
    const baseRef = await api(
      "repos/" + repository + "/git/ref/heads/" + encodeURIComponent(baseBranch),
      identity,
      assertCurrent,
    );
    if (!isRecord(baseRef) || baseRef.ref !== "refs/heads/" + baseBranch) {
      throw new Error("GitHub publication workspace base branch could not be verified.");
    }
    const remoteBase = objectSha(baseRef.object);
    assertCurrent();
    const lineage = await requirePublicationCommand(
      [
        ...apiArgs(
          "repos/" +
            repository +
            "/compare/" +
            snapshot.baseCommit +
            "..." +
            remoteBase +
            "?per_page=1",
        ),
        "--jq",
        "{sha: .merge_base_commit.sha}",
      ],
      { env: identity.env },
    );
    assertCurrent();
    // A requested topic/tag/commit may be ahead of or diverged from the PR base.
    // GitHub's merge-base proves shared history without changing the accepted source.
    const mergeBase = objectSha(JSON.parse(lineage));
    let headCommit = row.head_commit;
    const verifyCommit = (value: unknown) => {
      if (
        !isRecord(value) ||
        objectSha(value.tree) !== snapshot.workspaceTree ||
        !Array.isArray(value.parents) ||
        value.parents.length !== 1 ||
        objectSha(value.parents[0]) !== (row.previous_head_commit ?? snapshot.baseCommit) ||
        typeof value.message !== "string" ||
        !value.message.split(/\r?\n/u).includes("OpenClaw-Publication: " + row.request_id)
      ) {
        throw new GitHubPublicationWorkspaceChangedError(
          "GitHub publication commit does not match its accepted checkpoint.",
        );
      }
      return objectSha(value);
    };
    if (headCommit) {
      const current = await api(endpoint + "commits/" + headCommit, identity, assertCurrent);
      if (verifyCommit(current) !== headCommit) {
        throw new Error("GitHub publication commit identity changed.");
      }
    }
    const observeHead = async () => {
      const observedIdentity = await refreshIdentity();
      const raw = await requirePublicationCommand(
        apiArgs(endpoint + "matching-refs/heads/" + encodeURIComponent(branch)),
        { env: observedIdentity.env },
      );
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) {
        throw new Error("GitHub branch observation was invalid.");
      }
      const ref = value.find((entry) => isRecord(entry) && entry.ref === "refs/heads/" + branch);
      const observed = isRecord(ref) ? objectSha(ref.object) : null;
      // Preserve an authenticated response to a lost push before checking whether
      // its admission closed during the read. This records no permission to act.
      if (headCommit && observed === headCommit) {
        execution.recordEffect("push", { headCommit });
      }
      assertCurrent();
      return observed;
    };
    let remoteHead = await observeHead();
    if (remoteHead !== row.previous_head_commit && (!headCommit || remoteHead !== headCommit)) {
      throw new GitHubPublicationKnownFailure("GitHub publication branch changed.", {
        code: "push_rejected",
        nextAction:
          "Review the changed branch and request a new publication; existing work is never force-pushed.",
      });
    }
    // Initial PR changes use GitHub's merge-base. Later checkpoints compare with
    // the preceding pushed tree, so restoring the PR base remains a real revert.
    const comparisonCommit = row.previous_head_commit ?? mergeBase;
    const comparisonRepository = row.previous_head_commit ? pushRepository : repository;
    const comparison =
      comparisonRepository === pushRepository && comparisonCommit === snapshot.baseCommit
        ? base
        : await api(
            "repos/" + comparisonRepository + "/git/commits/" + comparisonCommit,
            identity,
            assertCurrent,
          );
    if (!isRecord(comparison) || objectSha(comparison) !== comparisonCommit) {
      throw new Error("GitHub publication comparison commit changed.");
    }
    if (snapshot.workspaceTree === objectSha(comparison.tree)) {
      throw new GitHubPublicationKnownFailure("GitHub publication has no changes to publish.", {
        code: "no_changes",
        nextAction: "Make or restore a repository change, then retry.",
      });
    }
    const pushOwner = pushRepository.split("/")[0]!;
    const marker = "<!-- openclaw-publication:" + row.request_id + " -->";
    const findPullRequest = () =>
      findGitHubPublicationPullRequest({
        repository,
        pushOwner,
        branch,
        baseBranch,
        headCommit: headCommit ?? snapshot.baseCommit,
        marker,
        refreshIdentity,
        assertCurrent,
        recordObserved: (url) => execution.recordEffect("pull_request", { url }),
      });
    await findPullRequest();
    const config = currentGitHubPublicationConfig();
    const attribution = resolveGitCoauthorAttribution({
      agentId: row.agent_id,
      config,
      excludeAccountId: identity.account.accountId,
      sessionKey: row.session_key,
      storePath: params.storePath,
    });
    const credit = attribution?.logins.map((login) => "- @" + login).join("\n");
    const title = row.title?.trim() || "Publish " + branch;
    if (!headCommit) {
      const shas = [
        ...new Set(
          snapshot.entries.flatMap((entry) =>
            entry.sha !== null && entry.mode !== "160000" ? [entry.sha] : [],
          ),
        ),
      ];
      identity = await refreshIdentity();
      const uploaded = await runTasksWithConcurrency({
        limit: 4,
        errorMode: "stop",
        tasks: shas.map((sha) => async () => {
          assertCurrent();
          const bytes = await readGitHubRepositoryPublicationBlob(params.snapshotRoot, sha);
          assertCurrent();
          const blob = await api(endpoint + "blobs", identity, assertCurrent, {
            content: bytes.toString("base64"),
            encoding: "base64",
          });
          if (objectSha(blob) !== sha) {
            throw new Error("GitHub publication blob content changed.");
          }
        }),
      });
      if (uploaded.hasError) {
        throw uploaded.firstError;
      }
      const tree =
        snapshot.entries.length === 0
          ? snapshot.baseTree
          : objectSha(
              await api(endpoint + "trees", identity, assertCurrent, {
                base_tree: snapshot.baseTree,
                tree: snapshot.entries.map((entry) => ({
                  path: entry.path,
                  mode: entry.mode,
                  type: entry.mode === "160000" ? "commit" : "blob",
                  sha: entry.sha,
                })),
              }),
            );
      if (tree !== snapshot.workspaceTree) {
        throw new GitHubPublicationWorkspaceChangedError(
          "GitHub publication normalized tree changed.",
        );
      }
      const author = {
        name: identity.account.login,
        email:
          identity.account.accountId + "+" + identity.account.login + "@users.noreply.github.com",
        date: new Date(row.created_at_ms).toISOString(),
      };
      const commit = await api(endpoint + "commits", identity, assertCurrent, {
        tree: snapshot.workspaceTree,
        parents: [row.previous_head_commit ?? snapshot.baseCommit],
        author,
        committer: author,
        message:
          appendGitHubPublicationMessage(credit ? title + "\n\nWorked on by:\n" + credit : title, [
            ...(attribution?.trailers ?? []),
            "OpenClaw-Publication: " + row.request_id,
          ]) + "\n",
      });
      headCommit = verifyCommit(commit);
      execution.updateHead(headCommit);
    }
    if (remoteHead !== headCommit) {
      identity = await refreshIdentity();
      assertCurrent();
      execution.recordEffect("push");
      dispatched = true;
      // GraphQL's beforeOid is an exact lease; REST's non-force update only checks ancestry.
      const result = await runPublicationCommand(apiArgs("graphql", "POST"), {
        env: identity.env,
        input: JSON.stringify({
          query:
            "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
          variables: {
            input: {
              repositoryId: sourceRepository.node_id,
              clientMutationId: row.request_id,
              refUpdates: [
                {
                  name: "refs/heads/" + branch,
                  beforeOid: remoteHead ?? "0".repeat(40),
                  afterOid: headCommit,
                  force: false,
                },
              ],
            },
          },
        }),
      });
      let succeeded = false;
      if (result.code === 0) {
        const reply: unknown = JSON.parse(result.stdout.toString("utf8"));
        succeeded =
          isRecord(reply) &&
          !reply.errors &&
          isRecord(reply.data) &&
          isRecord(reply.data.updateRefs) &&
          reply.data.updateRefs.clientMutationId === row.request_id;
      }
      execution.recordEffect("push", succeeded ? { headCommit } : {});
      assertCurrent();
      remoteHead = await observeHead();
      if (remoteHead !== headCommit) {
        throw new Error("GitHub push verification failed.");
      }
    }
    let url = await findPullRequest();
    if (!url) {
      const sessionUrl = resolveControlUiSessionUrl(config, {
        sessionKey: row.session_key,
        fallbackAgentId: row.agent_id,
        exactKey: true,
      });
      const description =
        row.body?.trim() || "Published by the Gateway from the accepted repository checkpoint.";
      const body =
        description +
        (credit ? "\n\n## Worked on by\n\n" + credit : "") +
        "\n\n" +
        marker +
        (sessionUrl?.startsWith("https://")
          ? "\n\n---\n[View the OpenClaw team session](" + sessionUrl + ")"
          : "");
      identity = await refreshIdentity();
      assertCurrent();
      execution.recordEffect("pull_request");
      dispatched = true;
      const created = await runPublicationCommand(
        githubPublicationCreatePullRequestArgs(repository),
        {
          env: identity.env,
          input: JSON.stringify({
            title,
            body,
            head: pushOwner + ":" + branch,
            base: baseBranch,
            draft: true,
          }),
        },
      );
      if (created.code === 0) {
        const value: unknown = JSON.parse(created.stdout.toString("utf8"));
        if (isRecord(value) && typeof value.html_url === "string") {
          url = value.html_url;
        }
      }
      execution.recordEffect("pull_request", url ? { url } : {});
      assertCurrent();
      url ??= await findPullRequest();
    }
    if (!url) {
      throw new Error("GitHub pull request creation was rejected.");
    }
    return projectGitHubPublicationResult(
      execution.complete({
        requestId: row.request_id,
        status: "published",
        url,
        repository,
        branch,
        headCommit,
      }),
    );
  } catch (error) {
    if (dispatched && !(error instanceof GitHubPublicationKnownFailure)) {
      const interrupted = execution.interrupt();
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      return projectGitHubPublicationResult(interrupted);
    }
    const failure = resolveGitHubPublicationFailure(error);
    return projectGitHubPublicationResult(
      execution.complete({
        requestId: row.request_id,
        status: "failed",
        ...failure,
        message: "GitHub publication failed.",
      }),
    );
  }
}
