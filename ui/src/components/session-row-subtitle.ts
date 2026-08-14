import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../i18n/index.ts";
import { pickFreshestObserverDigest } from "../lib/observer-digest.ts";
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";

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

type SidebarSessionSubtitle = {
  subtitle: string | undefined;
  narration: string | undefined;
  /**
   * The subtitle slot is currently spelling out a pending approval. Recorded
   * here because only this resolver knows which candidate won the slot; the
   * renderer would have to compare translated strings to find out.
   */
  awaitingApproval: boolean;
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
    "agentId" | "runId" | "headline" | "health" | "updatedAt" | "revision"
  > | null;
}): SidebarSessionSubtitle {
  const { session } = params;
  const attention = sessionAttentionSubtitle(session.attention);
  // Agent-declared status (sessions tool) outranks live narration: it is an
  // explicit message to the user, not ambient activity.
  const agentStatus = session.agentStatusNote || undefined;
  const running = session.hasActiveRun;
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
  const finalReply =
    !running && !params.hasDisplay ? session.lastMessagePreview?.trim() || undefined : undefined;
  const subtitle = running
    ? (attention ?? agentStatus ?? observer ?? narration ?? workSubtitle)
    : (attention ?? agentStatus ?? finalReply ?? observer ?? workSubtitle);
  return {
    subtitle,
    narration,
    awaitingApproval: session.attention.kind === "approval" && subtitle === attention,
  };
}

export function renderSidebarSessionSubtitle(value: SidebarSessionSubtitle) {
  if (!value.subtitle) {
    return nothing;
  }
  if (value.narration) {
    return keyed(
      value.narration,
      html`<span
        class="sidebar-recent-session__subtitle sidebar-recent-session__subtitle--narration"
        >${value.subtitle}</span
      >`,
    );
  }
  // A pending approval is the one subtitle that is also a request: it shimmers
  // so a waiting session reads as waiting without spending the row's state slot.
  const approval = value.awaitingApproval ? " sidebar-recent-session__subtitle--approval" : "";
  return html`<span class="sidebar-recent-session__subtitle${approval}">${value.subtitle}</span>`;
}
