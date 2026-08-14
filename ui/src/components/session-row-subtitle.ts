import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../i18n/index.ts";
import { pickFreshestObserverDigest } from "../lib/observer-digest.ts";
import type { SessionWorkContext } from "../lib/session-display.ts";
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";

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
  /** Set only when the slot is showing the session's Git context, so the
      renderer can mark the branch instead of guessing which words are one. */
  work?: SessionWorkContext;
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
  const workContext = params.hasDisplay ? undefined : session.workContext;
  const finalReply =
    !running && !params.hasDisplay ? session.lastMessagePreview?.trim() || undefined : undefined;
  const subtitle = running
    ? (attention ?? agentStatus ?? observer ?? narration ?? workSubtitle)
    : (attention ?? agentStatus ?? finalReply ?? observer ?? workSubtitle);
  // Only the work line is Git; attention, status, narration, and a final reply
  // are prose that must not borrow a branch glyph.
  const work = subtitle && subtitle === workSubtitle ? workContext : undefined;
  return {
    subtitle,
    narration,
    awaitingApproval: session.attention.kind === "approval" && subtitle === attention,
    work,
  };
}

/**
 * Renders the subtitle slot. A Git line gets the branch glyph immediately
 * before the branch and, for a session in its own checkout, a trailing worktree
 * marker that the text fade must not reach. Everything else is prose and gets
 * no glyph at all, so a marked line always means a real Git fact.
 *
 * `project` is the group the row already sits under: repeating that name in the
 * subtitle spends the row's only spare line saying what the heading just said.
 */
export function renderSidebarSessionSubtitle(value: SidebarSessionSubtitle, project?: string) {
  if (value.work) {
    return renderWorkSubtitle(value.work, project);
  }
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

function renderWorkSubtitle(work: SessionWorkContext, project?: string) {
  const repo = work.repo && work.repo !== project ? work.repo : undefined;
  const text = [repo, work.branch, work.node].filter(Boolean).join(" · ");
  if (!text) {
    return nothing;
  }
  return html`<span class="sidebar-recent-session__subtitle sidebar-recent-session__subtitle--git">
    ${work.branch
      ? html`<span class="session-row-git-glyph" aria-hidden="true">${icons.gitBranch}</span>`
      : nothing}
    <span class="sidebar-recent-session__subtitle-text">${text}</span>
    ${work.worktree
      ? html`<span
          class="session-row-worktree-glyph"
          role="img"
          aria-label=${t("sessionsView.worktreeSession")}
          >${icons.worktreeCreated}</span
        >`
      : nothing}
  </span>`;
}
