import type { SessionsArchiveManyResult } from "../../../packages/gateway-protocol/src/schema/sessions-archive-many.js";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";

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
  deferListRefresh = false,
): Promise<SidebarRecentSession[] | null> {
  const targets = rows.map((row) => ({ key: row.key, agentId: sessionRowAgentId(row, scope) }));
  let result;
  try {
    result = await scope.client.request<SessionsArchiveManyResult>("sessions.archiveMany", {
      targets,
      archived,
    });
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return null;
    }
    if (!deferListRefresh) {
      const refreshResult = await refreshSessionsAfterBatch(host, scope, rows);
      if (refreshResult === "stale") {
        return null;
      }
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
    return null;
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return null;
  }
  const errors: string[] = [];
  const successful = result.outcomes.flatMap((outcome, index) => {
    if (!outcome.ok) {
      errors.push(`${outcome.key}: ${outcome.error.message}`);
      return [];
    }
    const row = rows[index];
    if (row?.pinned && archived) {
      host.pruneSidebarSessionEntry(row.key);
    }
    return row ? [row] : [];
  });
  if (errors.length > 0) {
    host.sessionData.publishSessionMutationError(scope, errors.join("; "));
  }
  return successful;
}
