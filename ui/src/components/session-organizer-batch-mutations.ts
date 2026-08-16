import {
  SESSIONS_PATCH_MANY_MAX_TARGETS,
  type SessionsPatchManyParams,
  type SessionsPatchManyResult,
  type SessionsPatchMutation,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { SESSION_ARCHIVE_REQUEST_OPTIONS } from "../../../src/shared/session-archive-timeout.ts";
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

export type SessionActionRow = Pick<
  SidebarRecentSession,
  "key" | "sessionId" | "label" | "pinned" | "archived" | "active"
> & { gatewayHasActiveRun?: boolean; hasActiveRun?: boolean };

export type SessionActionHost = Pick<
  SessionOrganizerControllerHost,
  | "pruneSidebarSessionEntry"
  | "replaceCurrentSession"
  | "selectSession"
  | "sidebarSessionStatusFilter"
> & {
  readonly sessionData: Pick<
    SessionOrganizerControllerHost["sessionData"],
    "isSessionMutationScopeCurrent" | "publishSessionMutationError" | "refreshSidebarSessions"
  >;
};

/**
 * Gate a mutation on the connection's advertised method access, publishing the
 * refusal so the caller never fails silently. Shared by every session-organizer
 * runtime module, so it lives with the types they already import.
 */
export function requireSessionMutationAccess(
  host: SessionActionHost,
  scope: SidebarSessionMutationScope,
  request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  },
): boolean {
  const access = readSessionMethodAccess(scope.gateway.snapshot, request);
  if (access.allowed) {
    return true;
  }
  host.sessionData.publishSessionMutationError(scope, access.reason);
  return false;
}

function isLegacyPatchManyMethodRejection(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: sessions.patchMany")
  );
}

export function sessionRowAgentId(
  session: SessionActionRow,
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
  host: SessionActionHost,
  scope: SidebarSessionMutationScope,
  rows: readonly SessionActionRow[],
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

export async function patchSessionRows(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  patch: SessionsPatchMutation,
  scope: SidebarSessionMutationScope,
  options: {
    deferListRefresh?: boolean;
    fallback?: () => Promise<SessionActionRow[] | null>;
  } = {},
): Promise<SessionActionRow[] | null> {
  if (typeof patch.archived === "boolean" && rows.some((row) => !row.sessionId?.trim())) {
    host.sessionData.publishSessionMutationError(
      scope,
      "Session lifecycle action requires a durable session identity.",
    );
    return null;
  }
  const dispatched: Array<{
    rows: readonly SessionActionRow[];
    result: SessionsPatchManyResult;
  }> = [];
  let terminalError: unknown = null;
  for (let offset = 0; offset < rows.length; offset += SESSIONS_PATCH_MANY_MAX_TARGETS) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return null;
    }
    const chunkRows = rows.slice(offset, offset + SESSIONS_PATCH_MANY_MAX_TARGETS);
    const params: SessionsPatchManyParams = {
      targets: chunkRows.map((row) => ({
        key: row.key,
        agentId: sessionRowAgentId(row, scope),
        ...(typeof patch.archived === "boolean" && row.sessionId
          ? { expectedSessionId: row.sessionId }
          : {}),
      })),
      patch,
    };
    const access = readSessionMethodAccess(scope.gateway.snapshot, {
      method: "sessions.patchMany",
      params,
    });
    if (!access.allowed) {
      if (dispatched.length === 0 && access.cause === "method-unavailable" && options.fallback) {
        return options.fallback();
      }
      terminalError = access.reason;
      if (dispatched.length === 0) {
        host.sessionData.publishSessionMutationError(scope, access.reason);
      }
      break;
    }
    try {
      const result =
        patch.archived === true
          ? await scope.client.request<SessionsPatchManyResult>(
              "sessions.patchMany",
              params,
              SESSION_ARCHIVE_REQUEST_OPTIONS,
            )
          : await scope.client.request<SessionsPatchManyResult>("sessions.patchMany", params);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return null;
      }
      dispatched.push({ rows: chunkRows, result });
    } catch (error) {
      // Metadata-less legacy Gateways allow the optimistic request, then identify
      // this one unsupported method through the canonical Gateway error contract.
      if (dispatched.length === 0 && options.fallback && isLegacyPatchManyMethodRejection(error)) {
        return options.fallback();
      }
      terminalError = error;
      if (dispatched.length === 0) {
        host.sessionData.publishSessionMutationError(scope, error);
      }
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
        errors.push(`${outcome.key}: ${formatUiError(outcome.error.message)}`);
        return [];
      }
      const row = chunkRows[index];
      if (row?.pinned && patch.archived === true) {
        host.pruneSidebarSessionEntry(row.key);
      }
      return row ? [row] : [];
    }),
  );
  const terminalErrorMessage = terminalError === null ? "" : formatUiError(terminalError);
  if (terminalErrorMessage) {
    errors.push(terminalErrorMessage);
  }
  if (errors.length > 0) {
    host.sessionData.publishSessionMutationError(scope, errors.join("; "));
  }
  return successful;
}
