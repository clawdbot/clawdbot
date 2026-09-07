import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  reconcileSessionChanged,
  type SessionChangedResult,
  type readSessionChangedEvent,
} from "./reconcile.ts";
import type { SessionGateway } from "./session-capability.ts";
import { resolveUiConversationIdentity } from "./session-key.ts";
import type { PublishedSession } from "./session-list-query.ts";

type PermissionFields = Pick<GatewaySessionRow, "sessionId" | "permissionMode" | "updatedAt">;
export type SessionPermissionClaim = {
  isCurrent: () => boolean;
  confirm: (row: PermissionFields) => "confirmed" | "superseded" | "refresh";
};

type PermissionProjectionRoster = {
  readonly requestRevision: number;
  publishedSession: (
    matches: (row: GatewaySessionRow, agentId?: string | null) => boolean,
  ) => PublishedSession | undefined;
};

// Claims and confirmed fields share one conversation owner. A row event may
// supersede its permission choice, but never owns an unrelated roster load.
export function createSessionPermissionProjection(
  gateway: Pick<SessionGateway, "snapshot">,
  getRoster: () => PermissionProjectionRoster,
) {
  const permissionProjections = new Map<
    string,
    {
      sessionId?: string;
      fact?: Pick<GatewaySessionRow, "permissionMode" | "updatedAt"> & { revision: number };
    }
  >();
  const permissionIdentity = (key: string, agentId?: string | null) => {
    const identity = resolveUiConversationIdentity(gateway.snapshot, key, agentId ?? undefined);
    return `${identity.sessionKey}\0${identity.agentId ?? ""}`;
  };
  const createProjection = (identity: string, sessionId?: string) => {
    const previous = permissionProjections.get(identity);
    const projection = {
      sessionId,
      fact: previous && previous.sessionId === sessionId ? previous.fact : undefined,
    };
    permissionProjections.set(identity, projection);
    return projection;
  };
  const claimPermissionProjection = (
    key: string,
    agentId?: string | null,
    expectedSessionId?: string,
  ): SessionPermissionClaim => {
    const identity = permissionIdentity(key, agentId);
    const expectedId = expectedSessionId?.trim() || undefined;
    const sessionId =
      expectedId ??
      getRoster().publishedSession(
        (row, ownerAgentId) =>
          permissionIdentity(row.key, row.agentId ?? ownerAgentId) === identity,
      )?.row.sessionId;
    const projection = createProjection(identity, sessionId);
    const initialFact = projection.fact;
    const ownsClaim = () => permissionProjections.get(identity) === projection;
    let confirmed = false;
    let confirmedFact = projection.fact;
    const isCurrent = () => ownsClaim() && (!confirmed || projection.fact === confirmedFact);
    return {
      isCurrent,
      confirm(row: Pick<GatewaySessionRow, "sessionId" | "permissionMode" | "updatedAt">) {
        const fact = projection.sessionId === row.sessionId ? projection.fact : undefined;
        if (
          !ownsClaim() ||
          (row.sessionId && expectedId && expectedId !== row.sessionId) ||
          (row.updatedAt != null && fact?.updatedAt != null && row.updatedAt < fact.updatedAt)
        ) {
          return "superseded";
        }
        confirmed = true;
        confirmedFact = projection.fact;
        // Equal clocks cannot order a conflicting event observed during this request.
        // Keep its field until the mutation's existing canonical read resolves the tie.
        if (
          fact &&
          fact !== initialFact &&
          fact.updatedAt === row.updatedAt &&
          fact.permissionMode !== row.permissionMode
        ) {
          return "refresh";
        }
        if (!row.sessionId) {
          return "confirmed";
        }
        projection.sessionId = row.sessionId;
        projection.fact = {
          permissionMode: row.permissionMode,
          updatedAt: row.updatedAt,
          revision: getRoster().requestRevision,
        };
        confirmedFact = projection.fact;
        return "confirmed";
      },
    };
  };
  const reconcilePermissionList = (
    result: SessionsListResult | null,
    revision: number,
    agentId?: string,
  ) => {
    if (!result || permissionProjections.size === 0) {
      return result;
    }
    let changed = false;
    const sessions = result.sessions.map((row) => {
      const identity = permissionIdentity(row.key, row.agentId ?? agentId);
      const projection = permissionProjections.get(identity);
      if (!projection) {
        return row;
      }
      if (row.sessionId !== projection.sessionId) {
        permissionProjections.delete(identity);
        return row;
      }
      const fact = projection.fact;
      const older =
        fact?.updatedAt != null && row.updatedAt != null && row.updatedAt < fact.updatedAt;
      const newer =
        fact?.updatedAt != null && row.updatedAt != null && row.updatedAt > fact.updatedAt;
      if (!fact || newer || (!older && revision > fact.revision)) {
        // Retain the watermark: another older managed/list request may still finish.
        projection.fact = {
          permissionMode: row.permissionMode,
          updatedAt: row.updatedAt,
          revision: Math.max(revision, fact?.revision ?? 0),
        };
        return row;
      }
      if (row.permissionMode === fact.permissionMode) {
        return row;
      }
      changed = true;
      const next = { ...row };
      if (fact.permissionMode === undefined) {
        delete next.permissionMode;
      } else {
        next.permissionMode = fact.permissionMode;
      }
      return next;
    });
    return changed ? { ...result, sessions } : result;
  };

  return {
    claim: claimPermissionProjection,
    reconcileList: reconcilePermissionList,
    observeEvent(
      reconciled: SessionChangedResult,
      previous: SessionsListResult | null,
      payload: unknown,
      event: NonNullable<ReturnType<typeof readSessionChangedEvent>>,
      agentId?: string | null,
    ): SessionChangedResult {
      let rowAgentId = agentId;
      let row = reconciled.row;
      let previousRow = previous?.sessions.find((candidate) => candidate.key === row?.key);
      if (!row || row === previousRow) {
        const identity = permissionIdentity(event.key, event.agentId ?? agentId);
        const held = getRoster().publishedSession(
          (candidate, ownerAgentId) =>
            permissionIdentity(candidate.key, candidate.agentId ?? ownerAgentId) === identity,
        );
        if (!held || held.row === previousRow) {
          return reconciled;
        }
        // Managed-only rows use the same event admission/freshness rules as the primary roster.
        row = reconcileSessionChanged(held.result, payload, {
          resultAgentId: held.agentId,
          archivedFilter: "all",
        }).row;
        previousRow = held.row;
        rowAgentId = held.agentId;
      }
      if (!row || row === previousRow) {
        return reconciled;
      }
      const ownerAgentId = row.agentId ?? event.agentId ?? rowAgentId;
      const identity = permissionIdentity(row.key, ownerAgentId);
      let projection = permissionProjections.get(identity);
      if (!projection || projection.sessionId !== row.sessionId) {
        // The accepted event owns this incarnation even before primary publication.
        projection = createProjection(identity, row.sessionId);
      }
      if (
        projection?.fact?.updatedAt != null &&
        row.updatedAt != null &&
        row.updatedAt < projection.fact.updatedAt
      ) {
        // Another held list may have accepted a newer field than this roster has seen.
        if (reconciled.row === row && reconciled.result) {
          const corrected = {
            ...row,
            permissionMode: projection.fact.permissionMode,
          };
          if (corrected.permissionMode === undefined) {
            delete corrected.permissionMode;
          }
          return {
            ...reconciled,
            row: corrected,
            result: {
              ...reconciled.result,
              sessions: reconciled.result.sessions.map((candidate) =>
                candidate === row ? corrected : candidate,
              ),
            },
          };
        }
        return reconciled;
      }
      if (row.sessionId) {
        // Events supersede confirmed outcomes; a pending local choice still arbitrates its acknowledgment.
        projection.fact = {
          permissionMode: row.permissionMode,
          updatedAt: row.updatedAt,
          revision: getRoster().requestRevision,
        };
      }
      return reconciled;
    },
    clear: () => permissionProjections.clear(),
  };
}
