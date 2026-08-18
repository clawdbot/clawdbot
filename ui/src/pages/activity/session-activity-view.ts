import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import "../../components/viewer-facepile.ts";
import "../../components/web-awesome-popover.ts";
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
  expandedAutomationDays: ReadonlySet<string>;
  filters: SessionActivityFilters;
  presenceViewers: readonly PresenceViewer[];
  retainedIdentity: PresenceViewer | null;
  rows: readonly GatewaySessionRow[];
  onAutomationDayToggle: (dayKey: string) => void;
  onFiltersChange: (filters: SessionActivityFilters) => void;
};

const TIME_LABELS: Record<ActivityTimeFilter, string> = {
  "24h": "activityFeed.time24h",
  "7d": "activityFeed.time7d",
  "30d": "activityFeed.time30d",
  all: "activityFeed.timeAll",
};

type ActivityPerson = PresenceViewer & { count: number; lastActiveAt: number };

function isUnresolvedPerson(person: PresenceViewer): boolean {
  return !person.name && !person.email && presenceViewerLabel(person) === person.id;
}

function compactPersonLabel(person: PresenceViewer): string {
  return isUnresolvedPerson(person) && person.id.length > 8
    ? `${person.id.slice(0, 8)}…`
    : presenceViewerLabel(person);
}

function renderPersonAvatar(person: PresenceViewer, showPresence = false) {
  if (isUnresolvedPerson(person)) {
    return html`<span
      class="viewer-avatar viewer-avatar--overflow activity-feed__unknown-avatar"
      aria-hidden="true"
      >${icons.users}</span
    >`;
  }
  return html`<span class="activity-feed__person-avatar">
    <openclaw-viewer-avatar
      .user=${person}
      .markAsViewer=${false}
      variant="footer"
    ></openclaw-viewer-avatar>
    ${showPresence && (person.entries?.length ?? 0) > 0
      ? html`<span
          class="activity-feed__presence-dot"
          aria-label=${t("activityFeed.online")}
        ></span>`
      : nothing}
  </span>`;
}

function selectPerson(event: Event, props: SessionActivityViewProps, personId: string | null) {
  if (event.currentTarget instanceof Element) {
    event.currentTarget.closest("wa-popover")?.removeAttribute("open");
  }
  props.onFiltersChange({ ...props.filters, personId });
}

function setPeopleExpanded(event: Event, expanded: boolean) {
  if (event.currentTarget instanceof Element) {
    event.currentTarget.parentElement
      ?.querySelector(".activity-feed__people-trigger")
      ?.setAttribute("aria-expanded", String(expanded));
  }
}

function renderPersonRow(person: ActivityPerson, props: SessionActivityViewProps) {
  const online = (person.entries?.length ?? 0) > 0;
  return html`<button
    type="button"
    class="session-menu__item activity-feed__people-row"
    data-activity-person=${person.id}
    aria-pressed=${String(props.filters.personId === person.id)}
    @click=${(event: Event) => selectPerson(event, props, person.id)}
  >
    ${renderPersonAvatar(person, true)}
    <span class="activity-feed__people-copy">
      <span class="activity-feed__people-name">${compactPersonLabel(person)}</span>
      ${online
        ? nothing
        : html`<span class="activity-feed__last-active">
            ${t("activityFeed.lastActive", {
              time: formatRelativeTimestamp(person.lastActiveAt, { fallback: "" }),
            })}
          </span>`}
    </span>
    <span class="activity-feed__people-count">${person.count}</span>
  </button>`;
}

function renderPeopleControl(
  props: SessionActivityViewProps,
  people: readonly ActivityPerson[],
  selectedPerson: PresenceViewer | null,
  totalSessions: number,
) {
  const visible = people.slice(0, 3);
  const overflow = people.length - visible.length;
  const resolved = people.filter((person) => !isUnresolvedPerson(person));
  const unresolved = people.filter(isUnresolvedPerson);
  return html`<div class="activity-feed__people-control">
    <button
      id="activity-feed-people-trigger"
      type="button"
      class="btn btn--sm activity-feed__people-trigger"
      aria-label=${t("activityFeed.peopleButtonLabel")}
      aria-haspopup="dialog"
      aria-expanded="false"
    >
      ${selectedPerson
        ? html`${renderPersonAvatar(selectedPerson)}<span class="activity-feed__selected-person"
              >${compactPersonLabel(selectedPerson)}</span
            >`
        : html`<span class="activity-feed__facepile" aria-hidden="true">
            ${visible.length > 0
              ? visible.map((person) => renderPersonAvatar(person))
              : html`<span
                  class="viewer-avatar viewer-avatar--overflow activity-feed__unknown-avatar"
                  >${icons.users}</span
                >`}
            ${overflow > 0
              ? html`<span class="viewer-avatar viewer-avatar--overflow">+${overflow}</span>`
              : nothing}
          </span>`}
    </button>
    ${selectedPerson
      ? html`<button
          type="button"
          class="btn btn--sm activity-feed__people-clear"
          aria-label=${t("activityFeed.clearPersonFilter")}
          @click=${() => props.onFiltersChange({ ...props.filters, personId: null })}
        >
          ×
        </button>`
      : nothing}
    <wa-popover
      class="activity-feed__people-popover"
      for="activity-feed-people-trigger"
      placement="bottom-end"
      without-arrow
      @wa-show=${(event: Event) => setPeopleExpanded(event, true)}
      @wa-hide=${(event: Event) => setPeopleExpanded(event, false)}
    >
      <div class="activity-feed__people-panel" aria-label=${t("activityFeed.peopleButtonLabel")}>
        <button
          type="button"
          class="session-menu__item activity-feed__people-row"
          data-activity-person=""
          aria-pressed=${String(props.filters.personId === null)}
          @click=${(event: Event) => selectPerson(event, props, null)}
        >
          <span
            class="viewer-avatar viewer-avatar--overflow activity-feed__unknown-avatar"
            aria-hidden="true"
            >${icons.users}</span
          >
          <span class="activity-feed__people-copy">
            <span class="activity-feed__people-name">${t("activityFeed.everyone")}</span>
          </span>
          <span class="activity-feed__people-count">${totalSessions}</span>
        </button>
        ${resolved.map((person) => renderPersonRow(person, props))}
        ${unresolved.length > 0
          ? html`<div class="session-menu__separator" role="separator"></div>
              <div class="activity-feed__people-group-label">
                ${t("activityFeed.unresolvedIdentities")}
              </div>
              <div data-activity-unresolved>
                ${unresolved.map((person) => renderPersonRow(person, props))}
              </div>`
          : nothing}
      </div>
    </wa-popover>
  </div>`;
}

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

function renderDaySessions(
  props: SessionActivityViewProps,
  day: ReturnType<typeof projectSessionActivity>["days"][number],
) {
  if (props.filters.query || props.filters.personId) {
    return day.sessions.map((row) => renderSessionLink(props.context, row));
  }
  // GatewaySessionRow.hasAutomation records that an enabled cron job is bound to the session;
  // grouping must consume that fact directly rather than infer automation from titles or keys.
  const automation = day.sessions.filter((row) => row.hasAutomation === true);
  if (automation.length < 2) {
    return day.sessions.map((row) => renderSessionLink(props.context, row));
  }
  const expanded = props.expandedAutomationDays.has(day.key);
  return html`
    ${day.sessions
      .filter((row) => row.hasAutomation !== true)
      .map((row) => renderSessionLink(props.context, row))}
    <button
      type="button"
      class="activity-feed__session activity-feed__automation-group"
      data-activity-automation-group=${day.key}
      aria-expanded=${String(expanded)}
      @click=${() => props.onAutomationDayToggle(day.key)}
    >
      <span class="activity-feed__automation-group-icon" aria-hidden="true">${icons.clock}</span>
      <span>${t("activityFeed.automationGroup", { count: String(automation.length) })}</span>
      <span class="activity-feed__automation-group-chevron" aria-hidden="true"
        >${icons.chevronRight}</span
      >
    </button>
    ${expanded ? automation.map((row) => renderSessionLink(props.context, row)) : nothing}
  `;
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
  const onlineById = new Map(props.presenceViewers.map((person) => [person.id, person]));
  const people = projection.people.map((person) => {
    const online = onlineById.get(person.id);
    return online
      ? { ...person, ...online, count: person.count, lastActiveAt: person.lastActiveAt }
      : person;
  });
  const selectedPerson = props.filters.personId
    ? (people.find((person) => person.id === props.filters.personId) ?? identity)
    : null;
  return html`
    <div class="activity-feed">
      <div class="activity-feed__toolbar">
        <label class="data-table-search activity-feed__search">
          ${icons.search}
          <input
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
        <div
          class="settings-segmented activity-feed__time-filter"
          role="group"
          aria-label=${t("activityFeed.time")}
        >
          ${ACTIVITY_TIME_FILTERS.map(
            (time) => html`<button
              type="button"
              class="settings-segmented__btn ${props.filters.time === time
                ? "settings-segmented__btn--active"
                : ""}"
              aria-pressed=${String(props.filters.time === time)}
              @click=${() => props.onFiltersChange({ ...props.filters, time })}
            >
              ${t(TIME_LABELS[time])}
            </button>`,
          )}
        </div>
        ${renderPeopleControl(props, people, selectedPerson, projection.timeCount)}
      </div>
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
                      <div class="activity-feed__sessions">${renderDaySessions(props, day)}</div>
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
