import {
  SESSIONS_ARCHIVE_MANY_MAX_TARGETS,
  type SessionsArchiveManyParams,
  type SessionsArchiveManyResult,
} from "../../../packages/gateway-protocol/src/schema/sessions-archive-many.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";

function isLegacyArchiveManyMethodRejection(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: sessions.archiveMany")
  );
}

export function sessionRowAgentId(
  session: SidebarRecentSession,
  scope: SidebarSessionMutationScope,
): string {
  return parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
}

/**
 * One list refresh per owning agent, replacing the per-row refreshes a batch
 * defers; each deferred row skipped a full `sessions.list` round trip and rode
 * pushed `sessions.changed` events instead. Agents come from the rows, not the
 * scope, because `patchSession` routes every mutation by its own key. The
 * result carries the stale/failed reporting the per-row refresh owed its caller.
 */
export async function refreshSessionsAfterBatch(
  host: SessionOrganizerControllerHost,
  scope: SidebarSessionMutationScope,
  rows: readonly SidebarRecentSession[],
): Promise<SidebarSessionMutationResult> {
  const agentIds = [...new Set(rows.map((row) => sessionRowAgentId(row, scope)))];
  const refreshSidebar = host.sidebarSessionStatusFilter() !== "active";
  for (const agentId of agentIds) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    try {
      await scope.sessions.refreshReplacement(agentId);
      if (refreshSidebar && host.sessionData.isSessionMutationScopeCurrent(scope)) {
        await host.sessionData.refreshSidebarSessions(agentId);
      }
    } catch (error) {
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      host.sessionData.publishSessionMutationError(scope, error);
      return "failed";
    }
  }
  return host.sessionData.isSessionMutationScopeCurrent(scope) ? "completed" : "stale";
}

export async function archiveSessionRows(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  archived: boolean,
  scope: SidebarSessionMutationScope,
  options: {
    deferListRefresh?: boolean;
    fallback?: () => Promise<SidebarRecentSession[] | null>;
  } = {},
): Promise<SidebarRecentSession[] | null> {
  const dispatched: Array<{
    rows: readonly SidebarRecentSession[];
    result: SessionsArchiveManyResult;
  }> = [];
  let terminalError: unknown = null;
  for (let offset = 0; offset < rows.length; offset += SESSIONS_ARCHIVE_MANY_MAX_TARGETS) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return null;
    }
    const chunkRows = rows.slice(offset, offset + SESSIONS_ARCHIVE_MANY_MAX_TARGETS);
    const params: SessionsArchiveManyParams = {
      targets: chunkRows.map((row) => ({
        key: row.key,
        agentId: sessionRowAgentId(row, scope),
      })),
      archived,
    };
    const access = readSessionMethodAccess(scope.gateway.snapshot, {
      method: "sessions.archiveMany",
      params,
      requiredScope: "operator.write",
    });
    if (!access.allowed) {
      if (access.cause === "method-unavailable" && options.fallback) {
        return options.fallback();
      }
      terminalError = access.reason;
      host.sessionData.publishSessionMutationError(scope, access.reason);
      break;
    }
    try {
      const result = await scope.client.request<SessionsArchiveManyResult>(
        "sessions.archiveMany",
        params,
      );
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return null;
      }
      dispatched.push({ rows: chunkRows, result });
    } catch (error) {
      // Metadata-less legacy Gateways allow the optimistic request, then identify
      // this one unsupported method through the canonical Gateway error contract.
      if (
        dispatched.length === 0 &&
        options.fallback &&
        isLegacyArchiveManyMethodRejection(error)
      ) {
        return options.fallback();
      }
      terminalError = error;
      host.sessionData.publishSessionMutationError(scope, error);
      break;
    }
  }
  if (dispatched.length === 0) {
    return null;
  }
  if (!options.deferListRefresh) {
    const refreshResult = await refreshSessionsAfterBatch(host, scope, rows);
    if (refreshResult === "stale") {
      return null;
    }
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return null;
  }
  const errors: string[] = [];
  const successful = dispatched.flatMap(({ rows: chunkRows, result }) =>
    result.outcomes.flatMap((outcome, index) => {
      if (!outcome.ok) {
        errors.push(`${outcome.key}: ${outcome.error.message}`);
        return [];
      }
      const row = chunkRows[index];
      if (row?.pinned && archived) {
        host.pruneSidebarSessionEntry(row.key);
      }
      return row ? [row] : [];
    }),
  );
  if (errors.length > 0) {
    const terminalErrorMessage = terminalError === null ? "" : formatUiError(terminalError);
    if (terminalErrorMessage) {
      errors.push(terminalErrorMessage);
    }
    host.sessionData.publishSessionMutationError(scope, errors.join("; "));
  }
  return successful;
}
