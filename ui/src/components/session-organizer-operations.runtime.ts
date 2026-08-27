import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { WorktreesRemoveResult } from "../../../packages/gateway-protocol/src/index.js";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import {
  formatPreservedWorktreeConfirmation,
  formatPreservedWorktreesNotice,
} from "../lib/sessions/worktree-preservation.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
  SidebarSessionPatch,
} from "./app-sidebar-session-types.ts";
import { requestCloudWorkerStop } from "./cloud-worker-stop.ts";
import { showConfirmDialog, type ConfirmDialogSkipPreference } from "./confirm-dialog.ts";
import type { SessionMenuAction } from "./session-menu.ts";
import {
  patchSessionRows,
  refreshSessionsAfterBatch,
  requireSessionMutationAccess,
  sessionRowAgentId,
} from "./session-organizer-batch-mutations.ts";
import type { SessionActionHost, SessionActionRow } from "./session-organizer-batch-mutations.ts";
import { rememberSessionGroup, type SessionGroupActionHost } from "./session-organizer-catalog.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";

export type { SessionActionHost, SessionActionRow } from "./session-organizer-batch-mutations.ts";
// The controller loads this module as a single namespace, so the catalog
// operations stay reachable under their original names after the split.
export {
  deleteSessionGroup,
  renameSessionGroup,
  reorderSidebarSection,
  updateSessionGroupDefaults,
} from "./session-organizer-catalog.ts";

export async function patchSession(
  host: SessionActionHost,
  session: SessionActionRow,
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
    ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
  };
  if (typeof patch.archived === "boolean" && !session.sessionId?.trim()) {
    host.sessionData.publishSessionMutationError(
      scope,
      "Session lifecycle action requires a durable session identity.",
    );
    return "failed";
  }
  if (
    !requireSessionMutationAccess(host, scope, { method: "sessions.patch", params: requestParams })
  ) {
    return "failed";
  }
  try {
    const patched = await scope.sessions.patch(session.key, patch, {
      agentId,
      ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
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
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
  options: { deferListRefresh?: boolean } = {},
): Promise<SessionActionRow[] | null> {
  const completed: SessionActionRow[] = [];
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
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  scope.sessions.setArchiveVisibility(session.key, "pending");
  const result = await patchSession(host, session, { archived: true }, scope);
  scope.sessions.setArchiveVisibility(session.key, result === "completed" ? "archived" : undefined);
  if (result !== "completed" || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  showToast({
    message: t("sessionsView.sessionArchived"),
    actionLabel: t("common.undo"),
    onAction: () =>
      void restoreArchivedSessions(host, [{ session, pinned: session.pinned }], scope),
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
  host: SessionActionHost,
  archived: readonly { session: SessionActionRow; pinned: boolean }[],
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

/**
 * Session deletes are the repeatable, per-row destructive action here, so they
 * carry an opt-out. Stopping a cloud worker and removing a preserved worktree
 * deliberately get none: the first is a rare shared-resource action and the
 * second destroys the only copy of uncommitted work.
 */
function sessionDeleteSkipPreference(
  scope: SidebarSessionMutationScope,
): ConfirmDialogSkipPreference {
  return {
    skipped: loadSettings().sessionDeleteConfirm === false,
    remember: () => {
      patchSettings({ sessionDeleteConfirm: false });
      // A mounted Settings -> Appearance rereads settings only on this
      // notification; without it its toggle keeps showing the stale value
      // while deletes already skip the prompt.
      scope.context.theme.refresh();
    },
  };
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
  const confirmed = await showConfirmDialog({
    message: t("sessionsView.deleteSessionsConfirm", { count: String(rows.length) }),
    confirmLabel: t("common.delete"),
    danger: true,
    skipPreference: sessionDeleteSkipPreference(scope),
    signal: scope.signal,
  });
  // A reconnect or a replaced sessions capability can land while the modal is
  // open, so the captured scope is revalidated before any delete leaves here.
  // Checked ahead of `confirmed`: a retired scope aborts the dialog to `false`
  // too, so without this order the operator's lost intent would look like an
  // ordinary cancel instead of the reconnect that actually dropped it.
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.deleteSessionsStale", { count: String(rows.length) }) });
    return;
  }
  if (!confirmed) {
    return;
  }
  const requests = rows.map((row) => ({
    key: row.key,
    agentId: parseAgentSessionKey(row.key)?.agentId ?? scope.selectedAgentId,
    deleteTranscript: true,
    ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
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
      window.alert(formatPreservedWorktreesNotice(result.preservedWorktrees));
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

export async function renameSession(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  label: string,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  await patchSession(host, session, { label: normalizeOptionalString(label) ?? null }, scope);
}

export async function assignSessionOwner(
  host: SessionActionHost,
  session: Pick<SidebarRecentSession, "key">,
  owner: Pick<SessionOwnerOption, "type" | "id">,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.assignOwner",
      params: { key: session.key, owner },
      requiredScope: "operator.write",
    })
  ) {
    return;
  }
  const assigned = await scope.sessions.assignOwner(session.key, owner, {
    agentId: parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId,
  });
  if (
    host.sessionData.isSessionMutationScopeCurrent(scope) &&
    !assigned &&
    scope.sessions.state.error
  ) {
    host.sessionData.publishSessionMutationError(scope, scope.sessions.state.error);
  }
}

export async function createSessionGroup(
  host: SessionOrganizerControllerHost,
  name: string,
  sessions: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  const remembered = await rememberSessionGroup(host, name, scope);
  if (remembered !== "completed") {
    return remembered;
  }
  // The dialog no longer blocks, so a captured row can be deleted while the
  // catalog write is in flight, and sessions.patch would recreate it. Re-resolve
  // every target against the current list, as the Sessions-page path does.
  const targets = sessions.flatMap((session) => {
    const current = host.findSidebarSessionByKey(session.key);
    return current ? [current] : [];
  });
  if (targets.length > 0) {
    const moved =
      targets.length === 1
        ? await patchSession(host, targets[0]!, { category: name }, scope)
        : await patchSessions(host, targets, { category: name }, scope);
    // Rows that left the list are absent from `targets`, so patching the
    // remainder reports success for a selection that was only partly applied.
    // Closing on that would leave the skipped rows unaccounted for, so the
    // partial outcome is named here; it is terminal, as the group already exists.
    if (moved === "completed" && targets.length < sessions.length) {
      showToast({ message: t("sessionsView.newGroupMovePartial") });
    }
    return moved;
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  // A header-created group starts empty and needs no notice. Rows that were
  // requested but resolved to nothing are a partial outcome: the group landed
  // and the moves did not. The sidebar list is a bounded projection, so this is
  // not proof the sessions are gone — say so rather than closing on a silent
  // non-outcome the operator cannot account for.
  if (sessions.length > 0) {
    showToast({ message: t("sessionsView.newGroupMoveSkipped") });
  }
  // Re-render so the new section shows up.
  host.requestUpdate();
  return "completed";
}

export async function assignSessionCategory(
  host: SessionGroupActionHost,
  session: SessionActionRow,
  category: string | null,
  scope: SidebarSessionMutationScope,
  patch: { pinned?: boolean } = {},
  options: { resolveSession?: () => SessionActionRow | null } = {},
): Promise<void> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const catalogChanged = Boolean(category && !host.knownSessionGroups().includes(category));
  if (category && (await rememberSessionGroup(host, category, scope)) !== "completed") {
    return;
  }
  const currentSession = options.resolveSession ? options.resolveSession() : session;
  if (!currentSession) {
    showToast({
      message: t(catalogChanged ? "sessionsView.newGroupMoveSkipped" : "common.refresh"),
    });
    return;
  }
  if ((currentSession.category ?? null) === category && patch.pinned === undefined) {
    return;
  }
  await patchSession(host, currentSession, { category, ...patch }, scope);
}

export async function forkSession(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
  const createParams = {
    parentSessionKey: session.key,
    fork: true,
    ...((session.gatewayHasActiveRun ?? session.hasActiveRun)
      ? { forkFrom: "last-completed" as const }
      : {}),
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
  const stopAction = session.cloudWorkerStopAction;
  // Reclaim during an active run is never offered, so decide that before the
  // await; a run starting while the modal is open is left to the gateway, whose
  // rejection is a recorded reason instead of a silently dropped confirmation.
  if (!stopAction || (stopAction.blocksActiveRun && session.hasActiveRun)) {
    return;
  }
  const confirmed = await showConfirmDialog({
    message: t("sessionsView.stopCloudWorkerConfirm", { session: session.label }),
    confirmLabel: t("sessionsView.stopCloudWorkerConfirmAction"),
    danger: true,
    signal: scope.signal,
  });
  // Checked ahead of `confirmed`: a retired scope aborts the dialog to `false`
  // too, so without this order the operator's lost intent would look like an
  // ordinary cancel instead of the reconnect that actually dropped it.
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.stopCloudWorkerStale", { session: session.label }) });
    return;
  }
  if (!confirmed) {
    return;
  }
  if (!requireSessionMutationAccess(host, scope, stopAction)) {
    return;
  }
  try {
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
    await requestCloudWorkerStop(scope.client, {
      key: session.key,
      agentId,
    });
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    await scope.sessions.refreshReplacement(agentId);
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function deleteSession(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
  // The chat header shares this operation, so the opt-out is opt-in per caller:
  // only the sidebar the setting names may offer it, and the default keeps asking.
  options: { offerSkip?: boolean } = {},
) {
  const confirmed = await showConfirmDialog({
    message: t("sessionsView.deleteSessionConfirm", { session: session.label }),
    confirmLabel: t("common.delete"),
    danger: true,
    ...(options.offerSkip ? { skipPreference: sessionDeleteSkipPreference(scope) } : {}),
    signal: scope.signal,
  });
  // Checked ahead of `confirmed`: a retired scope aborts the dialog to `false`
  // too, so without this order the operator's lost intent would look like an
  // ordinary cancel instead of the reconnect that actually dropped it.
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.deleteSessionStale", { session: session.label }) });
    return;
  }
  if (!confirmed) {
    return;
  }
  const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
  const deleteParams = {
    agentId,
    deleteTranscript: true,
    ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
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
    if (outcome.worktreePreserved) {
      const preserved = outcome.worktreePreserved;
      const removeAccess = readSessionMethodAccess(scope.gateway.snapshot, {
        method: "worktrees.remove",
        requiredScope: "operator.admin",
      });
      if (!removeAccess.allowed) {
        window.alert(formatPreservedWorktreesNotice([preserved]));
        if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
          return;
        }
      } else {
        const removeWorktree = await showConfirmDialog({
          message: formatPreservedWorktreeConfirmation(preserved),
          confirmLabel: t("common.remove"),
          danger: true,
          signal: scope.signal,
        });
        // Cancel needs this guard too: the delete already landed, so a scope
        // retired while the modal was open must not drive the navigation below.
        // A retired scope leaves the worktree exactly like the no-access branch
        // above, so it earns the same visible outcome instead of vanishing quietly.
        if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
          showToast({
            message: formatPreservedWorktreesNotice([preserved]),
          });
          return;
        }
        if (removeWorktree) {
          try {
            const result = await scope.client.request<WorktreesRemoveResult>("worktrees.remove", {
              id: preserved.id,
              force: true,
            });
            if (result.snapshotError) {
              host.sessionData.publishSessionMutationError(scope, result.snapshotError);
            }
          } catch (error) {
            host.sessionData.publishSessionMutationError(scope, error);
          }
          if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
            return;
          }
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
