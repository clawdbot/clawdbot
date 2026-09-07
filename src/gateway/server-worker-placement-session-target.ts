import type { managedWorktrees } from "../agents/worktrees/service.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type * as sessionUtils from "./session-utils.js";
import type {
  WorkerPlacementExecutionMode,
  WorkerSessionPlacementIdentity,
} from "./worker-environments/placement-record.js";
import type * as placementSessionRuntime from "./worker-environments/placement-session-runtime.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerSessionWorkspace } from "./worker-environments/session-workspace.js";

export class WorkerDispatchTargetChangedError extends Error {
  readonly code = "invalid_state";
}

type WorkerPlacementSessionRuntime = {
  resolveWorkerPlacementExecutionMode: typeof placementSessionRuntime.resolveWorkerPlacementExecutionMode;
  managedWorktrees: typeof managedWorktrees;
  resolveWorkerPlacementSessionRuntime: typeof placementSessionRuntime.resolveWorkerPlacementSessionRuntime;
  resolveCanonicalSessionEntryFromStoreKeys: typeof sessionUtils.resolveCanonicalSessionEntryFromStoreKeys;
  resolveGatewaySessionStoreTargetWithStore: typeof sessionUtils.resolveGatewaySessionStoreTargetWithStore;
};

export async function runWorkerPlacementSessionBarrier<T>(params: {
  sessionRuntime: WorkerPlacementSessionRuntime;
  getConfig: () => OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementExecutionMode;
  action: "activation" | "recovery";
  signal?: AbortSignal;
  run: (workspace: WorkerSessionWorkspace) => T | Promise<T>;
}): Promise<T> {
  const target = params.sessionRuntime.resolveGatewaySessionStoreTargetWithStore({
    cfg: params.getConfig(),
    key: params.sessionKey,
    agentId: params.agentId,
    clone: false,
    exactRead: true,
  });
  return await runExclusiveSessionLifecycleMutation({
    scope: target.storePath,
    identities: [params.sessionKey, target.canonicalKey, ...target.storeKeys, params.sessionId],
    signal: params.signal,
    run: async () => {
      const {
        config,
        target: currentTarget,
        entry,
        workspace,
      } = resolveWorkerPlacementSessionTarget({
        sessionRuntime: params.sessionRuntime,
        config: params.getConfig(),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        expectedTarget: target,
        errorMessage: `Session ${params.sessionKey} changed before cloud worker ${params.action}. Retry.`,
      });
      if (entry.archivedAt !== undefined) {
        throw new WorkerDispatchTargetChangedError(
          `Session ${params.sessionKey} was archived before cloud worker ${params.action}. Retry.`,
        );
      }
      const currentRuntime = params.sessionRuntime.resolveWorkerPlacementSessionRuntime({
        cfg: config,
        entry,
        agentId: currentTarget.agentId,
        sessionKey: currentTarget.canonicalKey,
      });
      if (
        params.sessionRuntime.resolveWorkerPlacementExecutionMode(currentRuntime) !==
        params.executionMode
      ) {
        throw new WorkerDispatchTargetChangedError(
          `Session ${params.sessionKey} runtime changed to ${currentRuntime} before cloud worker ${params.action}. Retry.`,
        );
      }
      return await params.run(workspace);
    },
  });
}

type SessionEntryShape = {
  sessionId?: string;
  archivedAt?: number;
  worktree?: { id?: string };
  repositoryWorkspaceId?: string;
};

type SessionTargetShape<Store> = {
  storePath: string;
  canonicalKey: string;
  agentId: string;
  store: Store;
  storeKeys: string[];
};

/** Keep canonical session identity and its durable workspace owner in one lifecycle fence. */
export function resolveWorkerPlacementSessionTarget<
  Entry extends SessionEntryShape,
  Store extends Record<string, Entry>,
  Target extends SessionTargetShape<Store>,
  Worktree extends { id: string; ownerId?: string; path: string },
>(params: {
  sessionRuntime: {
    resolveGatewaySessionStoreTargetWithStore: (input: {
      cfg: OpenClawConfig;
      key: string;
      agentId: string;
      clone: false;
      exactRead: true;
    }) => Target;
    resolveCanonicalSessionEntryFromStoreKeys: (
      store: Store,
      storeKeys: string[],
    ) => Entry | undefined;
    managedWorktrees: {
      findLiveByOwner: (ownerKind: "session", ownerId: string) => Worktree | undefined;
    };
  };
  config: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  expectedTarget?: Target;
  errorMessage: string;
}) {
  const target = params.sessionRuntime.resolveGatewaySessionStoreTargetWithStore({
    cfg: params.config,
    key: params.sessionKey,
    agentId: params.agentId,
    clone: false,
    exactRead: true,
  });
  const entry = params.sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
    target.store,
    target.storeKeys,
  );
  const expected = params.expectedTarget;
  const targetChangedError = () =>
    expected
      ? new WorkerDispatchTargetChangedError(params.errorMessage)
      : new Error(params.errorMessage);
  if (
    expected &&
    (target.storePath !== expected.storePath ||
      target.canonicalKey !== expected.canonicalKey ||
      target.agentId !== expected.agentId)
  ) {
    throw targetChangedError();
  }
  if (!entry || entry.sessionId !== params.sessionId) {
    throw targetChangedError();
  }
  if (entry.repositoryWorkspaceId) {
    const repository = getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId);
    if (
      !repository ||
      repository.agentId !== target.agentId ||
      repository.sessionKey !== target.canonicalKey ||
      entry.worktree
    ) {
      throw targetChangedError();
    }
    return {
      config: params.config,
      target,
      entry,
      worktree: undefined,
      workspace: { kind: "repository", repository } satisfies WorkerSessionWorkspace,
    };
  }
  const worktree = params.sessionRuntime.managedWorktrees.findLiveByOwner(
    "session",
    target.canonicalKey,
  );
  if (
    !entry.worktree?.id ||
    !worktree ||
    worktree.id !== entry.worktree.id ||
    worktree.ownerId !== target.canonicalKey
  ) {
    throw targetChangedError();
  }
  return {
    config: params.config,
    target,
    entry,
    worktree,
    workspace: { kind: "local", path: worktree.path } satisfies WorkerSessionWorkspace,
  };
}

export const loadWorkerPlacementSessionRuntimeModule = createLazyRuntimeModule(async () => {
  const [placementSessionRuntime, { managedWorktrees }, sessionUtils] = await Promise.all([
    import("./worker-environments/placement-session-runtime.js"),
    import("../agents/worktrees/service.js"),
    import("./session-utils.js"),
  ]);
  return {
    resolveWorkerPlacementExecutionMode:
      placementSessionRuntime.resolveWorkerPlacementExecutionMode,
    resolveWorkerPlacementCapabilities: placementSessionRuntime.resolveWorkerPlacementCapabilities,
    managedWorktrees,
    resolveWorkerPlacementSessionRuntime:
      placementSessionRuntime.resolveWorkerPlacementSessionRuntime,
    resolveCanonicalSessionEntryFromStoreKeys:
      sessionUtils.resolveCanonicalSessionEntryFromStoreKeys,
    resolveGatewaySessionStoreTargetWithStore:
      sessionUtils.resolveGatewaySessionStoreTargetWithStore,
  };
});

export function createWorkerPlacementNodeWorkspaceBindingResolver(options: {
  placements: Pick<WorkerSessionPlacementStore, "get">;
  resolveWorkspace: (identity: WorkerSessionPlacementIdentity) => Promise<WorkerSessionWorkspace>;
}) {
  return async (binding: { environmentId: string; ownerEpoch: number; sessionId: string }) => {
    const placement = options.placements.get(binding.sessionId);
    if (
      !placement ||
      (placement.state !== "active" &&
        placement.state !== "draining" &&
        placement.state !== "reconciling") ||
      placement.environmentId !== binding.environmentId ||
      placement.activeOwnerEpoch !== binding.ownerEpoch
    ) {
      return undefined;
    }
    const workspace = await options.resolveWorkspace({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
    });
    if (
      workspace.kind === "repository" &&
      (!workspace.repository.baseCommit || !workspace.repository.baseManifestHash)
    ) {
      throw new Error("Attached repository workspace has no pinned baseline");
    }
    return {
      source:
        workspace.kind === "local"
          ? { kind: "local" as const, path: workspace.path }
          : {
              kind: "repository" as const,
              baseCommit: workspace.repository.baseCommit!,
              baseManifestRef: workspace.repository.baseManifestHash!,
            },
      manifestRef: placement.workspaceBaseManifestRef,
      remoteWorkspaceDir: placement.remoteWorkspaceDir,
    };
  };
}
