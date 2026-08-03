import type {
  GatewaySessionRow,
  SessionsListResult,
  SessionsPatchResult,
} from "../../api/types.ts";
import {
  requestSessionCreate,
  resolveSessionCreateParams,
  type SessionCreateParams,
} from "./create.ts";
import type { SessionPatch, SessionPatchOptions } from "./patch.ts";
import type {
  SessionConnectionOwner,
  SessionCreateReconciliation,
  SessionDeleteBatchResult,
  SessionDeleteOptions,
  SessionDeleteOutcome,
  SessionDeleteTarget,
  SessionResetOptions,
  SessionResetResult,
  SessionState,
} from "./session-capability.ts";
import {
  confirmsSessionDeletion,
  requestSessionDelete,
  requestSessionPatch,
  requestSessionReset,
} from "./session-requests.ts";

type SessionMutationsHost = {
  connection: SessionConnectionOwner;
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  refreshReplacement: (agentId?: string | null) => Promise<void>;
  notifyCreated: (key: string) => void;
  retirePullRequestSummary: (key: string) => void;
};

export function createSessionMutations(host: SessionMutationsHost) {
  const pendingModelPatches = new Map<
    string,
    { token: symbol; previous: string | null | undefined; revision: number }
  >();
  const preparedWorkSessionKeys = new Set<string>();

  const setModelOverride = (key: string, value: string | null | undefined) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    // Equal-value writes still transfer ownership while a patch is pending.
    const pendingModelPatch = pendingModelPatches.get(normalizedKey);
    if (pendingModelPatch) {
      pendingModelPatch.revision += 1;
    }
    const state = host.readState();
    const modelOverrides = { ...state.modelOverrides };
    if (value === undefined) {
      if (!Object.hasOwn(state.modelOverrides, normalizedKey)) {
        return;
      }
      delete modelOverrides[normalizedKey];
    } else {
      const normalizedValue = value === null ? null : value.trim();
      if (
        modelOverrides[normalizedKey] === normalizedValue &&
        Object.hasOwn(modelOverrides, normalizedKey)
      ) {
        return;
      }
      modelOverrides[normalizedKey] = normalizedValue;
    }
    host.publish({ ...state, modelOverrides });
  };

  const patchRowLocal = (key: string, patch: Partial<GatewaySessionRow>) => {
    const state = host.readState();
    const normalizedKey = key.trim();
    if (!state.result || !normalizedKey) {
      return;
    }
    let changed = false;
    const sessions = state.result.sessions.map((row) => {
      if (row.key !== normalizedKey) {
        return row;
      }
      changed = true;
      return { ...row, ...patch };
    });
    if (changed) {
      host.publish({ ...state, result: { ...state.result, sessions } });
    }
  };

  const retireModelOverride = (key: string) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    pendingModelPatches.delete(normalizedKey);
    setModelOverride(normalizedKey, undefined);
  };

  const createResult = async (
    params: SessionCreateParams = {},
    options: { reconciliation?: SessionCreateReconciliation } = {},
  ) => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const { currentSessionKey, ...requestParams } = params;
      const result = await requestSessionCreate(scope.client, {
        ...requestParams,
        ...resolveSessionCreateParams(currentSessionKey, params.agentId),
      });
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      // Creation precedes canonical rows; carry placement/model until list hydration.
      if (requestParams.worktree === true || Boolean(requestParams.execNode?.trim())) {
        preparedWorkSessionKeys.add(result.key.trim());
      }
      if (requestParams.model?.trim()) {
        setModelOverride(result.key, requestParams.model);
      } else if (preparedWorkSessionKeys.has(result.key)) {
        host.publish({ ...host.readState() });
      }
      const reconcileCreatedSession = async () => {
        await host.refreshReplacement(params.agentId);
        if (host.connection.isCurrent(scope)) {
          host.notifyCreated(result.key);
        }
      };
      if (options.reconciliation === "background") {
        void reconcileCreatedSession().catch((error: unknown) => {
          if (host.connection.isCurrent(scope)) {
            host.publish({ ...host.readState(), error: String(error) }, "operation");
          }
        });
      } else {
        await reconcileCreatedSession();
        if (!host.connection.isCurrent(scope)) {
          return null;
        }
      }
      return result;
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.publish({ ...host.readState(), error: String(error) }, "operation");
      }
      return null;
    }
  };

  const create = async (params: SessionCreateParams = {}) =>
    (await createResult(params))?.key ?? null;

  const patch = async (
    key: string,
    patchParams: SessionPatch,
    options: SessionPatchOptions = {},
  ): Promise<SessionsPatchResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const hasModelPatch = Object.hasOwn(patchParams, "model");
    const managesModelOverride = hasModelPatch && options.deferModelOverride !== true;
    const normalizedKey = key.trim();
    let previousModelOverride: string | null | undefined;
    let modelPatchStarted = false;
    let modelPatchRevision = 0;
    const modelPatchToken = Symbol();
    const ownsModelOverride = () => options.ownsModelOverride?.() !== false;
    const startModelPatch = () => {
      if (!managesModelOverride || modelPatchStarted || !ownsModelOverride()) {
        return;
      }
      const pendingModelPatch = pendingModelPatches.get(normalizedKey);
      previousModelOverride = pendingModelPatch
        ? pendingModelPatch.previous
        : host.readState().modelOverrides[normalizedKey];
      modelPatchStarted = true;
      pendingModelPatches.set(normalizedKey, {
        token: modelPatchToken,
        previous: previousModelOverride,
        revision: 0,
      });
      setModelOverride(key, patchParams.model);
      modelPatchRevision = pendingModelPatches.get(normalizedKey)?.revision ?? 0;
    };
    if (!options.waitFor) {
      startModelPatch();
    }
    const settleModelOverride = (completed: boolean) => {
      const pendingModelPatch = pendingModelPatches.get(normalizedKey);
      if (modelPatchStarted && pendingModelPatch?.token === modelPatchToken) {
        pendingModelPatches.delete(normalizedKey);
        if (host.connection.isCurrent(scope) && ownsModelOverride()) {
          setModelOverride(key, completed ? patchParams.model : previousModelOverride);
        } else if (pendingModelPatch.revision === modelPatchRevision) {
          // The shared key now belongs to another agent/connection. Remove only
          // this operation's untouched optimistic value; preserve newer claims.
          setModelOverride(key, undefined);
        }
      }
    };
    try {
      if (options.waitFor) {
        await options.waitFor;
        if (!host.connection.isCurrent(scope)) {
          settleModelOverride(false);
          return null;
        }
      }
      startModelPatch();
      const result = await requestSessionPatch(scope.client, key, patchParams, options);
      if (!host.connection.isCurrent(scope)) {
        settleModelOverride(false);
        return null;
      }
      if (!options.deferListRefresh) {
        await host.refreshReplacement(options.agentId);
        if (!host.connection.isCurrent(scope)) {
          settleModelOverride(false);
          return null;
        }
      }
      settleModelOverride(true);
      return result;
    } catch (error) {
      settleModelOverride(false);
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      if (ownsModelOverride()) {
        host.publish({ ...host.readState(), error: String(error) }, "operation");
      }
      throw error;
    }
  };

  const remove = async (
    key: string,
    options: SessionDeleteOptions = {},
  ): Promise<SessionDeleteOutcome> => {
    const scope = host.connection.capture();
    if (!scope) {
      return { deleted: false };
    }
    try {
      const response = await requestSessionDelete(scope.client, key, options);
      if (!host.connection.isCurrent(scope) || !confirmsSessionDeletion(response)) {
        return { deleted: false };
      }
      host.retirePullRequestSummary(key);
      preparedWorkSessionKeys.delete(key.trim());
      host.publish({ ...host.readState(), deletedSessions: [{ key, agentId: options.agentId }] });
      setModelOverride(key, undefined);
      await host.refreshReplacement(options.agentId);
      return {
        deleted: host.connection.isCurrent(scope),
        ...(response.worktreePreserved ? { worktreePreserved: response.worktreePreserved } : {}),
      };
    } catch (error) {
      if (!host.connection.isCurrent(scope)) {
        return { deleted: false };
      }
      host.publish({ ...host.readState(), error: String(error) }, "operation");
      throw error;
    }
  };

  const removeMany = async (
    targets: readonly SessionDeleteTarget[],
  ): Promise<SessionDeleteBatchResult> => {
    const scope = host.connection.capture();
    if (!scope || targets.length === 0) {
      return { deleted: [], errors: [], preservedWorktrees: [] };
    }
    const deleted: string[] = [];
    const errors: string[] = [];
    const preservedWorktrees: SessionDeleteBatchResult["preservedWorktrees"] = [];
    for (const target of targets) {
      if (!host.connection.isCurrent(scope)) {
        break;
      }
      try {
        const response = await requestSessionDelete(scope.client, target.key, target);
        if (!host.connection.isCurrent(scope)) {
          break;
        }
        if (confirmsSessionDeletion(response)) {
          deleted.push(target.key);
          if (response.worktreePreserved) {
            preservedWorktrees.push(response.worktreePreserved);
          }
        }
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (deleted.length > 0 && host.connection.isCurrent(scope)) {
      for (const key of deleted) {
        host.retirePullRequestSummary(key);
        preparedWorkSessionKeys.delete(key.trim());
      }
      host.publish({
        ...host.readState(),
        deletedSessions: targets.filter((target) => deleted.includes(target.key)),
      });
      for (const key of deleted) {
        setModelOverride(key, undefined);
      }
      await host.refreshReplacement();
    }
    return host.connection.isCurrent(scope)
      ? { deleted, errors, preservedWorktrees }
      : { deleted: [], errors: [], preservedWorktrees: [] };
  };

  const reset = async (
    key: string,
    options: SessionResetOptions = {},
  ): Promise<SessionResetResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      return "not-started";
    }
    try {
      await requestSessionReset(scope.client, key, options);
      return host.connection.isCurrent(scope) ? "completed" : "uncertain";
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.publish({ ...host.readState(), error: String(error) }, "operation");
      }
      // Reset can commit before awaited lifecycle work rejects; never infer safe retry.
      return "uncertain";
    }
  };

  return {
    create,
    createResult,
    delete: remove,
    deleteMany: removeMany,
    patch,
    patchRowLocal,
    reset,
    retireModelOverride,
    setModelOverride,
    isPreparedWorkSession: (key: string) => preparedWorkSessionKeys.has(key.trim()),
    settlePrepared(result: SessionsListResult | null) {
      for (const row of result?.sessions ?? []) {
        if (row.worktree || row.execNode) {
          preparedWorkSessionKeys.delete(row.key);
        }
      }
    },
    retireConnection() {
      pendingModelPatches.clear();
      preparedWorkSessionKeys.clear();
      const state = host.readState();
      if (Object.keys(state.modelOverrides).length > 0) {
        host.publish({ ...state, modelOverrides: {} });
      }
    },
    dispose() {
      pendingModelPatches.clear();
      preparedWorkSessionKeys.clear();
    },
  };
}
