import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ProjectCloneError } from "../projects/project-clone-runtime.js";
import { materializeProjectClone } from "../projects/project-clone.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
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
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    const current = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
    if (
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
    { cfg: params.cfg, gitUrl: repository.url, requiredCommit: repository.baseCommit },
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
  const prepared = await prepareSessionWorktree({
    target: {
      agentId: params.agentId,
      key: initial.canonicalKey,
      storePath: initial.storePath,
      entry: initial.entry,
    },
    workspace: project.repoRoot,
    name: repository.workspaceId,
    baseRef: repository.baseCommit,
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
  let bound = false;
  try {
    if (repository.checkpointRef) {
      await withSessionRepositoryCheckpoint({ workspaceId }, async (snapshot) => {
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
          throw new Error("Repository changes could not be fully restored; retry the Gateway move");
        }
        await applied.verifyLocalStable();
        assertCurrent();
      });
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
