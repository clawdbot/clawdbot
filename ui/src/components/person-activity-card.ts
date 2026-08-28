import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { i18n, t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { PresenceViewer } from "../lib/presence-users.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  canonicalUiSessionKeyForPersistence,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { icons } from "./icons.ts";
import { personActivityLink, type PersonActivityRouting } from "./person-activity-link.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import "./elapsed-time.ts";
import "./viewer-facepile.ts";

type ScopedSession = { row: GatewaySessionRow; agentId: string };
type PersonSessionData = Readonly<
  Pick<
    SessionDataController,
    | "sessionsAgentId"
    | "sessionsResult"
    | "sessionResultsByAgent"
    | "childSessionRowsByParent"
    | "loadedChildSessionKeys"
  >
>;
type PersonCardInput = {
  user: PresenceViewer;
  sessionData: PersonSessionData;
  watchAgentId: string;
  mainKey: string;
  globalScope: boolean;
  routing: PersonActivityRouting;
  openSession: (row: GatewaySessionRow, agentId: string) => void;
};

/** Loaded, caller-visible roster facts, paired with their owning list scope. */
function loadedPresenceSessions(data: PersonSessionData): ScopedSession[] {
  const lists = [
    { agentId: data.sessionsAgentId, result: data.sessionsResult },
    ...Object.entries(data.sessionResultsByAgent).map(([agentId, result]) => ({
      agentId,
      result,
    })),
  ];
  const roots = lists.flatMap(({ agentId, result }) =>
    agentId
      ? (result?.sessions ?? []).map((row) => ({
          row,
          agentId: parseAgentSessionKey(row.key)?.agentId ?? row.agentId ?? agentId,
        }))
      : [],
  );
  const children = Object.entries(data.childSessionRowsByParent).flatMap(([parent, rows]) => {
    const agentId = parseAgentSessionKey(parent)?.agentId ?? data.sessionsAgentId;
    return agentId && data.loadedChildSessionKeys.has(parent)
      ? rows.map((row) => ({
          row,
          agentId: parseAgentSessionKey(row.key)?.agentId ?? row.agentId ?? agentId,
        }))
      : [];
  });
  return [...roots, ...children];
}

function sessionIdentity(key: string, agentId: string, input: PersonCardInput): string {
  const scope = parseAgentSessionKey(key)?.agentId ?? normalizeAgentId(agentId);
  const canonical = canonicalUiSessionKeyForPersistence(
    {
      agentsList: {
        defaultId: scope,
        mainKey: input.mainKey,
        scope: input.globalScope ? "global" : "agent",
      },
    },
    parseAgentSessionKey(key) || key.toLowerCase() === "global" ? key : `agent:${scope}:${key}`,
  );
  return `${scope}\u0000${canonical}`;
}

function observedTimestamp(values: (number | undefined)[], order: "first" | "last") {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length ? (order === "first" ? Math.min(...known) : Math.max(...known)) : undefined;
}

function elapsed(timestamp: number) {
  const date = new Date(timestamp);
  return html`<time
    datetime=${date.toISOString()}
    title=${date.toLocaleString(i18n.getLocale())}
    aria-label=${date.toLocaleString(i18n.getLocale())}
    ><openclaw-elapsed-time .startMs=${timestamp}></openclaw-elapsed-time
  ></time>`;
}

function connections(user: PresenceViewer): string[] {
  // Tabs with the same reported facts are one description, never a device count.
  return [
    ...new Set(
      (user.entries ?? [])
        .map((entry) => {
          const app =
            entry.mode === "webchat"
              ? t("presence.card.controlUi")
              : entry.mode === "cli"
                ? t("presence.card.cli")
                : entry.mode === "ui"
                  ? t("presence.card.app")
                  : undefined;
          return [
            ...new Set(
              [entry.deviceFamily, entry.platform, app]
                .map((value) => value?.trim())
                .filter(Boolean),
            ),
          ].join(" · ");
        })
        .filter(Boolean),
    ),
  ].toSorted();
}

function renderSessions(
  sessions: readonly ScopedSession[],
  input: PersonCardInput,
  recent: boolean,
) {
  const title = t(recent ? "presence.card.recentSessions" : "presence.card.viewingNow");
  return html`<section class="person-activity-card__section">
    <h3>${title}</h3>
    ${sessions.length
      ? html`<div class="person-activity-card__sessions">
          ${repeat(
            sessions.slice(0, 3),
            ({ row, agentId }) => sessionIdentity(row.key, agentId, input),
            ({ row, agentId }) => {
              const target = sessionNavigationTarget({
                face: resolveSessionPreferredFace(row),
                sessionKey: row.key,
                fallbackAgentId: agentId,
                basePath: input.routing.basePath,
                row,
                mainKey: input.mainKey,
              });
              return html`<a
                class="person-activity-card__session"
                href=${target.href}
                @click=${(event: MouseEvent) => {
                  if (!shouldHandleNavigationClick(event)) {
                    return;
                  }
                  event.preventDefault();
                  input.openSession(row, agentId);
                }}
                ><span class="person-activity-card__session-icon" aria-hidden="true"
                  >${icons.messageSquare}</span
                >
                <span class="person-activity-card__session-copy"
                  ><span>${resolveSessionDisplayName(row.key, row)}</span> ${recent &&
                  row.updatedAt != null
                    ? html`<small
                        >${t("presence.card.sessionUpdated")} ${elapsed(row.updatedAt)}
                        ${t("presence.card.ago")}</small
                      >`
                    : nothing}</span
                >
              </a>`;
            },
          )}
        </div>`
      : html`<p class="person-activity-card__muted">
          ${t(recent ? "presence.card.noRecentSessions" : "presence.card.noVisibleSessions")}
        </p>`}
  </section>`;
}

export function renderPersonActivityCard(input: PersonCardInput) {
  const { user } = input;
  const entries = user.entries ?? [];
  const onlineSince = observedTimestamp(
    entries.map((entry) => entry.onlineSince),
    "first",
  );
  const lastActivityAt = observedTimestamp(
    entries.map((entry) => entry.lastActivityAt),
    "last",
  );
  const where = connections(user);
  const zones = [
    ...new Set(entries.flatMap((entry) => (entry.timeZone?.trim() ? [entry.timeZone.trim()] : []))),
  ].toSorted();
  const watched = new Set(
    user.watchedSessions.map((key) => sessionIdentity(key, input.watchAgentId, input)),
  );
  const unique = new Map<string, ScopedSession>();
  // Presence keys are only hints. Intersect the authorized roster before producing any text or href.
  for (const session of loadedPresenceSessions(input.sessionData)) {
    const key = sessionIdentity(session.row.key, session.agentId, input);
    if (!unique.has(key)) {
      unique.set(key, session);
    }
  }
  const sessions = [...unique.values()].toSorted(
    (a, b) =>
      (b.row.updatedAt ?? 0) - (a.row.updatedAt ?? 0) ||
      sessionIdentity(a.row.key, a.agentId, input).localeCompare(
        sessionIdentity(b.row.key, b.agentId, input),
      ),
  );
  const viewing = sessions.filter(({ row, agentId }) =>
    watched.has(sessionIdentity(row.key, agentId, input)),
  );
  const recent = sessions.filter(
    ({ row, agentId }) =>
      !watched.has(sessionIdentity(row.key, agentId, input)) &&
      [row.owner?.actor, row.createdActor].some(
        (actor) => actor?.type === "human" && actor.id === user.id,
      ),
  );
  const activity = personActivityLink(user.id, input.routing)!;
  return html`<div class="person-activity-card">
    <header class="person-activity-card__header">
      <openclaw-viewer-avatar
        .user=${user}
        .markAsViewer=${false}
        variant="footer"
        aria-hidden="true"
      ></openclaw-viewer-avatar>
      <div>
        <h2>${user.name ?? user.email ?? t("presence.card.person")}</h2>
        <span class="person-activity-card__status"
          ><span aria-hidden="true"></span>${t("presence.rosterTitle")}</span
        >
      </div>
    </header>
    <dl class="person-activity-card__facts">
      <div>
        <dt>${t("presence.card.onlineFor")}</dt>
        <dd>
          ${onlineSince === undefined ? t("presence.card.notObserved") : elapsed(onlineSince)}
        </dd>
      </div>
      ${where.length || zones.length
        ? html`<div>
            <dt>${t("presence.card.where")}</dt>
            <dd>
              ${where.map((description) => html`<span>${description}</span>`)}${zones.map(
                (zone) => html`<small>${t("presence.card.reportedTimeZone", { zone })}</small>`,
              )}
            </dd>
          </div>`
        : nothing}
      <div>
        <dt>${t("presence.card.lastActivity")}</dt>
        <dd>
          ${lastActivityAt === undefined
            ? t("presence.card.notObserved")
            : html`<span>${elapsed(lastActivityAt)} ${t("presence.card.ago")}</span>`}
        </dd>
      </div>
    </dl>
    ${renderSessions(viewing, input, false)}${renderSessions(recent, input, true)}
    <footer>
      <a href=${activity.href} @click=${activity.open}
        >${t("presence.card.viewActivity")}<span aria-hidden="true">${icons.chevronRight}</span></a
      >
    </footer>
  </div>`;
}
