import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { sessionAttentionSubtitle } from "./session-attention-presentation.ts";

type SidebarSessionSubtitle = {
  subtitle: string | undefined;
  narration: string | undefined;
};

/** Resolves the single subtitle slot without displacing pending attention. */
export function resolveSidebarSessionSubtitle(params: {
  session: SidebarRecentSession;
  hasDisplay: boolean;
  displaySubtitle: string | undefined;
  sidebarLiveActivity: boolean;
  narrationLine: string | undefined;
}): SidebarSessionSubtitle {
  const { session } = params;
  const attention = sessionAttentionSubtitle(session.attention);
  const running = session.hasActiveRun || session.status === "running";
  const narration =
    attention || !params.sidebarLiveActivity || !running ? undefined : params.narrationLine;
  const workSubtitle = params.hasDisplay
    ? params.displaySubtitle
    : session.subtitle && session.workSession && session.subtitle !== session.label
      ? session.subtitle
      : undefined;
  return { subtitle: attention ?? narration ?? workSubtitle, narration };
}

export function renderSidebarSessionSubtitle(value: SidebarSessionSubtitle) {
  if (!value.subtitle) {
    return nothing;
  }
  return value.narration
    ? keyed(
        value.narration,
        html`<span
          class="sidebar-recent-session__subtitle sidebar-recent-session__subtitle--narration"
          >${value.subtitle}</span
        >`,
      )
    : html`<span class="sidebar-recent-session__subtitle">${value.subtitle}</span>`;
}
