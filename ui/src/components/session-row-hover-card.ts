import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import type { SessionCreatedActor } from "./session-owner-chip.ts";
import {
  formatSessionPullRequestSummary,
  isCloudWorkerPlacementState,
} from "./session-row-badges.ts";
import { presenceViewerLabel, sessionPresenceViewers } from "./viewer-facepile.ts";

/**
 * A card that opens as fast as a label would flash past every row a reader
 * crosses on the way somewhere else. The tooltip provider's skip-delay window
 * still lets siblings open at once once the reader has asked for the first.
 */
export const SESSION_CARD_COLD_DELAY_MS = 400;

/**
 * One line of session context. `label` is the quiet word for what the fact is;
 * `value` is the fact itself and carries the emphasis, because the reader came
 * for the branch name, not for the word "Branch".
 */
type SessionContextRow = {
  icon: TemplateResult;
  label?: string;
  value: string | TemplateResult;
  danger?: boolean;
};

/**
 * The caller decides whether attribution belongs on screen at all — a solo
 * Gateway shows none — and the card names the person the row's avatar can only
 * hint at. The avatar itself stays on the row: repeating it here would spend a
 * line of the card on something already visible beside it.
 */
function ownerRow(
  owner: SessionCreatedActor | undefined,
  attribution: "created" | "archived",
): SessionContextRow | undefined {
  const name = owner?.label ?? owner?.id;
  if (!name) {
    return undefined;
  }
  return {
    icon: icons.circleUser,
    label: t(
      attribution === "archived" ? "sessionsView.archivedByLabel" : "sessionsView.createdByLabel",
    ),
    value: name,
  };
}

/**
 * The row abbreviates the checkout to a folder name; the card is where the
 * whole path belongs. A session with no checkout still has a working directory,
 * and a session with neither simply has no project to claim.
 */
function projectRow(session: SidebarRecentSession): SessionContextRow | undefined {
  const path = session.worktree?.repoRoot ?? session.execCwd;
  if (!path) {
    return undefined;
  }
  return { icon: icons.folder, label: t("sessionsView.projectLabel"), value: path };
}

function cloudRow(session: SidebarRecentSession): SessionContextRow | undefined {
  const state = session.placementState;
  if (!state || !isCloudWorkerPlacementState(state)) {
    return undefined;
  }
  const conflicts = session.workspaceConflictCount ?? 0;
  if (conflicts > 0) {
    return {
      icon: icons.alertTriangle,
      value: t(
        conflicts === 1
          ? "sessionsView.cloudWorkerPlacementConflict"
          : "sessionsView.cloudWorkerPlacementConflicts",
        { count: String(conflicts), state },
      ),
      danger: true,
    };
  }
  return {
    icon: state === "failed" ? icons.alertTriangle : icons.globe,
    value: t("sessionsView.cloudWorkerPlacement", { state }),
    danger: state === "failed",
  };
}

function buildSessionContextRows(params: {
  session: SidebarRecentSession;
  owner?: SessionCreatedActor;
  attribution: "created" | "archived";
  presencePayload?: unknown;
  selfUserId?: string;
  selfInstanceId?: string;
}): SessionContextRow[] {
  const { session } = params;
  const viewers = sessionPresenceViewers(
    params.presencePayload,
    params.selfUserId,
    params.selfInstanceId,
    session.key,
  );
  const rows: (SessionContextRow | undefined)[] = [
    ownerRow(params.owner, params.attribution),
    projectRow(session),
    session.worktree?.branch
      ? {
          icon: icons.gitBranch,
          label: t("sessionsView.branchLabel"),
          value: session.worktree.branch,
        }
      : undefined,
    viewers.length > 0
      ? {
          icon: icons.eye,
          label: t("presence.rosterTitle"),
          value: viewers.map(presenceViewerLabel).join(", "),
        }
      : undefined,
    session.visibility === "draft"
      ? {
          icon: icons.eyeOff,
          label: t("newSession.draft"),
          value: t("newSession.draftDescription"),
        }
      : undefined,
    session.incognito
      ? {
          icon: icons.lock,
          label: t("newSession.incognito"),
          value: t("newSession.incognitoDescription"),
        }
      : undefined,
    session.pullRequest
      ? {
          icon: icons.gitPullRequest,
          value: formatSessionPullRequestSummary(session.pullRequest),
        }
      : undefined,
    cloudRow(session),
  ];
  // Unread and Active run are deliberately absent: they are row state the
  // reader can already see, and repeating them would cost the card its promise
  // of saying something the row could not.
  return rows.filter((row) => row !== undefined);
}

function renderSessionContextRow(row: SessionContextRow): TemplateResult {
  return html`<div
    class="session-hover-card__row ${row.danger ? "session-hover-card__row--danger" : ""}"
  >
    <span class="session-hover-card__icon" aria-hidden="true">${row.icon}</span>
    <span class="session-hover-card__text">
      ${row.label ? html`<span class="session-hover-card__label">${row.label}</span>` : nothing}
      ${typeof row.value === "string"
        ? html`<span class="session-hover-card__value">${row.value}</span>`
        : row.value}
    </span>
  </div>`;
}

/**
 * One card anatomy for every session the sidebar lists, so scanning from a
 * pinned row to a Codex row reads as the same surface following the pointer.
 * A session with no facts beyond its name gets a header and nothing else — an
 * empty body is a truthful answer, and filler invented to avoid it is not.
 */
function renderInformationCard(
  title: string,
  age: string,
  rows: readonly SessionContextRow[],
): TemplateResult {
  return html`<div class="sidebar-hover-card session-hover-card" slot="content">
    <div class="session-hover-card__header">
      <span class="session-hover-card__title">${title}</span>
      ${age ? html`<span class="session-hover-card__age">${age}</span>` : nothing}
    </div>
    ${rows.length === 0
      ? nothing
      : html`<div class="session-hover-card__divider"></div>
          <div class="session-hover-card__body">${rows.map(renderSessionContextRow)}</div>`}
  </div>`;
}

/**
 * The full title the row had to truncate, when the session last moved, and
 * every context fact the Gateway actually knows about it.
 */
export function renderSessionInformationCard(params: {
  session: SidebarRecentSession;
  title: string;
  owner?: SessionCreatedActor;
  attribution: "created" | "archived";
  presencePayload?: unknown;
  selfUserId?: string;
  selfInstanceId?: string;
}): TemplateResult {
  return renderInformationCard(
    params.title,
    formatRelativeTimestamp(params.session.updatedAt, { suffix: false }),
    buildSessionContextRows(params),
  );
}

/**
 * The same card for a session the Gateway knows only through a provider
 * catalog, where the working directory and branch are the whole context.
 */
export function renderCatalogSessionInformationCard(params: {
  title: string;
  age: string;
  cwd?: string;
  branch?: string;
}): TemplateResult {
  const rows: SessionContextRow[] = [];
  if (params.cwd) {
    rows.push({ icon: icons.folder, label: t("sessionsView.projectLabel"), value: params.cwd });
  }
  if (params.branch) {
    rows.push({
      icon: icons.gitBranch,
      label: t("sessionsView.branchLabel"),
      value: params.branch,
    });
  }
  return renderInformationCard(params.title, params.age, rows);
}
