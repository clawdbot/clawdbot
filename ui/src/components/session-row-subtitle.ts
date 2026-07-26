import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { pickFreshestObserverDigest } from "../lib/observer-digest.ts";
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
  observerDigest?: Pick<
    SessionObserverDigest,
    "runId" | "headline" | "health" | "updatedAt" | "revision"
  > | null;
}): SidebarSessionSubtitle {
  const { session } = params;
  const attention = sessionAttentionSubtitle(session.attention);
  // Agent-declared status (sessions tool) outranks live narration: it is an
  // explicit message to the user, not ambient activity.
  const agentStatus = session.agentStatusNote || undefined;
  const running = session.hasActiveRun || session.status === "running";
  const activeRunIds = session.activeRunIds ?? [];
  const digestMatchesActiveRun = (
    digest: typeof params.observerDigest,
  ): digest is NonNullable<typeof digest> =>
    Boolean(digest?.runId && activeRunIds.includes(digest.runId));
  const liveCandidate = digestMatchesActiveRun(params.observerDigest)
    ? params.observerDigest
    : undefined;
  const rowCandidate = digestMatchesActiveRun(session.observerDigest)
    ? session.observerDigest
    : undefined;
  const projectedDigest = running
    ? pickFreshestObserverDigest(liveCandidate, rowCandidate)
    : pickFreshestObserverDigest(params.observerDigest, session.observerDigest);
  const finalDigestUnread = Boolean(
    projectedDigest &&
    (projectedDigest.health === "done" || projectedDigest.health === "failed") &&
    (session.lastReadAt ?? 0) < projectedDigest.updatedAt,
  );
  const observer = running || finalDigestUnread ? projectedDigest?.headline : undefined;
  const narration =
    attention || agentStatus || observer || !params.sidebarLiveActivity || !running
      ? undefined
      : params.narrationLine;
  const workSubtitle = params.hasDisplay
    ? params.displaySubtitle
    : session.subtitle && session.workSession && session.subtitle !== session.label
      ? session.subtitle
      : undefined;
  return { subtitle: attention ?? agentStatus ?? observer ?? narration ?? workSubtitle, narration };
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
