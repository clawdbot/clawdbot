import type { SessionOwner } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { normalizeAgentId, normalizeDefaultMainSessionAliasForUi } from "./session-key.ts";

type ConfirmedOwnerClaim = {
  confirmedAtRevision: number;
  id: string;
  owner: SessionOwner;
  scopeRevisions: Map<string, number>;
  sessionId?: string;
};

function assignmentKey(key: string, agentId?: string | null): string {
  return `${normalizeDefaultMainSessionAliasForUi(key)}\0agent:${normalizeAgentId(agentId ?? "")}`;
}

function rowAssignmentKey(row: GatewaySessionRow, agentId?: string | null): string {
  return assignmentKey(row.key, row.agentId ?? agentId);
}

function ownersMatch(left: SessionOwner | undefined, right: SessionOwner): boolean {
  return (
    left?.actor.type === right.actor.type &&
    left.actor.id === right.actor.id &&
    left.assignedBy?.type === right.assignedBy?.type &&
    left.assignedBy?.id === right.assignedBy?.id &&
    left.assignedAt === right.assignedAt
  );
}

export function createSessionOwnerAssignmentOverlay() {
  const assignmentQueues = new Map<string, Promise<unknown>>();
  const claims = new Map<string, ConfirmedOwnerClaim>();
  let queueEpoch = 0;

  const enqueue = <T>(
    key: string,
    agentId: string | null | undefined,
    run: () => Promise<T>,
  ): Promise<T | null> => {
    const id = assignmentKey(key, agentId);
    const previous = assignmentQueues.get(id) ?? Promise.resolve();
    const epoch = queueEpoch;
    const current = previous
      .catch(() => undefined)
      .then(() => (epoch === queueEpoch ? run() : null));
    assignmentQueues.set(id, current);
    const retire = () => {
      if (assignmentQueues.get(id) === current) {
        assignmentQueues.delete(id);
      }
    };
    void current.then(retire, retire);
    return current;
  };

  return {
    enqueue,
    confirm(
      key: string,
      owner: SessionOwner,
      confirmedAtRevision: number,
      scopeRevisions: ReadonlyMap<string, number>,
      sessionId?: string,
      agentId?: string | null,
    ): SessionOwner {
      const id = assignmentKey(key, agentId);
      claims.set(id, {
        confirmedAtRevision,
        id,
        owner,
        scopeRevisions: new Map(scopeRevisions),
        ...(sessionId ? { sessionId } : {}),
      });
      return owner;
    },
    retire(key: string, agentId?: string | null): void {
      claims.delete(assignmentKey(key, agentId));
    },
    clear(): void {
      queueEpoch += 1;
      assignmentQueues.clear();
      claims.clear();
    },
    decorate(
      result: SessionsListResult | null,
      scope?: string,
      requestRevision?: number,
      agentId?: string | null,
    ): SessionsListResult | null {
      if (!result || claims.size === 0) {
        return result;
      }
      let invalidateOwners = scope
        ? [...claims.values()].some((claim) => {
            const scopeRevision = claim.scopeRevisions.get(scope);
            if (scopeRevision === undefined) {
              return false;
            }
            const row = result.sessions.find(
              (candidate) => rowAssignmentKey(candidate, agentId) === claim.id,
            );
            if (claim.sessionId && row?.sessionId && claim.sessionId !== row.sessionId) {
              return false;
            }
            return (
              !ownersMatch(row?.owner, claim.owner) &&
              !(requestRevision !== undefined && requestRevision > scopeRevision && !row)
            );
          })
        : false;
      const sessions = result.sessions.map((row) => {
        const id = rowAssignmentKey(row, agentId);
        const claim = claims.get(id);
        if (!claim) {
          return row;
        }
        if (claim.sessionId && row.sessionId && claim.sessionId !== row.sessionId) {
          return row;
        }
        if (ownersMatch(row.owner, claim.owner)) {
          return row;
        }
        invalidateOwners = true;
        return { ...row, owner: claim.owner };
      });
      return invalidateOwners ? { ...result, sessions, owners: undefined } : result;
    },
    observeCanonical(
      result: SessionsListResult | null,
      requestRevision: number,
      scope: string | undefined,
      agentId?: string | null,
    ): void {
      if (!scope) {
        return;
      }
      for (const [id, claim] of claims) {
        const scopeRevision = claim.scopeRevisions.get(scope);
        const row = result?.sessions.find(
          (candidate) => rowAssignmentKey(candidate, agentId) === id,
        );
        if (requestRevision <= claim.confirmedAtRevision) {
          continue;
        }
        if (claim.sessionId && row?.sessionId && claim.sessionId !== row.sessionId) {
          claims.delete(id);
          continue;
        }
        if (row?.owner && !ownersMatch(row.owner, claim.owner)) {
          claim.owner = row.owner;
          if (row.sessionId) {
            claim.sessionId = row.sessionId;
          }
        }
        if (scopeRevision !== undefined) {
          claim.scopeRevisions.delete(scope);
        }
        if (claim.scopeRevisions.size === 0) {
          claims.delete(id);
        }
      }
    },
    observeRow(row: GatewaySessionRow | undefined, agentId?: string | null): void {
      if (!row) {
        return;
      }
      const id = rowAssignmentKey(row, agentId);
      const claim = claims.get(id);
      if (!claim) {
        return;
      }
      if (claim.sessionId && row.sessionId && claim.sessionId !== row.sessionId) {
        claims.delete(id);
      } else if (row.owner && !ownersMatch(row.owner, claim.owner)) {
        claim.owner = row.owner;
        if (row.sessionId) {
          claim.sessionId = row.sessionId;
        }
      }
    },
    retireScope(scope: string): void {
      for (const [key, claim] of claims) {
        if (claim.scopeRevisions.delete(scope) && claim.scopeRevisions.size === 0) {
          claims.delete(key);
        }
      }
    },
  };
}
