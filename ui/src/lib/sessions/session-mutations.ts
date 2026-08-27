import type {
  SessionOwner,
  SessionsAssignOwnerParams,
  SessionsAssignOwnerResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
  GatewaySessionRow,
  SessionsListResult,
  SessionsPatchResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import {
  requestSessionCreate,
  resolveSessionCreateParams,
  type SessionCreateParams,
  type SessionCreateOutcome,
} from "./create.ts";
import type { SessionPatch, SessionPatchOptions } from "./patch.ts";
import { createSessionArchiveVisibility } from "./session-archive-visibility.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionCreateReconciliation,
  SessionArchiveVisibility,
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

/** The Gateway's single pin fact: `pinned` is a projection of `pinnedAt`. */
type SessionPinFields = { pinned: boolean; pinnedAt: number | undefined };

type ConfirmedArchiveState = Pick<GatewaySessionRow, "archivedAt" | "archivedBy" | "sessionId">;

type SessionMutationsHost = {
  connection: SessionConnectionOwner;
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  refreshReplacement: (agentId?: string | null) => Promise<void>;
  publishedRow: (key: string) => GatewaySessionRow | undefined;
  redecorateLists: () => void;
  notifyCreated: (key: string, entry?: SessionCreateOutcome["entry"], agentId?: string) => void;
  clearThink: (key: string, agentId?: string | null) => void;
  retirePullRequestSummary: (key: string) => void;
};

export function createSessionMutations(host: SessionMutationsHost) {
  const pendingModelPatches = new Map<
    string,
    {
      token: symbol;
      previous: { value: string | null | undefined; created: boolean };
      revision: number;
    }
  >();
  const pendingPinPatches = new Map<
    string,
    { token: symbol; previous: SessionPinFields; next: SessionPinFields }
  >();
  const confirmedArchives = new Map<string, ConfirmedArchiveState>();
  const archiveVisibility = createSessionArchiveVisibility(() =>
    host.publish({ ...host.readState() }),
  );
  const preparedWorkSessionKeys = new Set<string>();
  const pendingCreatedModelOverrides = new Set<string>();

  const setModelOverride = (key: string, value: string | null | undefined, created = false) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    // Register before publishing: a synchronous subscriber may claim the same value.
    if (created) {
      pendingCreatedModelOverrides.add(normalizedKey);
    } else {
      pendingCreatedModelOverrides.delete(normalizedKey);
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

  // The Gateway derives `pinned` from `pinnedAt` and both row comparators order
  // by `pinnedAt` inside each pin group, so an optimistic write has to move the
  // pair or the row lands in a slot the Gateway would never produce.
  const pinRowFields = (pinned: boolean, pinnedAt: number | undefined): SessionPinFields =>
    pinned
      ? { pinned: true, pinnedAt: pinnedAt ?? Date.now() }
      : { pinned: false, pinnedAt: undefined };

  const retireModelOverride = (key: string) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    pendingModelPatches.delete(normalizedKey);
    setModelOverride(normalizedKey, undefined);
  };

  const reconcileConfirmedPreviousConnection = async (
    scope: SessionConnectionScope,
    agentId?: string | null,
  ): Promise<boolean> => {
    const replacement = host.connection.capture();
    if (!replacement || replacement.client !== scope.client) {
      return false;
    }
    let refreshError: string | undefined;
    try {
      await host.refreshReplacement(agentId);
      refreshError = host.readState().error ?? undefined;
    } catch (error) {
      refreshError = formatUiError(error);
    }
    if (!host.connection.isCurrent(replacement)) {
      return false;
    }
    host.publish(
      {
        ...host.readState(),
        error: refreshError
          ? t("connection.sessionOperationCompletedPreviousConnectionWithRefreshError", {
              error: refreshError,
            })
          : t("connection.sessionOperationCompletedPreviousConnection"),
      },
      "operation",
    );
    return true;
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
        return (await reconcileConfirmedPreviousConnection(scope, params.agentId)) ? result : null;
      }
      // Creation precedes canonical rows; claim placement before any event or
      // list publication can assign this key an ordinary roster position.
      host.notifyCreated(result.key, result.entry, requestParams.agentId);
      if (requestParams.worktree === true || Boolean(requestParams.execNode?.trim())) {
        preparedWorkSessionKeys.add(result.key.trim());
      }
      if (requestParams.model?.trim()) {
        setModelOverride(result.key, requestParams.model, true);
      } else if (preparedWorkSessionKeys.has(result.key)) {
        host.publish({ ...host.readState() });
      }
      const reconciliation = host.refreshReplacement(params.agentId);
      if (options.reconciliation === "background") {
        void reconciliation.catch((error: unknown) => {
          if (host.connection.isCurrent(scope)) {
            host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
          }
        });
      } else {
        await reconciliation;
        if (!host.connection.isCurrent(scope)) {
          return (await reconcileConfirmedPreviousConnection(scope, params.agentId))
            ? result
            : null;
        }
      }
      return result;
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
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
    const managesModelOverride = Object.hasOwn(patchParams, "model");
    const normalizedKey = key.trim();
    const archivedPresentationRow =
      patchParams.archived === true ? host.publishedRow(normalizedKey) : undefined;
    let modelPatchStarted = false;
    let modelPatchRevision = 0;
    const modelPatchToken = Symbol("session-model-patch");
    const ownsModelOverride = () => options.ownsModelOverride?.() !== false;
    const startModelPatch = () => {
      if (!managesModelOverride || modelPatchStarted || !ownsModelOverride()) {
        return;
      }
      const pendingModelPatch = pendingModelPatches.get(normalizedKey);
      modelPatchStarted = true;
      pendingModelPatches.set(normalizedKey, {
        token: modelPatchToken,
        previous: pendingModelPatch?.previous ?? {
          value: host.readState().modelOverrides[normalizedKey],
          created: pendingCreatedModelOverrides.has(normalizedKey),
        },
        revision: 0,
      });
      setModelOverride(key, patchParams.model);
      modelPatchRevision = pendingModelPatches.get(normalizedKey)?.revision ?? 0;
    };
    const nextPinned = patchParams.pinned === true;
    const pinPatchToken = Symbol("session-pin-patch");
    let pinPatchStarted = false;
    // Sidebar rows read `pinned` straight off the snapshot, so a pin/unpin has
    // no visible outcome until this flip; the Gateway patch and its list
    // refresh confirm it afterwards.
    const startPinPatch = () => {
      if (patchParams.pinned === undefined || pinPatchStarted) {
        return;
      }
      const pendingPinPatch = pendingPinPatches.get(normalizedKey);
      // The baseline comes from wherever the row is published: a sidebar on
      // `archived`/`all` renders its own snapshot, and inferring `previous`
      // from the primary state alone would roll such a row back to a guess.
      const row = host.publishedRow(normalizedKey);
      pinPatchStarted = true;
      const next = pinRowFields(nextPinned, row?.pinnedAt);
      // `previous` chains through an in-flight pin so a rollback lands on the
      // last Gateway-confirmed value instead of an older operation's guess.
      pendingPinPatches.set(normalizedKey, {
        token: pinPatchToken,
        previous: pendingPinPatch?.previous ?? pinRowFields(row?.pinned === true, row?.pinnedAt),
        next,
      });
      host.redecorateLists();
    };
    const startOptimisticPatch = () => {
      startModelPatch();
      startPinPatch();
    };
    if (!options.waitFor) {
      startOptimisticPatch();
    }
    const settleModelOverride = (completed: boolean) => {
      const pendingModelPatch = pendingModelPatches.get(normalizedKey);
      if (modelPatchStarted && pendingModelPatch?.token === modelPatchToken) {
        pendingModelPatches.delete(normalizedKey);
        // Success and rollback may settle only this operation's untouched claim.
        if (pendingModelPatch.revision !== modelPatchRevision) {
          return;
        }
        if (host.connection.isCurrent(scope) && ownsModelOverride()) {
          if (completed && !options.deferListRefresh) {
            // The refreshed row already carries the Gateway-confirmed selection.
            // Keeping an overlay would hide subsequent external model changes.
            setModelOverride(key, undefined);
          } else {
            const previous = pendingModelPatch.previous;
            // A failed patch restores a create preview only until its canonical row arrives.
            const created =
              !completed &&
              previous.created &&
              host.publishedRow(normalizedKey)?.modelOverrideSource === undefined;
            setModelOverride(
              key,
              completed
                ? patchParams.model
                : previous.created && !created
                  ? undefined
                  : previous.value,
              created,
            );
          }
        } else {
          // The shared key now belongs to another agent/connection. Remove only
          // this operation's untouched optimistic value; preserve newer claims.
          setModelOverride(key, undefined);
        }
      }
    };
    // The Gateway has committed by the time this runs, so a newer intent's
    // rollback baseline moves here rather than after the list refresh, which
    // can fail and would leave that intent rolling back to a pre-patch value.
    // The Gateway stamps `pinnedAt` with its own clock, so the baseline is a
    // round trip off — accurate enough to order a row it just pinned.
    const confirmPinPatch = () => {
      const pendingPinPatch = pendingPinPatches.get(normalizedKey);
      if (pinPatchStarted && pendingPinPatch && pendingPinPatch.token !== pinPatchToken) {
        pendingPinPatch.previous = pinRowFields(nextPinned, undefined);
      }
    };
    const settlePinPatch = (completed: boolean) => {
      const pendingPinPatch = pendingPinPatches.get(normalizedKey);
      if (!pinPatchStarted || !pendingPinPatch) {
        return;
      }
      if (pendingPinPatch.token !== pinPatchToken) {
        // A newer pin intent owns this row; republishing it is the canonical
        // overlay's job and its baseline moved at confirmation time.
        return;
      }
      if (!completed && host.connection.isCurrent(scope)) {
        // Roll back through the same overlay that published the intent so the
        // primary state and every filtered snapshot land on one value.
        pendingPinPatch.next = pendingPinPatch.previous;
        host.redecorateLists();
      }
      pendingPinPatches.delete(normalizedKey);
    };
    const settleOptimisticPatch = (completed: boolean) => {
      settleModelOverride(completed);
      settlePinPatch(completed);
    };
    try {
      if (options.waitFor) {
        await options.waitFor;
        if (!host.connection.isCurrent(scope)) {
          settleOptimisticPatch(false);
          return null;
        }
      }
      startOptimisticPatch();
      const result = await requestSessionPatch(scope.client, key, patchParams, options);
      if (!host.connection.isCurrent(scope)) {
        settleOptimisticPatch(false);
        return (await reconcileConfirmedPreviousConnection(scope, options.agentId)) ? result : null;
      }
      if (Object.hasOwn(patchParams, "thinkingLevel")) {
        host.clearThink(normalizedKey, options.agentId);
      }
      if (archivedPresentationRow) {
        const archivedAt = result.entry?.archivedAt ?? Date.now();
        const archivedSessionId = result.entry?.sessionId ?? archivedPresentationRow.sessionId;
        confirmedArchives.set(normalizedKey, {
          archivedAt,
          ...(archivedPresentationRow.archivedBy
            ? { archivedBy: archivedPresentationRow.archivedBy }
            : {}),
          ...(archivedSessionId ? { sessionId: archivedSessionId } : {}),
        });
        const state = host.readState();
        if (state.result) {
          const archivedRow = {
            ...archivedPresentationRow,
            archived: true,
            archivedAt,
            updatedAt: result.entry?.updatedAt ?? archivedPresentationRow.updatedAt,
            pinned: false,
            pinnedAt: undefined,
          };
          const existingIndex = state.result.sessions.findIndex((row) => row.key === normalizedKey);
          const sessions = [...state.result.sessions];
          if (existingIndex === -1) {
            sessions.push(archivedRow);
          } else {
            sessions[existingIndex] = archivedRow;
          }
          host.publish({
            ...state,
            result: { ...state.result, count: sessions.length, sessions },
          });
        }
      } else if (patchParams.archived === false) {
        confirmedArchives.delete(normalizedKey);
        archiveVisibility.clear(normalizedKey);
      }
      confirmPinPatch();
      if (!options.deferListRefresh) {
        await host.refreshReplacement(options.agentId);
        if (!host.connection.isCurrent(scope)) {
          settleOptimisticPatch(false);
          return (await reconcileConfirmedPreviousConnection(scope, options.agentId))
            ? result
            : null;
        }
      }
      settleOptimisticPatch(true);
      return result;
    } catch (error) {
      settleOptimisticPatch(false);
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      if (ownsModelOverride()) {
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
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
      if (!confirmsSessionDeletion(response)) {
        return { deleted: false };
      }
      if (!host.connection.isCurrent(scope)) {
        return (await reconcileConfirmedPreviousConnection(scope, options.agentId))
          ? {
              deleted: true,
              ...(response.worktreePreserved
                ? { worktreePreserved: response.worktreePreserved }
                : {}),
            }
          : { deleted: false };
      }
      const retireBeforeRevision = Date.now();
      host.retirePullRequestSummary(key);
      confirmedArchives.delete(key.trim());
      archiveVisibility.clear(key);
      preparedWorkSessionKeys.delete(key.trim());
      host.publish({
        ...host.readState(),
        deletedSessions: [
          { key, ...(options.agentId ? { agentId: options.agentId } : {}), retireBeforeRevision },
        ],
      });
      setModelOverride(key, undefined);
      await host.refreshReplacement(options.agentId);
      if (!host.connection.isCurrent(scope)) {
        return (await reconcileConfirmedPreviousConnection(scope, options.agentId))
          ? {
              deleted: true,
              ...(response.worktreePreserved
                ? { worktreePreserved: response.worktreePreserved }
                : {}),
            }
          : { deleted: false };
      }
      return {
        deleted: true,
        ...(response.worktreePreserved ? { worktreePreserved: response.worktreePreserved } : {}),
      };
    } catch (error) {
      if (!host.connection.isCurrent(scope)) {
        return { deleted: false };
      }
      host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
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
    const deletionFacts: SessionState["deletedSessions"][number][] = [];
    const errors: string[] = [];
    const preservedWorktrees: SessionDeleteBatchResult["preservedWorktrees"] = [];
    for (const target of targets) {
      if (!host.connection.isCurrent(scope)) {
        break;
      }
      try {
        const response = await requestSessionDelete(scope.client, target.key, target);
        if (!host.connection.isCurrent(scope)) {
          if (confirmsSessionDeletion(response)) {
            deleted.push(target.key);
            if (response.worktreePreserved) {
              preservedWorktrees.push(response.worktreePreserved);
            }
          }
          return deleted.length > 0 && (await reconcileConfirmedPreviousConnection(scope))
            ? { deleted, errors, preservedWorktrees }
            : { deleted: [], errors: [], preservedWorktrees: [] };
        }
        if (confirmsSessionDeletion(response)) {
          const retireBeforeRevision = Date.now();
          deleted.push(target.key);
          deletionFacts.push({
            key: target.key,
            ...(target.agentId ? { agentId: target.agentId } : {}),
            retireBeforeRevision,
          });
          if (response.worktreePreserved) {
            preservedWorktrees.push(response.worktreePreserved);
          }
        }
      } catch (error) {
        errors.push(formatUiError(error));
      }
    }
    if (!host.connection.isCurrent(scope)) {
      return deleted.length > 0 && (await reconcileConfirmedPreviousConnection(scope))
        ? { deleted, errors, preservedWorktrees }
        : { deleted: [], errors: [], preservedWorktrees: [] };
    }
    if (deleted.length > 0) {
      for (const key of deleted) {
        host.retirePullRequestSummary(key);
        confirmedArchives.delete(key.trim());
        archiveVisibility.clear(key);
        preparedWorkSessionKeys.delete(key.trim());
      }
      host.publish({
        ...host.readState(),
        deletedSessions: deletionFacts,
      });
      for (const key of deleted) {
        setModelOverride(key, undefined);
      }
      await host.refreshReplacement();
      if (!host.connection.isCurrent(scope)) {
        return (await reconcileConfirmedPreviousConnection(scope))
          ? { deleted, errors, preservedWorktrees }
          : { deleted: [], errors: [], preservedWorktrees: [] };
      }
    }
    return { deleted, errors, preservedWorktrees };
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
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      }
      // Reset can commit before awaited lifecycle work rejects; never infer safe retry.
      return "uncertain";
    }
  };

  const assignOwner = async (
    key: string,
    owner: SessionsAssignOwnerParams["owner"],
    options: { agentId?: string | null } = {},
  ): Promise<SessionOwner | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const result = await scope.client.request<SessionsAssignOwnerResult>("sessions.assignOwner", {
        key,
        owner,
        ...(options.agentId ? { agentId: options.agentId } : {}),
      });
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      patchRowLocal(result.key, { owner: result.owner });
      return result.owner;
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      }
      return null;
    }
  };

  return {
    create,
    createResult,
    delete: remove,
    deleteMany: removeMany,
    patch,
    assignOwner,
    patchRowLocal,
    /**
     * Re-asserts in-flight pin intents over canonical Gateway rows: every
     * `sessions.changed` payload and list refresh carries the server's pin
     * state, which is the pre-click value until this operation's patch lands.
     */
    applyPendingPins(result: SessionsListResult | null): SessionsListResult | null {
      if (!result || pendingPinPatches.size === 0) {
        return result;
      }
      let changed = false;
      const sessions = result.sessions.map((row) => {
        const pendingPinPatch = pendingPinPatches.get(row.key);
        // Once the Gateway agrees on `pinned`, its own `pinnedAt` wins again.
        // A row predating a rapid unpin/repin can keep the older stamp for the
        // patch window; that beats overwriting confirmed stamps with our clock.
        if (!pendingPinPatch || (row.pinned === true) === pendingPinPatch.next.pinned) {
          return row;
        }
        changed = true;
        return { ...row, ...pendingPinPatch.next };
      });
      return changed ? { ...result, sessions } : result;
    },
    applyConfirmedArchives(result: SessionsListResult | null): SessionsListResult | null {
      if (!result || confirmedArchives.size === 0) {
        return result;
      }
      let changed = false;
      const sessions = result.sessions.map((row) => {
        const archive = confirmedArchives.get(row.key);
        if (!archive) {
          return row;
        }
        if (archive.sessionId && archive.sessionId !== row.sessionId) {
          // An id-less row may be a same-key replacement whose identity has not arrived.
          // Do not transfer archive state; retire it only after a different identity appears.
          if (row.sessionId) {
            confirmedArchives.delete(row.key);
          }
          return row;
        }
        if (row.archived === true) {
          return row;
        }
        changed = true;
        return {
          ...row,
          archived: true,
          ...(archive.archivedAt !== undefined ? { archivedAt: archive.archivedAt } : {}),
          ...(archive.archivedBy ? { archivedBy: archive.archivedBy } : {}),
        };
      });
      return changed ? { ...result, sessions } : result;
    },
    observeArchiveState(key: string, archived: boolean | null, row?: GatewaySessionRow): void {
      const normalizedKey = key.trim();
      if (!normalizedKey || archived === null) {
        return;
      }
      if (!archived) {
        confirmedArchives.delete(normalizedKey);
        archiveVisibility.clear(normalizedKey);
        return;
      }
      const previous = confirmedArchives.get(normalizedKey);
      confirmedArchives.set(normalizedKey, {
        ...(row?.archivedAt !== undefined
          ? { archivedAt: row.archivedAt }
          : previous?.archivedAt !== undefined
            ? { archivedAt: previous.archivedAt }
            : {}),
        ...(row?.archivedBy
          ? { archivedBy: row.archivedBy }
          : previous?.archivedBy
            ? { archivedBy: previous.archivedBy }
            : {}),
        ...(row?.sessionId
          ? { sessionId: row.sessionId }
          : previous?.sessionId
            ? { sessionId: previous.sessionId }
            : {}),
      });
    },
    reset,
    retireModelOverride,
    archiveVisibility: archiveVisibility.get,
    setArchiveVisibility: (key: string, visibility: SessionArchiveVisibility | undefined) =>
      archiveVisibility.set(key, visibility),
    isPreparedWorkSession: (key: string) => preparedWorkSessionKeys.has(key.trim()),
    settlePrepared(result: SessionsListResult | null) {
      archiveVisibility.settle(result);
      for (const row of result?.sessions ?? []) {
        if (row.modelOverrideSource !== undefined && pendingCreatedModelOverrides.has(row.key)) {
          setModelOverride(row.key, undefined);
        }
        if (row.worktree || row.execNode) {
          preparedWorkSessionKeys.delete(row.key);
        }
      }
    },
    retireConnection() {
      pendingCreatedModelOverrides.clear();
      pendingModelPatches.clear();
      // Pin intents live inside `result`, which the replacement connection
      // rehydrates wholesale; only the model-override side map outlives that
      // replacement, so it is the one that needs an explicit rollback below.
      pendingPinPatches.clear();
      confirmedArchives.clear();
      archiveVisibility.clearAll();
      preparedWorkSessionKeys.clear();
      const state = host.readState();
      host.publish({ ...state, modelOverrides: {} });
    },
    dispose() {
      pendingCreatedModelOverrides.clear();
      pendingModelPatches.clear();
      pendingPinPatches.clear();
      confirmedArchives.clear();
      archiveVisibility.clearAll();
      preparedWorkSessionKeys.clear();
    },
  };
}
