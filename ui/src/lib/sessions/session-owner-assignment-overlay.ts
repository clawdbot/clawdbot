import type { SessionOwner } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionsListResult } from "../../api/types.ts";

type ConfirmedOwnerClaim = {
  confirmedScopes: Set<string>;
  key: string;
  owner: SessionOwner;
  scopeRevisions: Map<string, number>;
  sessionId?: string;
};

function ownersMatch(left: SessionOwner | undefined, right: SessionOwner): boolean {
  return (
    left?.actor.type === right.actor.type &&
    left.actor.id === right.actor.id &&
    left.assignedBy?.type === right.assignedBy?.type &&
    left.assignedBy?.id === right.assignedBy?.id &&
    left.assignedAt === right.assignedAt
  );
}

function ownerSupersedes(current: SessionOwner | undefined, confirmed: SessionOwner): boolean {
  return (
    current?.assignedAt !== undefined &&
    confirmed.assignedAt !== undefined &&
    current.assignedAt > confirmed.assignedAt
  );
}

export function createSessionOwnerAssignmentOverlay() {
  const assignmentQueues = new Map<string, Promise<unknown>>();
  const claims = new Map<string, ConfirmedOwnerClaim>();
  let queueEpoch = 0;

  const forget = (key: string): void => {
    assignmentQueues.delete(key);
    claims.delete(key);
  };

  const settleConfirmed = (claim: ConfirmedOwnerClaim): void => {
    if (claims.get(claim.key) !== claim) {
      return;
    }
    for (const scope of claim.confirmedScopes) {
      claim.scopeRevisions.delete(scope);
    }
    claim.confirmedScopes.clear();
    if (claim.scopeRevisions.size === 0) {
      claims.delete(claim.key);
    }
  };

  const enqueue = <T>(key: string, run: () => Promise<T>): Promise<T | null> => {
    const normalizedKey = key.trim();
    const previous = assignmentQueues.get(normalizedKey) ?? Promise.resolve();
    const epoch = queueEpoch;
    const current = previous
      .catch(() => undefined)
      .then(() => (epoch === queueEpoch ? run() : null));
    assignmentQueues.set(normalizedKey, current);
    const retire = () => {
      if (assignmentQueues.get(normalizedKey) === current) {
        assignmentQueues.delete(normalizedKey);
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
      scopeRevisions: ReadonlyMap<string, number>,
      sessionId?: string,
    ): ConfirmedOwnerClaim {
      const normalizedKey = key.trim();
      const claim = {
        confirmedScopes: new Set<string>(),
        key: normalizedKey,
        owner,
        scopeRevisions: new Map(scopeRevisions),
        ...(sessionId ? { sessionId } : {}),
      };
      claims.set(normalizedKey, claim);
      return claim;
    },
    retire(key: string): void {
      forget(key.trim());
    },
    settleConfirmed,
    settleOn(reconciliation: Promise<void>, claim: ConfirmedOwnerClaim): void {
      void reconciliation.then(() => settleConfirmed(claim));
    },
    clear(): void {
      queueEpoch += 1;
      assignmentQueues.clear();
      claims.clear();
    },
    decorate: (
      result: SessionsListResult | null,
      scope?: string,
      requestRevision?: number,
    ): SessionsListResult | null => {
      if (!result || claims.size === 0) {
        return result;
      }
      let invalidateOwners = scope
        ? [...claims.values()].some((claim) => {
            const scopeRevision = claim.scopeRevisions.get(scope);
            if (scopeRevision === undefined) {
              return false;
            }
            const row = result.sessions.find((candidate) => candidate.key === claim.key);
            return (
              !ownersMatch(row?.owner, claim.owner) &&
              !(requestRevision !== undefined && requestRevision > scopeRevision && !row)
            );
          })
        : false;
      const sessions = result.sessions.map((row) => {
        const claim = claims.get(row.key);
        if (!claim) {
          return row;
        }
        if (claim.sessionId && row.sessionId && claim.sessionId !== row.sessionId) {
          forget(row.key);
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
    observeCanonical: (
      result: SessionsListResult | null,
      requestRevision: number,
      scope: string | undefined,
    ): void => {
      if (!scope) {
        return;
      }
      for (const [key, claim] of claims) {
        const scopeRevision = claim.scopeRevisions.get(scope);
        if (scopeRevision === undefined) {
          continue;
        }
        const row = result?.sessions.find((candidate) => candidate.key === key);
        if (claim.sessionId && row?.sessionId && claim.sessionId !== row.sessionId) {
          forget(key);
          continue;
        }
        if (row?.owner && ownerSupersedes(row.owner, claim.owner)) {
          claim.owner = row.owner;
          if (row.sessionId) {
            claim.sessionId = row.sessionId;
          }
          claim.confirmedScopes.add(scope);
          continue;
        }
        if (ownersMatch(row?.owner, claim.owner) || (requestRevision > scopeRevision && !row)) {
          claim.confirmedScopes.add(scope);
        }
      }
    },
    retireScope: (scope: string): void => {
      for (const [key, claim] of claims) {
        claim.confirmedScopes.delete(scope);
        if (claim.scopeRevisions.delete(scope) && claim.scopeRevisions.size === 0) {
          claims.delete(key);
        }
      }
    },
  };
}
