import os from "node:os";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import {
  readProjectCheckoutRemoteHead,
  ProjectCloneError,
} from "../projects/project-clone-runtime.js";
import { materializeProjectClone } from "../projects/project-clone.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import {
  assertSafeGitPublicationWorkspace,
  createGitHubPublicationCommandRunner,
} from "./github-publication-git-transport.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { prepareRepositoryPublicationRestore } from "./github-repository-publication-restore.js";
import { readRepositoryGitHubPublicationBranch } from "./github-repository-publication-store.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";
import { withSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";
import { prepareWorkerGitHubBinding } from "./worker-environments/worker-github-binding.js";
import { applyStagedWorkerWorkspace } from "./worker-environments/workspace-reconcile-apply.js";

/** Called only by an explicit Gateway move, after the source result is accepted. */
export async function materializeSessionRepositoryWorkspaceOnGateway(params: {
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  const initial = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  if (initial.entry?.sessionId !== params.sessionId) {
    throw new Error("Session changed before repository materialization");
  }
  const workspaceId = initial.entry.repositoryWorkspaceId;
  if (!workspaceId) {
    return;
  }
  const repositories = getSessionRepositoryWorkspaceStore();
  const repository = repositories.get(workspaceId);
  if (
    !repository ||
    repository.agentId !== params.agentId ||
    repository.sessionKey !== initial.canonicalKey ||
    !repository.baseCommit
  ) {
    throw new Error("Repository workspace has no pinned source; retry its cloud preparation");
  }
  const remote = parseGitHubRemoteUrl(repository.url);
  if (!remote) {
    throw new Error("Repository workspace has no GitHub source");
  }
  const branch = () =>
    readRepositoryGitHubPublicationBranch({
      workspaceId,
      branch: repository.branch,
      pushRepository: `${remote.owner}/${remote.repo}`,
    });
  const selected = branch();
  const published = selected.head;
  if (selected.unsettled) {
    throw new Error(
      "Repository publication is awaiting a GitHub effect observation; retry the Gateway move after publication settles",
    );
  }
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    const currentBranch = branch();
    const current = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
    if (
      currentBranch.unsettled ||
      currentBranch.head?.pushed_head_commit !== published?.pushed_head_commit ||
      current.storePath !== initial.storePath ||
      current.canonicalKey !== initial.canonicalKey ||
      current.entry?.sessionId !== params.sessionId ||
      current.entry.lifecycleRevision !== initial.entry?.lifecycleRevision ||
      current.entry.repositoryWorkspaceId !== workspaceId ||
      repositories.get(workspaceId)?.revision !== repository.revision
    ) {
      throw new Error("Repository workspace changed during Gateway materialization; retry move");
    }
  };
  assertCurrent();
  const github = await prepareWorkerGitHubBinding({
    sessionId: params.sessionId,
    sessionKey: initial.canonicalKey,
    agentId: params.agentId,
    assertCurrent: () => {
      assertCurrent();
      return true;
    },
  });
  // Optional launch binding absorbs unavailable auth, including a thrown owner
  // assertion. A closed move must never proceed as an anonymous clone.
  assertCurrent();
  const project = await materializeProjectClone(
    {
      cfg: params.cfg,
      gitUrl: repository.url,
      requiredCommit: published?.pushed_head_commit ?? repository.baseCommit,
    },
    { signal: params.signal, token: github?.token },
  ).catch((error: unknown) => {
    if (error instanceof ProjectCloneError && error.failure === "auth_required") {
      throw new ProjectCloneError(
        error.failure,
        "GitHub could not authenticate this repository with the selected shared GitHub identity. Check its repository access or reconnect it in Settings, then retry the Gateway move.",
      );
    }
    throw error;
  });
  assertCurrent();
  const { step, require: command, run } = createGitHubPublicationCommandRunner(assertCurrent);
  const cloneOptions = { signal: params.signal, token: github?.token };
  const source = { url: repository.url, target: project.repoRoot };
  const remoteHead = await step(() =>
    readProjectCheckoutRemoteHead({ ...source, branch: repository.branch }, cloneOptions),
  );
  if (remoteHead !== (published?.pushed_head_commit ?? undefined)) {
    throw new Error(
      "Repository publication branch differs from its recorded push; review the remote branch before retrying the Gateway move",
    );
  }
  const requestedBase = parseGitHubPublicationBaseBranch(repository.requestedRef ?? "HEAD", "HEAD");
  const baseRef =
    published?.base_branch ??
    (requestedBase !== "HEAD" &&
    (await step(() =>
      readProjectCheckoutRemoteHead({ ...source, branch: requestedBase }, cloneOptions),
    ))
      ? requestedBase
      : "HEAD");
  if (published?.pushed_head_commit) {
    const head = published.pushed_head_commit;
    const contents = await command(["git", "show", "-s", "--format=%T%n%P%n%B", head], {
      cwd: project.repoRoot,
    });
    const [tree, parent, ...message] = contents.split("\n");
    const ancestor = await run(
      ["git", "merge-base", "--is-ancestor", repository.baseCommit, head],
      { cwd: project.repoRoot },
    );
    if (
      ancestor.code !== 0 ||
      tree !== published.workspace_tree ||
      parent !== (published.previous_head_commit ?? repository.baseCommit) ||
      !message.includes(`OpenClaw-Publication: ${published.request_id}`)
    ) {
      throw new Error(
        "Recorded repository publication commit could not be verified; review publication before retrying the Gateway move",
      );
    }
  }
  const prepared = await prepareSessionWorktree({
    target: {
      agentId: params.agentId,
      key: initial.canonicalKey,
      storePath: initial.storePath,
      entry: initial.entry,
    },
    workspace: project.repoRoot,
    name: repository.workspaceId,
    baseRef,
    checkoutCommit: repository.baseCommit,
    runSetupScript: false,
    signal: params.signal,
    commitGuard: assertCurrent,
  });
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  const workspace = prepared.value;
  const root = workspace.spawnedCwd;
  if (!root || !workspace.worktree) {
    throw new Error("Repository materialization did not create a managed worktree");
  }
  const git = (args: string[]) =>
    command(["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      env: { GIT_CONFIG_GLOBAL: gitNullConfigPath(), GIT_CONFIG_SYSTEM: gitNullConfigPath() },
    });
  const alignPublication = async () => {
    if (published?.pushed_head_commit) {
      // Preserve the creation reflog at the pinned base and the accepted working bytes.
      // The local publisher must append to the cloud push, not make a sibling commit.
      await git(["reset", "--mixed", "--no-refresh", published.pushed_head_commit]);
    }
  };
  let bound = false;
  try {
    await step(() => assertSafeGitPublicationWorkspace(root, run));
    const currentHead = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
    const currentBranch = await git(["symbolic-ref", "--quiet", "HEAD"]);
    if (
      currentBranch !== `refs/heads/${repository.branch}` ||
      (currentHead !== repository.baseCommit && currentHead !== published?.pushed_head_commit)
    ) {
      throw new Error(
        "Gateway worktree changed before repository restoration; review its local commits before retrying move",
      );
    }
    if (repository.checkpointRef) {
      await withSessionRepositoryCheckpoint(
        { workspaceId, includePublication: true },
        async (snapshot) => {
          assertCurrent();
          const applied = await applyStagedWorkerWorkspace({
            ...snapshot,
            root,
            // The checkout is unbound until verification. Failed preparation rolls it
            // back; a crash leaves the immutable checkpoint available for a fresh retry.
            journal: {
              load: () => undefined,
              begin: assertCurrent,
              commit: assertCurrent,
              abort: () => {},
            },
          });
          if (applied.conflictPaths.length || applied.manifestRef !== repository.manifestHash) {
            throw new Error(
              "Repository changes could not be fully restored; retry the Gateway move",
            );
          }
          await applied.verifyLocalStable();
          await alignPublication();
          for (const restore of await prepareRepositoryPublicationRestore({
            ...snapshot,
            ...(published?.pushed_head_commit
              ? { indexBase: { root, commit: published.pushed_head_commit, assertCurrent } }
              : {}),
          })) {
            await command(restore.argv, { cwd: root, input: restore.input });
          }
          await applied.verifyLocalStable();
          assertCurrent();
        },
      );
    } else {
      await alignPublication();
    }
    const entry = await patchSessionEntryCore(
      { agentId: params.agentId, sessionKey: initial.canonicalKey, storePath: initial.storePath },
      (current) => {
        assertCurrent();
        return {
          ...current,
          repositoryWorkspaceId: undefined,
          projectId: project.id,
          spawnedCwd: workspace.spawnedCwd,
          sessionRoot: workspace.sessionRoot,
          worktree: workspace.worktree,
        };
      },
      {
        replaceEntry: true,
        assertCommitAllowed: assertCurrent,
        requireWriteSuccess: true,
        skipMaintenance: true,
        onCommitted: () => {
          bound = true;
        },
      },
    );
    if (!entry) {
      throw new Error("Session disappeared before repository materialization committed");
    }
    // Pending publication receipts still own immutable source refs. Session deletion
    // releases that retained repository row; future turns use the bound local worktree.
  } finally {
    if (!bound) {
      await workspace.rollback?.();
    }
  }
}
