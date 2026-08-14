import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

/**
 * The one operational state a session row reports. Resolved from session facts
 * alone so nothing here encodes where the state is drawn; the row decides that.
 */
export type SessionPrimaryState =
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "blocked" }
  | { kind: "unread" };

export function resolveSessionPrimaryState(session: SidebarRecentSession): SessionPrimaryState {
  // A live run outranks everything: whatever the last one left behind is stale
  // the moment the session starts talking again.
  if (session.hasActiveRun) {
    return { kind: "running" };
  }
  // Opening a session consumes its transient attention. The subtitle and the
  // accessible description keep the fact; the dot has done its job.
  if (session.visuallyActive) {
    return { kind: "none" };
  }
  // Canonical attention is the authority here. It already resolves which
  // statuses count (a timeout is a failure to look at; a deliberate kill is not)
  // and clears one the reader has already seen, so rebuilding this from raw
  // status would bring a dismissed error back on the next refresh. Every
  // resolved kind is something the operator must act on -- a failure, a
  // question, a pending approval, an agent-declared status -- and this slot
  // says "Session needs attention", not "failed", so they share it.
  if (session.attention.kind !== "none") {
    return { kind: "blocked" };
  }
  return session.unread ? { kind: "unread" } : { kind: "none" };
}

export function describeSessionPrimaryState(state: SessionPrimaryState): string {
  switch (state.kind) {
    case "running":
      return t("sessionsView.activeRun");
    case "blocked":
      return t("sessionsView.attentionRequired");
    case "unread":
      return t("sessionsView.unread");
    case "none":
      return "";
    default:
      return state satisfies never;
  }
}

export function renderSessionPrimaryState(
  state: SessionPrimaryState,
): TemplateResult | typeof nothing {
  if (state.kind === "none") {
    return nothing;
  }
  // The endcap owns the accessible name; the glyph itself is presentation.
  return state.kind === "running"
    ? html`<span class="session-run-spinner"></span>`
    : html`<span class="session-state-dot session-state-dot--${state.kind}"></span>`;
}
