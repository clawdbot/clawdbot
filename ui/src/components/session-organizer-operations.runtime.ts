import type { ReactiveControllerHost } from "lit";
import { t } from "../i18n/index.ts";
import { reorderSessionCustomGroups } from "../lib/sessions/custom-groups.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
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
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import type { SessionMenuAction } from "./session-menu.ts";

export interface SessionOrganizerControllerHost extends ReactiveControllerHost {
  readonly sessionData: Pick<
    SessionDataController,
    | "beginSessionMutation"
    | "isSessionMutationScopeCurrent"
    | "publishSessionMutationError"
    | "refreshSidebarSessions"
    | "resetForStatusFilter"
  >;
  readonly onUpdateSidebarEntries?: (entries: string[]) => void;
  sessionsGrouping: SidebarSessionsGrouping;
  sessionsShowCron: boolean;
  sessionsStatusFilter: SidebarSessionStatusFilter;
  clearSessionSelection(): void;
  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
  knownSessionGroups(): string[];
  pruneSidebarSessionEntry(key: string): void;
  reconciledSidebarZone(): { sidebarEntries: readonly string[] };
  replaceCurrentSession(sessionKey: string): void;
  selectSession(sessionKey: string): void;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
}

export async function patchSession(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
  try {
    const patched = await scope.sessions.patch(session.key, patch, { agentId });
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
    if (host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(agentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
    }
    if (patch.archived !== true || !session.active) {
      return "completed";
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
  let result: SidebarSessionMutationResult = "completed";
  // Sequential like deleteMany: parallel patches would race the shared
  // session-state publishes inside the capability.
  for (const row of rows) {
    const rowResult = await patchSession(host, row, patch, scope);
    if (rowResult === "stale") {
      return "stale";
    }
    if (rowResult === "failed") {
      result = "failed";
    }
  }
  return result;
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
  const archived: Array<{ session: SidebarRecentSession; pinned: boolean }> = [];
  for (const session of rows) {
    const result = await patchSession(host, session, { archived: true }, scope);
    if (result === "stale") {
      return;
    }
    if (result === "completed") {
      archived.push({ session, pinned: session.pinned });
    }
  }
  if (archived.length === 0 || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
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
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  let restoredActiveKey: string | null = null;
  for (const { session, pinned } of archived) {
    const result = await patchSession(
      host,
      session,
      { archived: false, ...(pinned ? { pinned: true } : {}) },
      scope,
    );
    if (result === "stale") {
      return;
    }
    if (result === "completed" && session.active) {
      restoredActiveKey = session.key;
    }
  }
  if (restoredActiveKey && host.sessionData.isSessionMutationScopeCurrent(scope)) {
    host.replaceCurrentSession(restoredActiveKey);
  }
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
  try {
    const result = await scope.sessions.deleteMany(
      rows.map((row) => ({
        key: row.key,
        agentId: parseAgentSessionKey(row.key)?.agentId ?? scope.selectedAgentId,
        deleteTranscript: true,
        ...(row.archived === true ? { archivedOnly: true } : {}),
      })),
    );
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
        await patchSessions(host, rows, { archived: false }, scope);
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
  if (sessions.length > 0) {
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
  try {
    const outcome = await scope.sessions.groupsDelete(group);
    return outcome === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope);
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
    return false;
  }
}

export async function reorderSessionGroup(
  host: SessionOrganizerControllerHost,
  source: string,
  target: string,
  position: "before" | "after",
  scope: SidebarSessionMutationScope,
): Promise<void> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  try {
    await scope.sessions.groupsPut(
      reorderSessionCustomGroups(host.knownSessionGroups(), source, target, position),
    );
    if (host.sessionData.isSessionMutationScopeCurrent(scope)) {
      host.requestUpdate();
    }
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
  try {
    const key = await scope.sessions.create({
      parentSessionKey: session.key,
      fork: true,
      agentId,
    });
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
  try {
    const outcome = await scope.sessions.delete(session.key, {
      agentId,
      deleteTranscript: true,
      ...(session.archived === true ? { archivedOnly: true } : {}),
    });
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
      if (
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
