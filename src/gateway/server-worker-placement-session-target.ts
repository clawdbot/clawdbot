import type { managedWorktrees } from "../agents/worktrees/service.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import type * as sessionUtils from "./session-utils.js";
import type { WorkerPlacementExecutionMode } from "./worker-environments/placement-record.js";
import type * as placementSessionRuntime from "./worker-environments/placement-session-runtime.js";

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
type WorkerPlacementWorktree = NonNullable<ReturnType<typeof managedWorktrees.findLiveByOwner>>;

export async function runWorkerPlacementSessionBarrier<T>(params: {
  sessionRuntime: WorkerPlacementSessionRuntime;
  getConfig: () => OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementExecutionMode;
  action: "activation" | "recovery";
  run: (worktree: WorkerPlacementWorktree) => T | Promise<T>;
}): Promise<T> {
  const target = params.sessionRuntime.resolveGatewaySessionStoreTargetWithStore({
    cfg: params.getConfig(),
    key: params.sessionKey,
    agentId: params.agentId,
    clone: false,
  });
  return await runExclusiveSessionLifecycleMutation({
    scope: target.storePath,
    identities: [params.sessionKey, target.canonicalKey, ...target.storeKeys, params.sessionId],
    run: async () => {
      const {
        config,
        target: currentTarget,
        entry,
        worktree,
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
      return await params.run(worktree);
    },
  });
}

type SessionEntryShape = {
  sessionId?: string;
  archivedAt?: number;
  worktree?: { id?: string };
};

type SessionTargetShape<Store> = {
  storePath: string;
  canonicalKey: string;
  agentId: string;
  store: Store;
  storeKeys: string[];
};

/** Keep canonical session identity and its live managed worktree in one lifecycle fence. */
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
  });
  const entry = params.sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
    target.store,
    target.storeKeys,
  );
  const worktree = params.sessionRuntime.managedWorktrees.findLiveByOwner(
    "session",
    target.canonicalKey,
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
  if (!entry || entry.sessionId !== params.sessionId || !entry.worktree?.id) {
    throw targetChangedError();
  }
  if (!worktree || worktree.id !== entry.worktree.id || worktree.ownerId !== target.canonicalKey) {
    throw targetChangedError();
  }
  return { config: params.config, target, entry, worktree };
}
