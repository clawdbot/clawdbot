import { t } from "../i18n/index.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { moveSessionSection, normalizeSessionSectionOrder } from "../lib/sessions/grouping.ts";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
  SidebarSessionPatch,
} from "./app-sidebar-session-types.ts";
import type { SessionMenuAction } from "./session-menu.ts";
import {
  patchSessionRows,
  refreshSessionsAfterBatch,
  sessionRowAgentId,
} from "./session-organizer-batch-mutations.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";

function requireSessionMutationAccess(
  host: SessionOrganizerControllerHost,
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

export async function patchSession(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
  refresh: { deferListRefresh?: boolean } = {},
): Promise<SidebarSessionMutationResult> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  const agentId = sessionRowAgentId(session, scope);
  const requestParams = {
    key: session.key,
    ...patch,
    agentId,
  };
  if (
    !requireSessionMutationAccess(host, scope, { method: "sessions.patch", params: requestParams })
  ) {
    return "failed";
  }
  try {
    const patched = await scope.sessions.patch(session.key, patch, {
      agentId,
      ...(refresh.deferListRefresh ? { deferListRefresh: true } : {}),
    });
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    if (!patched) {
      if (scope.sessions.state.error) {
        host.sessionData.publishSessionMutationError(scope, scope.sessions.state.error);
      }
      return "failed";
    }
    // Unpin from any surface (menu, pin button, drag) retires the session's
    // persisted zone slot; leaving it would resurrect stale synced entries.
    // Archiving implicitly unpins server-side (sessions-patch clears
    // pinnedAt), so it retires the slot too.
    if (patch.pinned === false || (patch.archived === true && session.pinned)) {
      host.pruneSidebarSessionEntry(session.key);
    }
    if (!refresh.deferListRefresh && host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(agentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
    }
    return "completed";
  } catch (error) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    host.sessionData.publishSessionMutationError(scope, error);
    return "failed";
  }
}

export async function patchSessions(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  if (!scope) {
    return "stale";
  }
  if (rows.length === 0) {
    return "completed";
  }
  const successful = await patchSessionRows(host, rows, patch, scope, {
    fallback: () => patchSessionRowsSerial(host, rows, patch, scope),
  });
  if (!successful) {
    return host.sessionData.isSessionMutationScopeCurrent(scope) ? "failed" : "stale";
  }
  return successful.length === rows.length ? "completed" : "failed";
}

async function patchSessionRowsSerial(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
  options: { deferListRefresh?: boolean } = {},
): Promise<SidebarRecentSession[] | null> {
  const completed: SidebarRecentSession[] = [];
  for (const row of rows) {
    const result = await patchSession(host, row, patch, scope, { deferListRefresh: true });
    if (result === "stale") {
      return null;
    }
    if (result === "completed") {
      completed.push(row);
    }
  }
  if (!options.deferListRefresh) {
    const refreshed = await refreshSessionsAfterBatch(host, scope, rows);
    if (refreshed === "stale") {
      return null;
    }
  }
  return completed;
}

export async function archiveSessionWithUndo(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  scope: SidebarSessionMutationScope,
) {
  const result = await patchSession(host, session, { archived: true }, scope);
  if (result !== "completed" || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  showToast({
    message: t("sessionsView.sessionArchived"),
    actionLabel: t("common.undo"),
    onAction: () => {
      void restoreArchivedSessions(host, [{ session, pinned: session.pinned }], scope);
    },
  });
}

async function archiveSessionsWithUndo(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
) {
  if (rows.length === 0) {
    return;
  }
  const archivedRows = await patchSessionRows(host, rows, { archived: true }, scope, {
    fallback: () => patchSessionRowsSerial(host, rows, { archived: true }, scope),
  });
  if (!archivedRows || archivedRows.length === 0) {
    return;
  }
  const archived = archivedRows.map((session) => ({ session, pinned: session.pinned }));
  showToast({
    message:
      archived.length === 1
        ? t("sessionsView.sessionArchived")
        : t("sessionsView.sessionsArchived", { count: String(archived.length) }),
    actionLabel: t("common.undo"),
    onAction: () => void restoreArchivedSessions(host, archived, scope),
  });
}

async function restoreArchivedSessions(
  host: SessionOrganizerControllerHost,
  archived: readonly { session: SidebarRecentSession; pinned: boolean }[],
  scope: SidebarSessionMutationScope,
) {
  const rows = archived.map((entry) => entry.session);
  const singleRowUndo = rows.length === 1;
  const restored = singleRowUndo
    ? await patchSessionRowsSerial(host, rows, { archived: false }, scope, {
        deferListRefresh: true,
      })
    : await patchSessionRows(host, rows, { archived: false }, scope, {
        deferListRefresh: true,
        fallback: () =>
          patchSessionRowsSerial(host, rows, { archived: false }, scope, {
            deferListRefresh: true,
          }),
      });
  if (!restored) {
    return;
  }
  const repinRows = archived.flatMap(({ session, pinned }) =>
    pinned && restored.includes(session) ? [session] : [],
  );
  if (repinRows.length > 0) {
    const repinned = singleRowUndo
      ? await patchSessionRowsSerial(host, repinRows, { pinned: true }, scope, {
          deferListRefresh: true,
        })
      : await patchSessionRows(host, repinRows, { pinned: true }, scope, {
          deferListRefresh: true,
          fallback: () =>
            patchSessionRowsSerial(host, repinRows, { pinned: true }, scope, {
              deferListRefresh: true,
            }),
        });
    if (!repinned && !host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  await refreshSessionsAfterBatch(host, scope, rows);
}

/** One confirm and one preserved-worktrees alert for the whole selection. */
export async function deleteSessionsBatch(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
) {
  if (rows.length === 0) {
    return;
  }
  if (!window.confirm(t("sessionsView.deleteSessionsConfirm", { count: String(rows.length) }))) {
    return;
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const requests = rows.map((row) => ({
    key: row.key,
    agentId: parseAgentSessionKey(row.key)?.agentId ?? scope.selectedAgentId,
    deleteTranscript: true,
    ...(row.archived === true ? { archivedOnly: true } : {}),
  }));
  for (const params of requests) {
    if (!requireSessionMutationAccess(host, scope, { method: "sessions.delete", params })) {
      return;
    }
  }
  try {
    const result = await scope.sessions.deleteMany(requests);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    if (host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(scope.selectedAgentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
    if (result.preservedWorktrees.length > 0) {
      window.alert(
        t("sessionsView.deletePreservedWorktrees", {
          count: String(result.preservedWorktrees.length),
          branches: result.preservedWorktrees.map((worktree) => worktree.branch).join(", "),
        }),
      );
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
    const deletedActive = rows.find((row) => row.active && result.deleted.includes(row.key));
    if (deletedActive) {
      host.replaceCurrentSession(
        buildAgentMainSessionKey({
          agentId: parseAgentSessionKey(deletedActive.key)?.agentId ?? scope.selectedAgentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: scope.context.agents.state.agentsList,
            hello: scope.gateway.snapshot.hello,
          }),
        }),
      );
    }
    if (result.errors.length > 0) {
      host.sessionData.publishSessionMutationError(scope, result.errors.join("; "));
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function runBatchSessionAction(
  host: SessionOrganizerControllerHost,
  action: SessionMenuAction,
  rows: SidebarRecentSession[],
  allUnread: boolean,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  switch (action.kind) {
    case "toggle-unread":
      await patchSessions(host, rows, { unread: !allUnread }, scope);
      break;
    case "move-to-group":
      await patchSessions(
        host,
        rows.filter((row) => (row.category ?? null) !== action.category),
        { category: action.category },
        scope,
      );
      break;
    case "toggle-archived":
      if (rows.every((row) => row.archived === true)) {
        await patchSessionRows(host, rows, { archived: false }, scope, {
          fallback: () => patchSessionRowsSerial(host, rows, { archived: false }, scope),
        });
      } else {
        await archiveSessionsWithUndo(
          host,
          rows.filter((row) => row.archived !== true),
          scope,
        );
      }
      break;
    case "delete":
      await deleteSessionsBatch(host, rows, scope);
      break;
    default:
      break;
  }
}

async function rememberSessionGroup(
  host: SessionOrganizerControllerHost,
  name: string,
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  const groups = host.knownSessionGroups();
  if (groups.includes(name)) {
    return "completed";
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    })
  ) {
    return "failed";
  }
  try {
    await scope.sessions.groupsPut([...groups, name]);
    return host.sessionData.isSessionMutationScopeCurrent(scope) ? "completed" : "stale";
  } catch (error) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    host.sessionData.publishSessionMutationError(scope, error);
    return "failed";
  }
}

export async function renameSession(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  label: string,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  await patchSession(host, session, { label: normalizeOptionalString(label) ?? null }, scope);
}

export async function createSessionGroup(
  host: SessionOrganizerControllerHost,
  name: string,
  sessions: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
): Promise<void> {
  if ((await rememberSessionGroup(host, name, scope)) !== "completed") {
    return;
  }
  if (sessions.length === 1) {
    await patchSession(host, sessions[0]!, { category: name }, scope);
  } else if (sessions.length > 1) {
    await patchSessions(host, sessions, { category: name }, scope);
  } else if (host.sessionData.isSessionMutationScopeCurrent(scope)) {
    // Header-created groups start empty; re-render so the section shows up.
    host.requestUpdate();
  }
}

export async function renameSessionGroup(
  host: SessionOrganizerControllerHost,
  group: string,
  next: string,
  scope: SidebarSessionMutationScope,
): Promise<boolean> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return false;
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.groups.rename",
      requiredScope: "operator.write",
    })
  ) {
    return false;
  }
  try {
    const outcome = await scope.sessions.groupsRename(group, next);
    return outcome === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope);
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
    return false;
  }
}

export async function deleteSessionGroup(
  host: SessionOrganizerControllerHost,
  group: string,
  scope: SidebarSessionMutationScope,
): Promise<boolean> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return false;
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.groups.delete",
      requiredScope: "operator.write",
    })
  ) {
    return false;
  }
  try {
    const outcome = await scope.sessions.groupsDelete(group);
    return outcome === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope);
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
    return false;
  }
}

export async function reorderSidebarSection(
  host: SessionOrganizerControllerHost,
  sourceSectionId: string,
  targetSectionId: string,
  position: "before" | "after",
  scope: SidebarSessionMutationScope,
): Promise<void> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    })
  ) {
    return;
  }
  try {
    // knownSessionGroups() is the full discovered set (gateway catalog plus
    // row-discovered categories), so normalize only prunes deleted groups.
    const knownGroups = host.knownSessionGroups();
    const knownCatalogIds = host.knownSessionCatalogIds();
    const next = moveSessionSection(
      normalizeSessionSectionOrder(host.knownSectionOrder(), knownGroups, knownCatalogIds),
      sourceSectionId,
      targetSectionId,
      position,
    );
    const nextGroups = next.flatMap((token) =>
      token.startsWith("category:") ? [token.slice("category:".length)] : [],
    );
    // No capability gate: the gateway serves this UI from its own dist, so a
    // newer UI never talks to an older gateway's closed put schema outside dev.
    await scope.sessions.groupsPut(nextGroups, next);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    host.requestUpdate();
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function assignSessionCategory(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  category: string | null,
  scope: SidebarSessionMutationScope,
  patch: { pinned?: boolean } = {},
): Promise<void> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (category && (await rememberSessionGroup(host, category, scope)) !== "completed") {
    return;
  }
  await patchSession(host, session, { category, ...patch }, scope);
}

export async function forkSession(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
  const createParams = {
    parentSessionKey: session.key,
    fork: true,
    agentId,
  };
  if (
    !requireSessionMutationAccess(host, scope, { method: "sessions.create", params: createParams })
  ) {
    return;
  }
  try {
    const key = await scope.sessions.create(createParams);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    if (key) {
      host.selectSession(key);
    } else {
      host.sessionData.publishSessionMutationError(
        scope,
        scope.sessions.state.error ?? t("newSession.createFailed"),
      );
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function stopCloudWorker(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  scope: SidebarSessionMutationScope,
) {
  if (
    !session.cloudWorkerActive ||
    session.hasActiveRun ||
    !window.confirm(t("sessionsView.stopCloudWorkerConfirm", { session: session.label }))
  ) {
    return;
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.reclaim",
      requiredScope: "operator.admin",
    })
  ) {
    return;
  }
  try {
    await scope.client.request(
      "sessions.reclaim",
      { key: session.key, agentId },
      { timeoutMs: 10 * 60_000 },
    );
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    await scope.sessions.refreshReplacement(agentId);
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function deleteSession(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  scope: SidebarSessionMutationScope,
) {
  if (!window.confirm(t("sessionsView.deleteSessionConfirm", { session: session.label }))) {
    return;
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
  const deleteParams = {
    agentId,
    deleteTranscript: true,
    ...(session.archived === true ? { archivedOnly: true } : {}),
  };
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.delete",
      params: { key: session.key, ...deleteParams },
    })
  ) {
    return;
  }
  try {
    const outcome = await scope.sessions.delete(session.key, deleteParams);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    if (host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(agentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
    // Dirty/unpushed checkouts survive deletion; offer explicit removal.
    if (outcome.worktreePreserved) {
      const preserved = outcome.worktreePreserved;
      const removeAccess = readSessionMethodAccess(scope.gateway.snapshot, {
        method: "worktrees.remove",
        requiredScope: "operator.admin",
      });
      if (!removeAccess.allowed) {
        window.alert(
          t("sessionsView.deletePreservedWorktrees", {
            count: "1",
            branches: preserved.branch,
          }),
        );
        if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
          return;
        }
      } else if (
        window.confirm(
          t("sessionsView.deletePreservedWorktreeConfirm", { branch: preserved.branch }),
        )
      ) {
        if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
          return;
        }
        try {
          await scope.client.request("worktrees.remove", {
            id: preserved.id,
            force: true,
          });
        } catch (error) {
          host.sessionData.publishSessionMutationError(scope, error);
        }
        if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
          return;
        }
      }
    }
    if (!outcome.deleted || !session.active) {
      return;
    }
    host.replaceCurrentSession(
      buildAgentMainSessionKey({
        agentId,
        mainKey: resolveUiConfiguredMainKey({
          agentsList: scope.context.agents.state.agentsList,
          hello: scope.gateway.snapshot.hello,
        }),
      }),
    );
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}
