import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { showToast } from "../toast.ts";
import type { readSessionChangedEvent } from "./reconcile.ts";
import type {
  SessionConnectionOwner,
  SessionDeleteBatchResult,
  SessionDeleteOptions,
  SessionDeleteOutcome,
  SessionDeleteTarget,
  SessionGateway,
  SessionListScope,
  SessionState,
} from "./session-capability.ts";
import {
  normalizeAgentId,
  resolveUiConversationIdentity,
  resolveUiSelectedGlobalAgentId,
} from "./session-key.ts";
import { requestSessionDelete } from "./session-requests.ts";

type Deletion = {
  target: SessionDeleteTarget;
  sessionId?: string;
  phase: "pending" | "confirmed" | "rollback";
  owner: DeletionOwner;
  rows: WeakMap<object, { row: GatewaySessionRow; index: number }>;
  operation?: Promise<SessionDeleteOutcome>;
};

type DeletionOwner = {
  sessionId?: string;
  revision: number;
  active?: Deletion;
  records: Set<Deletion>;
};

type DeletionHost = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  requestRevision: () => number;
  readState: () => SessionState;
  publish: (state: SessionState, source?: "operation") => void;
  publishedRow: (
    matches: (row: GatewaySessionRow, agentId?: string | null) => boolean,
  ) => GatewaySessionRow | undefined;
  redecorateLists: () => void;
  invalidateLists: () => void;
  refreshReplacement: (agentId?: string | null) => Promise<void>;
  reconcilePreviousConnection: (
    scope: NonNullable<ReturnType<SessionConnectionOwner["capture"]>>,
    agentId?: string | null,
  ) => Promise<boolean>;
  retire: (key: string) => void;
};

export function createSessionDeletions(host: DeletionHost) {
  // Canonical generation and request order outlive an individual mutation,
  // including rollback. Retired IDs share this owner with the active claim.
  const deletions = new Map<string, DeletionOwner>();
  const prepareIdentity = () => {
    const snapshot = host.snapshot();
    const selectedAgentId = resolveUiSelectedGlobalAgentId(snapshot);
    return (key: string, agentId?: string | null) => {
      const canonical = resolveUiConversationIdentity(snapshot, key, agentId ?? undefined);
      return `${canonical.sessionKey}\0${canonical.agentId ?? normalizeAgentId(agentId ?? selectedAgentId)}`;
    };
  };
  const identity = (key: string, agentId?: string | null) => prepareIdentity()(key, agentId);
  const find = (owner: DeletionOwner | undefined, sessionId?: string) => {
    for (const deletion of owner?.records ?? []) {
      if (sessionId && deletion.sessionId === sessionId) {
        return deletion;
      }
    }
    return owner?.active;
  };
  const owns = (deletion: Deletion) =>
    deletions.get(identity(deletion.target.key, deletion.target.agentId)) === deletion.owner &&
    deletion.owner.records.has(deletion);
  const acceptsGeneration = (owner: DeletionOwner | undefined, sessionId?: string) =>
    !owner?.sessionId || !sessionId || owner.sessionId === sessionId;
  const reportError = (message: string) => {
    host.publish({ ...host.readState(), error: message }, "operation");
    // The initiating header/organizer may already be retired by navigation or reconnect.
    showToast({ message });
  };
  const stateOf = (deletion: Deletion | undefined, sessionId?: string) => {
    if (
      !deletion ||
      deletion.phase === "rollback" ||
      !(sessionId && deletion.sessionId
        ? sessionId === deletion.sessionId
        : deletion.owner.active === deletion)
    ) {
      return undefined;
    }
    return deletion.phase;
  };
  const publish = (confirmed?: Deletion) => {
    host.publish({
      ...host.readState(),
      deletedSessions:
        confirmed && confirmed.owner.active === confirmed
          ? [
              {
                key: confirmed.target.key,
                ...(confirmed.target.agentId ? { agentId: confirmed.target.agentId } : {}),
                retireBeforeRevision: Date.now(),
              },
            ]
          : [],
    });
    host.redecorateLists();
  };
  const begin = (target: SessionDeleteTarget): Deletion => {
    const id = identity(target.key, target.agentId);
    let owner = deletions.get(id);
    if (!owner) {
      owner = {
        sessionId: host.publishedRow(
          (row, agentId) => identity(row.key, row.agentId ?? agentId) === id,
        )?.sessionId,
        revision: host.requestRevision(),
        records: new Set(),
      };
      deletions.set(id, owner);
    }
    const sessionId = target.expectedSessionId ?? owner.sessionId;
    const existing = find(owner, sessionId);
    if (
      existing &&
      (owner.active === existing || existing.phase === "pending") &&
      (!sessionId || existing.sessionId === sessionId)
    ) {
      return existing;
    }
    const deletion: Deletion = { target, sessionId, owner, phase: "pending", rows: new WeakMap() };
    // A stale confirmation still sends its selected ID, without claiming a
    // published successor or letting earlier roster requests retire its intent.
    if (!sessionId || !owner.sessionId || sessionId === owner.sessionId) {
      owner.active = deletion;
      owner.sessionId = sessionId;
      owner.revision = host.requestRevision();
    }
    owner.records.add(deletion);
    return deletion;
  };
  const rollback = (deletion: Deletion) => {
    if (!owns(deletion) || deletion.phase === "confirmed") {
      return;
    }
    // Restore only rows removed from this query; newer rows and unrelated
    // mutations keep their current values. Never restore a whole snapshot.
    deletion.phase = "rollback";
    host.redecorateLists();
    deletion.owner.records.delete(deletion);
    if (deletion.owner.active === deletion) {
      deletion.owner.active = undefined;
    }
    publish();
    // Rejection can follow a server commit. Roll back only the UI intent,
    // then let the current roster queries reconcile authoritative membership.
    host.invalidateLists();
  };
  const confirm = (deletion: Deletion, key: string) => {
    if (deletion.phase === "confirmed") {
      return;
    }
    deletion.phase = "confirmed";
    if (!deletion.sessionId) {
      deletion.owner.revision = host.requestRevision();
    }
    deletion.rows = new WeakMap();
    if (deletion.owner.active === deletion) {
      host.retire(key);
    }
    publish(deletion);
  };
  const perform = (
    deletion: Deletion,
    scope: NonNullable<ReturnType<SessionConnectionOwner["capture"]>>,
  ): Promise<SessionDeleteOutcome> => {
    if (deletion.operation) {
      return deletion.operation;
    }
    const { target } = deletion;
    deletion.operation = (async () => {
      try {
        const response = await requestSessionDelete(scope.client, target.key, target);
        if (!owns(deletion)) {
          return { deleted: false };
        }
        if (!response.deleted && deletion.phase !== "confirmed") {
          rollback(deletion);
          return { deleted: false };
        }
        confirm(deletion, target.key);
        return {
          deleted: true,
          ...(response.worktreePreserved ? { worktreePreserved: response.worktreePreserved } : {}),
        };
      } catch (error) {
        if (!owns(deletion)) {
          return { deleted: false };
        }
        rollback(deletion);
        const message = formatUiError(error);
        reportError(message);
        throw error;
      }
    })();
    return deletion.operation;
  };

  const removeMany = async (
    targets: readonly SessionDeleteTarget[],
  ): Promise<SessionDeleteBatchResult> => {
    const scope = host.connection.capture();
    const result: SessionDeleteBatchResult = { deleted: [], errors: [], preservedWorktrees: [] };
    if (!scope || targets.length === 0) {
      return result;
    }
    // Claim the complete selection before the first RPC. Cloud teardown may
    // take time, but the remaining selected rows must disappear together.
    const records = new Map<Deletion, Set<string>>();
    for (const target of targets) {
      const record = begin(target);
      const keys = records.get(record) ?? new Set<string>();
      keys.add(target.key);
      records.set(record, keys);
    }
    publish();
    for (const [record, keys] of records) {
      if (!host.connection.isCurrent(scope) && !record.operation) {
        const unstarted = [...records.keys()].filter(
          (candidate) => !candidate.operation && owns(candidate),
        );
        for (const candidate of unstarted) {
          rollback(candidate);
        }
        if (unstarted.length > 0) {
          const message = t("sessionsView.deleteSessionsStale", { count: String(targets.length) });
          reportError(message);
          result.errors.push(message);
        }
        break;
      }
      try {
        const outcome = await perform(record, scope);
        if (outcome.deleted) {
          result.deleted.push(...keys);
          if (outcome.worktreePreserved) {
            result.preservedWorktrees.push(outcome.worktreePreserved);
          }
        }
      } catch (error) {
        result.errors.push(formatUiError(error));
      }
    }
    if (result.deleted.length > 0) {
      if (host.connection.isCurrent(scope)) {
        await host.refreshReplacement(targets.length === 1 ? targets[0]?.agentId : undefined);
      }
      if (!host.connection.isCurrent(scope) && !(await host.reconcilePreviousConnection(scope))) {
        return { deleted: [], errors: [], preservedWorktrees: [] };
      }
    }
    return result;
  };

  return {
    acceptsGeneration: (key: string, sessionId?: string, agentId?: string | null) =>
      acceptsGeneration(deletions.get(identity(key, agentId)), sessionId),
    deletionState: (key: string, agentId?: string | null, sessionId?: string) =>
      stateOf(find(deletions.get(identity(key, agentId)), sessionId), sessionId),
    deleteMany: removeMany,
    async delete(
      this: void,
      key: string,
      options: SessionDeleteOptions = {},
    ): Promise<SessionDeleteOutcome> {
      const result = await removeMany([{ key, ...options }]);
      if (result.errors.length > 0) {
        throw new Error(result.errors.join("; "));
      }
      return {
        deleted: result.deleted.includes(key),
        ...(result.preservedWorktrees[0]
          ? { worktreePreserved: result.preservedWorktrees[0] }
          : {}),
      };
    },
    apply(
      result: SessionsListResult | null,
      owner: { scope: SessionListScope },
    ): SessionsListResult | null {
      if (!result || deletions.size === 0) {
        return result;
      }
      // A projection shares one snapshot of alias defaults; the next projection
      // prepares them again so reconnects never retain stale session identities.
      const identify = prepareIdentity();
      let rows = result.sessions;
      for (const [id, generation] of deletions) {
        for (const deletion of generation.records) {
          const saved = deletion.rows.get(owner);
          if (
            deletion.phase === "rollback" &&
            generation.active === deletion &&
            saved &&
            !rows.some((row) => identify(row.key, row.agentId ?? owner.scope.agentId) === id)
          ) {
            if (rows === result.sessions) {
              rows = rows.slice();
            }
            rows.splice(saved.index, 0, saved.row);
          }
        }
      }
      const sessions = rows.filter((row, index) => {
        const agentId = row.agentId ?? owner.scope.agentId;
        const generation = deletions.get(identify(row.key, agentId));
        if (!acceptsGeneration(generation, row.sessionId)) {
          return false;
        }
        const current = find(generation, row.sessionId);
        if (!stateOf(current, row.sessionId)) {
          return true;
        }
        if (current?.phase === "pending") {
          current.rows.set(owner, { row, index });
        }
        return false;
      });
      return sessions.length === result.sessions.length &&
        sessions.every((row, index) => row === result.sessions[index])
        ? result
        : {
            ...result,
            count: sessions.length,
            // totalCount/offset describe the server's pagination window. Only
            // its next response can change them; row overlays must not shift it.
            sessions,
          };
    },
    reconcileList(result: SessionsListResult | null, issuedRevision: number, agentId?: string) {
      if (!result) {
        return result;
      }
      const identify = prepareIdentity();
      const sessions = result.sessions.filter((row) => {
        const id = identify(row.key, row.agentId ?? agentId);
        let owner = deletions.get(id);
        if (!owner) {
          owner = { revision: issuedRevision, sessionId: row.sessionId, records: new Set() };
          deletions.set(id, owner);
        } else if (row.sessionId && row.sessionId !== owner.sessionId) {
          // Only a later canonical read establishes a successor. Cached rows,
          // history and events pass through the pure generation filter in apply.
          if (
            issuedRevision <= owner.revision ||
            find(owner, row.sessionId)?.sessionId === row.sessionId
          ) {
            return false;
          }
          if (owner.active?.phase === "pending" && !owner.active.sessionId) {
            return true;
          }
          owner.sessionId = row.sessionId;
          owner.active = undefined;
        }
        owner.revision = Math.max(owner.revision, issuedRevision);
        return true;
      });
      return sessions.length === result.sessions.length
        ? result
        : { ...result, sessions, count: sessions.length };
    },
    observe(event: NonNullable<ReturnType<typeof readSessionChangedEvent>>) {
      const { key, agentId, reason, sessionId } = event;
      if (reason === "delete") {
        if (!sessionId) {
          host.invalidateLists();
          return;
        }
        const deletion = begin({
          key,
          expectedSessionId: sessionId,
          ...(agentId ? { agentId } : {}),
        });
        confirm(deletion, key);
      } else if (reason === "create" || reason === "new") {
        const deletion = find(deletions.get(identity(key, agentId)));
        if (deletion?.phase === "confirmed") {
          deletion.owner.active = undefined;
          publish();
        }
      }
    },
    clear: () => deletions.clear(),
  };
}
