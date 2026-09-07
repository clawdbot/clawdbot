// Session group catalog and sidebar section order. Split out of
// `session-organizer-operations.runtime.ts` to keep that module under the
// max-lines ceiling. These operations write the group catalog directly and
// never touch session rows, so they carry no `patchSession` dependency — that
// one-way edge is what keeps the two modules free of an import cycle.
import { t } from "../i18n/index.ts";
import { moveSessionSection, normalizeSessionSectionOrder } from "../lib/sessions/grouping.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import {
  requireSessionMutationAccess,
  type SessionActionHost,
} from "./session-organizer-batch-mutations.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";

export type SessionGroupActionHost = SessionActionHost & {
  knownSessionGroups(): string[];
};

export async function rememberSessionGroup(
  host: SessionGroupActionHost,
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
    const written = await scope.sessions.groupsPut([...groups, name]);
    // The catalog owns the authoritative stale signal; the mutation scope adds
    // its own. Either one retiring means no confirmed entry to assign against.
    return written === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope)
      ? "completed"
      : "stale";
  } catch (error) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    host.sessionData.publishSessionMutationError(scope, error);
    return "failed";
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
  // Deleting a group keeps its sessions: the Gateway drops the catalog row and
  // clears the category on every member, so the confirm names that outcome. It
  // follows the access check so nobody is asked about a delete that cannot run.
  const confirmed = await showConfirmDialog({
    title: t("sessionsView.deleteGroupTitle", { group }),
    message: t("sessionsView.deleteGroupConfirm"),
    confirmLabel: t("common.delete"),
    danger: true,
    signal: scope.signal,
  });
  // Checked ahead of `confirmed`: a retired scope aborts the dialog to `false`
  // too, so without this order the operator's lost intent would look like an
  // ordinary cancel instead of the reconnect that actually dropped it.
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.deleteGroupStale", { group }) });
    return false;
  }
  if (!confirmed) {
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

export async function updateSessionGroupDefaults(
  host: SessionOrganizerControllerHost,
  group: string,
  defaults: { cwd: string | null; worktree: boolean },
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.groups.update",
      requiredScope: "operator.write",
    })
  ) {
    return "failed";
  }
  try {
    const outcome = await scope.sessions.groupsUpdate(group, defaults);
    return outcome === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope)
      ? "completed"
      : "stale";
  } catch (error) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    host.sessionData.publishSessionMutationError(scope, error);
    return "failed";
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
