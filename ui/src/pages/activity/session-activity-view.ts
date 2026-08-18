import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import "../../components/viewer-facepile.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, formatTimeAgo } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import {
  isPresenceViewerIdle,
  presenceViewerLabel,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  ACTIVITY_TIME_FILTERS,
  projectSessionActivity,
  resolveViewingNow,
  sessionActivityOwner,
  sessionActivityTimestamp,
  type ActivityTimeFilter,
  type SessionActivityFilters,
} from "./session-activity.ts";

type SessionActivityViewProps = {
  context: ApplicationContext;
  filters: SessionActivityFilters;
  retainedIdentity: PresenceViewer | null;
  rows: readonly GatewaySessionRow[];
  onFiltersChange: (filters: SessionActivityFilters) => void;
};

const TIME_LABELS: Record<ActivityTimeFilter, string> = {
  "24h": "activityFeed.time24h",
  "7d": "activityFeed.time7d",
  "30d": "activityFeed.time30d",
  all: "activityFeed.timeAll",
};

function navigateToSession(event: MouseEvent, context: ApplicationContext, row: GatewaySessionRow) {
  if (!shouldHandleNavigationClick(event)) {
    return;
  }
  event.preventDefault();
  const face = resolveSessionPreferredFace(row);
  const target = sessionNavigationTarget({ context, face, sessionKey: row.key });
  context.navigate(face, target.options);
}

function sessionHref(context: ApplicationContext, row: GatewaySessionRow): string {
  return sessionNavigationTarget({
    context,
    face: resolveSessionPreferredFace(row),
    sessionKey: row.key,
  }).href;
}

function dayLabel(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) {
    return t("activityFeed.unknownDate");
  }
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const yesterdayDate = new Date(today);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  if (timestamp === today) {
    return t("activityFeed.today");
  }
  if (timestamp === yesterdayDate.getTime()) {
    return t("activityFeed.yesterday");
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(timestamp);
}

function renderSessionLink(context: ApplicationContext, row: GatewaySessionRow) {
  const owner = sessionActivityOwner(row);
  const ownerName = presenceViewerLabel(owner);
  const activityAt = sessionActivityTimestamp(row);
  const scope = row.channel
    ? t("activityFeed.channelLabel", { value: row.channel })
    : row.agentId
      ? t("activityFeed.agentLabel", { value: row.agentId })
      : null;
  return html`<a
    class="activity-feed__session"
    data-activity-session=${row.key}
    href=${sessionHref(context, row)}
    @click=${(event: MouseEvent) => navigateToSession(event, context, row)}
  >
    <openclaw-viewer-avatar
      .user=${owner}
      .markAsViewer=${false}
      variant="footer"
    ></openclaw-viewer-avatar>
    <span class="activity-feed__session-main">
      <span class="activity-feed__session-title">${resolveSessionDisplayName(row.key, row)}</span>
      <span class="activity-feed__session-meta">
        <span>${ownerName}</span>${scope
          ? html`<span class="activity-feed__session-scope">${scope}</span>`
          : nothing}
      </span>
    </span>
    <span class="activity-feed__session-time">
      ${activityAt > 0 ? formatRelativeTimestamp(activityAt, { fallback: "" }) : nothing}
    </span>
  </a>`;
}

function renderIdentityHeader(
  context: ApplicationContext,
  identity: PresenceViewer,
  rows: readonly GatewaySessionRow[],
) {
  const online = (identity.entries?.length ?? 0) > 0;
  const idle = online && isPresenceViewerIdle(identity);
  const status = online
    ? idle
      ? t("activityFeed.idle")
      : t("activityFeed.online")
    : t("activityFeed.offline");
  const devices = identity.entries ?? [];
  const viewing = resolveViewingNow(identity, rows);
  return html`
    <section class="activity-feed__identity" data-activity-identity=${identity.id}>
      <div class="activity-feed__identity-main">
        <openclaw-viewer-avatar
          .user=${identity}
          .markAsViewer=${false}
          variant="profile"
        ></openclaw-viewer-avatar>
        <div class="activity-feed__identity-copy">
          <h2>${presenceViewerLabel(identity)}</h2>
          ${identity.email ? html`<p>${identity.email}</p>` : nothing}
        </div>
        ${renderSettingsStatus({ kind: online ? (idle ? "warn" : "ok") : "muted", label: status })}
      </div>
      ${devices.length > 0
        ? html`<div class="activity-feed__devices">
            ${devices.map((entry) => {
              const device = [entry.deviceFamily, entry.platform].filter(Boolean).join(" · ");
              return html`<div class="activity-feed__device">
                <span class="activity-feed__device-name"
                  >${entry.host ?? t("activityFeed.unknownDevice")}</span
                >
                ${device ? html`<span>${device}</span>` : nothing}
                ${entry.lastInputSeconds !== undefined
                  ? html`<span
                      >${t("activityFeed.lastInput", {
                        time: formatTimeAgo(entry.lastInputSeconds * 1000, { suffix: false }),
                      })}</span
                    >`
                  : nothing}
              </div>`;
            })}
          </div>`
        : nothing}
      <div class="activity-feed__viewing">
        <h3>${t("activityFeed.viewingNow")}</h3>
        ${viewing.length > 0
          ? html`<div class="activity-feed__viewing-list">
              ${viewing.map((row) => renderSessionLink(context, row))}
            </div>`
          : html`<p class="activity-feed__empty-note">${t("activityFeed.notViewing")}</p>`}
      </div>
    </section>
  `;
}

export function renderSessionActivityView(props: SessionActivityViewProps) {
  const projection = projectSessionActivity(props.rows, props.filters);
  const identity = props.retainedIdentity;
  return html`
    <div class="activity-feed">
      <aside class="activity-feed__facets" aria-label=${t("activityFeed.filters")}>
        <label class="activity-feed__search">
          <span>${t("activityFeed.search")}</span>
          <input
            class="input"
            type="search"
            .value=${props.filters.query}
            placeholder=${t("activityFeed.searchPlaceholder")}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                props.onFiltersChange({ ...props.filters, query: event.currentTarget.value });
              }
            }}
          />
        </label>
        <section class="activity-feed__facet">
          <h2>${t("activityFeed.time")}</h2>
          ${ACTIVITY_TIME_FILTERS.map(
            (time) => html`<button
              type="button"
              class="activity-feed__facet-option"
              aria-pressed=${String(props.filters.time === time)}
              @click=${() => props.onFiltersChange({ ...props.filters, time })}
            >
              <span>${t(TIME_LABELS[time])}</span>
            </button>`,
          )}
        </section>
        <section class="activity-feed__facet">
          <h2>${t("activityFeed.people")}</h2>
          <button
            type="button"
            class="activity-feed__facet-option"
            aria-pressed=${String(props.filters.personId === null)}
            @click=${() => props.onFiltersChange({ ...props.filters, personId: null })}
          >
            <span>${t("activityFeed.allPeople")}</span>
            <span class="activity-feed__facet-count">${projection.timeCount}</span>
          </button>
          ${projection.people.map(
            (person) => html`<button
              type="button"
              class="activity-feed__facet-option activity-feed__person"
              aria-pressed=${String(props.filters.personId === person.id)}
              @click=${() => props.onFiltersChange({ ...props.filters, personId: person.id })}
            >
              <openclaw-viewer-avatar
                .user=${person}
                .markAsViewer=${false}
                variant="footer"
              ></openclaw-viewer-avatar>
              <span>${presenceViewerLabel(person)}</span>
              <span class="activity-feed__facet-count">${person.count}</span>
            </button>`,
          )}
        </section>
      </aside>
      <main class="activity-feed__main">
        ${props.filters.personId
          ? identity
            ? renderIdentityHeader(props.context, identity, props.rows)
            : html`<section class="activity-feed__not-found" role="status">
                <h2>${t("activityFeed.notFoundTitle")}</h2>
                <p>${t("activityFeed.notFoundDescription")}</p>
              </section>`
          : nothing}
        ${!props.filters.personId || identity
          ? html`
              <div class="activity-feed__summary">
                <h2>${t("activityFeed.sessions")}</h2>
                <span
                  >${t("activityFeed.showing", {
                    shown: String(projection.sessions.length),
                    total: String(projection.matchedCount),
                  })}</span
                >
              </div>
              ${projection.days.length > 0
                ? projection.days.map(
                    (day) => html`<section class="activity-feed__day">
                      <h3>${dayLabel(day.timestamp)}</h3>
                      <div class="activity-feed__sessions">
                        ${day.sessions.map((row) => renderSessionLink(props.context, row))}
                      </div>
                    </section>`,
                  )
                : html`<section class="activity-feed__empty" role="status">
                    ${t("activityFeed.noSessions")}
                  </section>`}
            `
          : nothing}
      </main>
    </div>
  `;
}
