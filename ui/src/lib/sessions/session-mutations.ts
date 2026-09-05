import type {
  SessionOwner,
  SessionsAssignOwnerParams,
  SessionsAssignOwnerResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import {
  requestSessionCreate,
  resolveSessionCreateParams,
  type SessionCreateParams,
  type SessionCreateOutcome,
} from "./create.ts";
import type { SessionPatch, SessionPatchOptions, SessionPatchResult } from "./patch.ts";
import { createSessionArchiveState } from "./session-archive-state.ts";
import type {
  SessionCapability,
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionCreateReconciliation,
  SessionResetOptions,
  SessionResetResult,
  SessionState,
} from "./session-capability.ts";
import { areUiSessionKeysEquivalent } from "./session-key.ts";
import { requestSessionPatch, requestSessionReset } from "./session-requests.ts";
import type { SessionRefreshOutcome } from "./session-roster-refresh.ts";

/** The Gateway's single pin fact: `pinned` is a projection of `pinnedAt`. */
type SessionPinFields = { pinned: boolean; pinnedAt: number | undefined };
/** `canonical` is what the Gateway confirmed; `previous` is the value the intent replaced. */
type PendingRowPatch<T> = { token: symbol; previous: T; next: T; canonical: T };

type SessionMutationsHost = {
  connection: SessionConnectionOwner;
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  refreshReplacement: SessionCapability["refreshReplacement"];
  refreshReplacementResult: (agentId?: string | null) => Promise<SessionRefreshOutcome>;
  publishedRow: (key: string) => GatewaySessionRow | undefined;
  redecorateLists: () => void;
  notifyCreated: (key: string, entry?: SessionCreateOutcome["entry"], agentId?: string) => void;
  clearThink: (key: string, agentId?: string | null) => void;
  claimPermissionProjection: (key: string, agentId?: string | null) => () => boolean;
  retirePullRequestSummary: (key: string) => void;
};

function createOptimisticRowPatches<T>(
  host: Pick<SessionMutationsHost, "publishedRow" | "redecorateLists">,
  fields: {
    read: (row: GatewaySessionRow | undefined) => T;
    write: (row: GatewaySessionRow, next: T) => GatewaySessionRow;
  },
) {
  const pending = new Map<string, PendingRowPatch<T>>();
  return {
    start(key: string, next: T): symbol {
      const token = Symbol("session-row-patch");
      const current = pending.get(key);
      pending.set(key, {
        token,
        previous: current ? current.previous : fields.read(host.publishedRow(key)),
        next,
        canonical: next,
      });
      host.redecorateLists();
      return token;
    },
    confirm(key: string, token: symbol, confirmed: T): void {
      const current = pending.get(key);
      if (!current) {
        return;
      }
      if (current.token === token) {
        current.canonical = confirmed;
      } else {
        current.previous = confirmed;
      }
    },
    settle(key: string, token: symbol, completed: boolean, connectionCurrent: boolean): void {
      const current = pending.get(key);
      if (!current || current.token !== token) {
        return;
      }
      if (connectionCurrent) {
        // Decoration writes the intent into the published snapshot, so releasing
        // it cannot restore a value it overwrote. Project the settled truth once
        // more first, or a canonical row that disagrees with the optimistic
        // value stays hidden until an unrelated update arrives.
        current.next = completed ? current.canonical : current.previous;
        host.redecorateLists();
      }
      pending.delete(key);
    },
    apply(result: SessionsListResult | null): SessionsListResult | null {
      if (!result || pending.size === 0) {
        return result;
      }
      let changed = false;
      const sessions = result.sessions.map((row) => {
        const patch = pending.get(row.key);
        if (!patch) {
          return row;
        }
        const next = fields.write(row, patch.next);
        changed ||= next !== row;
        return next;
      });
      return changed ? { ...result, sessions } : result;
    },
    clear: () => pending.clear(),
  };
}

export function createSessionMutations(host: SessionMutationsHost) {
  const pendingModelPatches = new Map<
    string,
    {
      token: symbol;
      previous: { value: string | null | undefined; created: boolean };
      revision: number;
    }
  >();
  const archiveState = createSessionArchiveState(host.publishedRow, () =>
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

  const patchRowLocal = (
    key: string,
    patch: Partial<GatewaySessionRow>,
    expectedSessionId?: string,
  ) => {
    const state = host.readState();
    const normalizedKey = key.trim();
    if (!state.result || !normalizedKey) {
      return;
    }
    let changed = false;
    const sessions = state.result.sessions.map((row) => {
      if (
        !areUiSessionKeysEquivalent(row.key, normalizedKey) ||
        (expectedSessionId !== undefined && row.sessionId !== expectedSessionId)
      ) {
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

  const optimisticPins = createOptimisticRowPatches(host, {
    read: (row) => pinRowFields(row?.pinned === true, row?.pinnedAt),
    // Once the Gateway agrees on `pinned`, its own timestamp wins again.
    write: (row, next) => ((row.pinned === true) === next.pinned ? row : { ...row, ...next }),
  });
  const optimisticUnread = createOptimisticRowPatches(host, {
    read: (row) => row?.unread,
    write: (row, unread) => (row.unread === unread ? row : { ...row, unread }),
  });

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
  ): Promise<SessionPatchResult | null> => {
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
    let ownsPermissionProjection = () => true;
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
    let pinPatchToken: symbol | null = null;
    // Sidebar rows read `pinned` straight off the snapshot, so a pin/unpin has
    // no visible outcome until this flip; the Gateway patch and its list
    // refresh confirm it afterwards.
    const startPinPatch = () => {
      if (patchParams.pinned === undefined || pinPatchToken) {
        return;
      }
      const row = host.publishedRow(normalizedKey);
      pinPatchToken = optimisticPins.start(normalizedKey, pinRowFields(nextPinned, row?.pinnedAt));
    };
    let unreadPatchToken: symbol | null = null;
    const startUnreadPatch = () => {
      // Mark-unread needs the Gateway-issued marker before an active pane can
      // distinguish the explicit reminder from new activity. Reads are safe
      // to project immediately because their observed marker remains attached.
      if (patchParams.unread !== false || unreadPatchToken) {
        return;
      }
      unreadPatchToken = optimisticUnread.start(normalizedKey, false);
    };
    const startOptimisticPatch = () => {
      startModelPatch();
      startPinPatch();
      startUnreadPatch();
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
      if (pinPatchToken) {
        optimisticPins.confirm(normalizedKey, pinPatchToken, pinRowFields(nextPinned, undefined));
      }
    };
    const settlePinPatch = (completed: boolean) => {
      if (pinPatchToken) {
        optimisticPins.settle(
          normalizedKey,
          pinPatchToken,
          completed,
          host.connection.isCurrent(scope),
        );
      }
    };
    // A conditional read acknowledgement settles successfully without applying
    // when a newer manual mark-unread owns the row: the Gateway returns that
    // entry with its marker intact and broadcasts no change. A present marker
    // is unread by definition, so it is the value this intent settles to.
    const confirmUnreadPatch = (entry: SessionPatchResult["entry"] | undefined) => {
      if (unreadPatchToken) {
        optimisticUnread.confirm(
          normalizedKey,
          unreadPatchToken,
          entry?.markedUnreadAt !== undefined,
        );
      }
    };
    const settleUnreadPatch = (completed: boolean) => {
      if (unreadPatchToken) {
        optimisticUnread.settle(
          normalizedKey,
          unreadPatchToken,
          completed,
          host.connection.isCurrent(scope),
        );
      }
    };
    const settleOptimisticPatch = (completed: boolean) => {
      settleModelOverride(completed);
      settlePinPatch(completed);
      settleUnreadPatch(completed);
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
      if (Object.hasOwn(patchParams, "permissionMode")) {
        ownsPermissionProjection = host.claimPermissionProjection(key, options.agentId);
      }
      const result = await requestSessionPatch(scope.client, key, patchParams, options);
      if (!host.connection.isCurrent(scope)) {
        settleOptimisticPatch(false);
        return (await reconcileConfirmedPreviousConnection(scope, options.agentId)) ? result : null;
      }
      if (Object.hasOwn(patchParams, "thinkingLevel")) {
        host.clearThink(normalizedKey, options.agentId);
      }
      if (Object.hasOwn(patchParams, "permissionMode")) {
        if (!ownsPermissionProjection()) {
          settleOptimisticPatch(true);
          return result;
        }
        // The successful RPC is the first durable acknowledgement; events may
        // drop and the follow-up list may fail, so record its fenced fact now.
        patchRowLocal(
          key,
          {
            permissionMode: result.entry?.permissionMode,
            ...(result.entry?.updatedAt === undefined ? {} : { updatedAt: result.entry.updatedAt }),
          },
          result.entry?.sessionId,
        );
      }
      if (archivedPresentationRow) {
        const archivedAt = result.entry?.archivedAt ?? Date.now();
        const archivedSessionId = result.entry?.sessionId ?? archivedPresentationRow.sessionId;
        archiveState.observe(normalizedKey, true, {
          ...archivedPresentationRow,
          archivedAt,
          archiveReason: result.entry?.archiveReason,
          sessionId: archivedSessionId,
        });
        const state = host.readState();
        if (state.result) {
          const archivedRow = {
            ...archivedPresentationRow,
            archived: true,
            archivedAt,
            archiveReason: result.entry?.archiveReason,
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
        archiveState.clear(normalizedKey);
      }
      confirmPinPatch();
      confirmUnreadPatch(result?.entry);
      // Commit and list reconciliation are separate outcomes. Callers must not
      // turn a failed refresh into an apparent rollback of the committed patch.
      let refreshOutcome: SessionRefreshOutcome = { status: "refreshed" };
      if (!options.deferListRefresh) {
        if (Object.hasOwn(patchParams, "permissionMode")) {
          refreshOutcome = await host.refreshReplacementResult(options.agentId);
        } else {
          await host.refreshReplacement(options.agentId);
        }
        if (!host.connection.isCurrent(scope)) {
          settleOptimisticPatch(false);
          return (await reconcileConfirmedPreviousConnection(scope, options.agentId))
            ? result
            : null;
        }
        if (Object.hasOwn(patchParams, "permissionMode") && !ownsPermissionProjection()) {
          settleOptimisticPatch(true);
          return result;
        }
      }
      settleOptimisticPatch(true);
      return refreshOutcome.status === "failed"
        ? { ...result, listRefreshError: refreshOutcome.error }
        : result;
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
    reconcileConfirmedPreviousConnection,
    retireDeletedSession(this: void, key: string) {
      host.retirePullRequestSummary(key);
      archiveState.clear(key);
      preparedWorkSessionKeys.delete(key.trim());
      setModelOverride(key, undefined);
    },
    patch,
    assignOwner,
    patchRowLocal,
    /**
     * Re-asserts in-flight row intents over Gateway events and list refreshes,
     * which carry the pre-mutation value until the patch lands.
     */
    applyPendingRows(result: SessionsListResult | null): SessionsListResult | null {
      return optimisticUnread.apply(optimisticPins.apply(result));
    },
    applyConfirmedArchives: archiveState.apply,
    observeArchiveState: archiveState.observe,
    reset,
    retireModelOverride,
    archiveVisibility: archiveState.visibility,
    setArchivePending: archiveState.setPending,
    isPreparedWorkSession: (key: string) => preparedWorkSessionKeys.has(key.trim()),
    settlePrepared(result: SessionsListResult | null) {
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
      // Row intents live inside `result`, which the replacement connection
      // rehydrates wholesale; only the model-override side map outlives that
      // replacement, so it is the one that needs an explicit rollback below.
      optimisticPins.clear();
      optimisticUnread.clear();
      archiveState.clearAll();
      preparedWorkSessionKeys.clear();
      const state = host.readState();
      host.publish({ ...state, modelOverrides: {} });
    },
    dispose() {
      pendingCreatedModelOverrides.clear();
      pendingModelPatches.clear();
      optimisticPins.clear();
      optimisticUnread.clear();
      archiveState.clearAll();
      preparedWorkSessionKeys.clear();
    },
  };
}
