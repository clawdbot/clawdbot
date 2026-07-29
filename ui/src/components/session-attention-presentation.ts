import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { resolveSessionAttentionIcon } from "./session-icon-registry.ts";

export function renderSessionAttentionIcon(attention: SidebarSessionAttention) {
  if (attention.kind === "none") {
    return nothing;
  }
  const icon =
    attention.kind === "question"
      ? icons.hand
      : attention.kind === "approval"
        ? icons.key
        : attention.kind === "agent"
          ? resolveSessionAttentionIcon(attention.icon)
          : icons.alertTriangle;
  return html`<span
    class="sidebar-session-attention__icon sidebar-session-attention__icon--${attention.kind}"
    data-session-attention=${attention.kind}
    aria-hidden="true"
    >${icon}</span
  >`;
}

export function sessionAttentionSubtitle(attention: SidebarSessionAttention): string | undefined {
  switch (attention.kind) {
    case "question":
      return t("sessionsView.waitingForAnswer");
    case "approval":
      return t("sessionsView.waitingForApproval");
    case "error":
      return t("sessionsView.runFailedReason", { reason: attention.reason });
    case "agent":
      return attention.note;
    case "none":
      return undefined;
    default:
      return attention satisfies never;
  }
}

export function renderSessionState(session: SidebarRecentSession) {
  if (session.hasActiveRun || session.status === "running") {
    return html`<span
      class="session-run-spinner sidebar-recent-session__state"
      role="img"
      aria-label=${t("sessionsView.activeRun")}
      title=${t("sessionsView.activeRun")}
    ></span>`;
  }
  if (!session.isChild) {
    return session.unread
      ? html`<span
          class="session-unread-dot sidebar-recent-session__unread"
          role="img"
          aria-label=${t("sessionsView.unread")}
        ></span>`
      : nothing;
  }
  const status = session.status;
  if (!status) {
    return nothing;
  }
  const statusBadge =
    status === "done"
      ? { icon: icons.check, label: t("sessionsView.statusDone") }
      : status === "killed"
        ? { icon: icons.stop, label: t("sessionsView.statusKilled") }
        : status === "timeout"
          ? { icon: icons.alertTriangle, label: t("sessionsView.statusTimeout") }
          : status === "failed"
            ? { icon: icons.alertTriangle, label: t("sessionsView.statusFailed") }
            : null;
  return statusBadge
    ? html`<span
        class="sidebar-child-session__status sidebar-child-session__status--${status}"
        role="img"
        aria-label=${statusBadge.label}
        title=${statusBadge.label}
        >${statusBadge.icon}</span
      >`
    : nothing;
}
