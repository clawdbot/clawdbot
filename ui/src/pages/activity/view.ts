// Control UI view renders activity screen content.
import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsRow,
  renderSettingsStatus,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact, formatTimeMs } from "../../lib/format.ts";
import { normalizeLowercaseStringOrEmpty, sortUniqueStrings } from "../../lib/string-coerce.ts";
import "../../styles/activity.css";
import type { ActivityEntry, ActivityStatus } from "./tool-activity.ts";

const STATUS_ORDER: ActivityStatus[] = ["running", "done", "error"];

type ActivityProps = {
  entries: ActivityEntry[];
  filterText: string;
  statusFilters: Record<ActivityStatus, boolean>;
  toolFilter: string;
  expandedIds: Set<string>;
  autoFollow: boolean;
  onFilterTextChange: (next: string) => void;
  onToolFilterChange: (next: string) => void;
  onStatusToggle: (status: ActivityStatus, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onClear: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onEntryToggle: (id: string, open: boolean) => void;
  onScroll: (event: Event) => void;
};

function formatTime(value: number): string {
  return formatTimeMs(
    value,
    {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    },
    "",
  );
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return t("common.na");
  }
  return formatDurationCompact(value, { spaced: true }) ?? "0ms";
}

function statusLabel(status: ActivityStatus): string {
  return t(`activity.status.${status}`);
}

function hiddenArgumentsLabel(count: number): string {
  if (count === 1) {
    return t("activity.argumentHiddenOne");
  }
  return t("activity.argumentsHidden", { count: String(count) });
}

function buildEntrySummary(entry: ActivityEntry): string {
  if (entry.entryKind === "answer_candidate") {
    return t(`activity.answerCandidate.${entry.candidateStatus ?? "candidate"}`);
  }
  return t("activity.entrySummary", {
    argumentSummary: hiddenArgumentsLabel(entry.hiddenArgumentCount),
    status: statusLabel(entry.status),
    tool: entry.toolName,
  });
}

function entryLabel(entry: ActivityEntry): string {
  return entry.entryKind === "answer_candidate"
    ? t("activity.answerCandidate.title")
    : entry.toolName;
}

function matchesEntry(entry: ActivityEntry, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = normalizeLowercaseStringOrEmpty(
    [
      entry.toolName,
      entryLabel(entry),
      entry.candidateStatus,
      entry.status,
      entry.summary,
      buildEntrySummary(entry),
      entry.outputPreview,
      entry.runId,
      entry.toolCallId,
      entry.sessionKey,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return haystack.includes(needle);
}

function resolveToolNames(entries: ActivityEntry[]): string[] {
  return sortUniqueStrings(entries.map((entry) => entry.toolName));
}

function filterEntries(props: ActivityProps): ActivityEntry[] {
  const needle = normalizeLowercaseStringOrEmpty(props.filterText);
  return props.entries.filter((entry) => {
    if (!props.statusFilters[entry.status]) {
      return false;
    }
    if (props.toolFilter && entry.toolName !== props.toolFilter) {
      return false;
    }
    return matchesEntry(entry, needle);
  });
}

function renderStatusFilter(props: ActivityProps, status: ActivityStatus) {
  return html`
    <label class="activity-status-filter">
      <input
        type="checkbox"
        .checked=${props.statusFilters[status]}
        @change=${(event: Event) =>
          props.onStatusToggle(status, (event.target as HTMLInputElement).checked)}
      />
      <span>${statusLabel(status)}</span>
    </label>
  `;
}

const STATUS_KINDS = {
  running: "warn",
  done: "ok",
  error: "danger",
} as const satisfies Record<ActivityStatus, "warn" | "ok" | "danger">;

function statusKind(status: ActivityStatus): "warn" | "ok" | "danger" {
  return STATUS_KINDS[status];
}

function renderEntry(props: ActivityProps, entry: ActivityEntry) {
  const open = props.expandedIds.has(entry.id);
  return html`
    <details
      class="activity-entry activity-entry--${entry.status}"
      role="listitem"
      .open=${open}
      @toggle=${(event: Event) =>
        props.onEntryToggle(entry.id, (event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class="activity-entry__summary">
        <span class="activity-entry__chevron" aria-hidden="true">${icons.chevronRight}</span>
        <span class="activity-entry__main">
          <span class="activity-entry__title">
            ${renderSettingsStatus({
              kind: statusKind(entry.status),
              label: statusLabel(entry.status),
            })}
            <span class="activity-entry__tool mono">${entryLabel(entry)}</span>
          </span>
          <span class="activity-entry__text">${buildEntrySummary(entry)}</span>
        </span>
        <span class="activity-entry__meta">
          <span>${formatTime(entry.updatedAt)}</span>
          <span>${formatDuration(entry.durationMs)}</span>
        </span>
      </summary>
      <div class="activity-entry__body">
        <div class="activity-entry__facts">
          ${entry.entryKind === "answer_candidate"
            ? html`<span class="mono"
                >${t("activity.answerCandidate.itemId")}: ${entry.itemId}</span
              >`
            : html`
                <span>${hiddenArgumentsLabel(entry.hiddenArgumentCount)}</span>
                <span class="mono">${t("activity.toolCallId")}: ${entry.toolCallId}</span>
              `}
          <span class="mono">${t("activity.runId")}: ${entry.runId}</span>
          ${entry.sessionKey
            ? html`<span class="mono">${t("activity.session")}: ${entry.sessionKey}</span>`
            : nothing}
        </div>
        ${entry.outputPreview
          ? html`
              <pre class="activity-entry__preview">${entry.outputPreview}</pre>
              ${entry.outputTruncated
                ? html`<div class="activity-entry__note">${t("activity.outputTruncated")}</div>`
                : nothing}
            `
          : html`<div class="activity-entry__note">${t("activity.noOutputPreview")}</div>`}
      </div>
    </details>
  `;
}

export function renderActivity(props: ActivityProps) {
  const toolNames = resolveToolNames(props.entries);
  const filtered = filterEntries(props);
  const hasAnyFilters =
    props.filterText.trim() ||
    props.toolFilter ||
    STATUS_ORDER.some((status) => !props.statusFilters[status]);

  // The stream fills the remaining viewport height; the settings-page column
  // wrapper is intentionally skipped so the fill-height flex chain
  // (.settings-workspace--fill-height … .activity-page … .activity-group …
  // .activity-stream) works. The named <section> keeps the region landmark.
  return html`
    <section class="activity-page" aria-label=${t("activity.title")}>
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("activity.title")}</h2>
        <div class="settings-section__actions">
          <span class="activity-count" aria-live="polite">
            ${t("activity.visibleCount", {
              visible: String(filtered.length),
              total: String(props.entries.length),
            })}
          </span>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${filtered.length === 0}
            @click=${props.onExpandAll}
          >
            ${t("activity.expandAll")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${props.expandedIds.size === 0}
            @click=${props.onCollapseAll}
          >
            ${t("activity.collapseAll")}
          </button>
          <button
            type="button"
            class="btn btn--sm danger"
            ?disabled=${props.entries.length === 0}
            @click=${props.onClear}
          >
            ${t("activity.clear")}
          </button>
        </div>
      </div>
      <div class="settings-group activity-group">
        ${renderSettingsRow({
          title: t("activity.search"),
          control: html`
            <input
              class="settings-input"
              type="search"
              aria-label=${t("activity.search")}
              .value=${props.filterText}
              placeholder=${t("activity.searchPlaceholder")}
              @input=${(event: Event) =>
                props.onFilterTextChange((event.target as HTMLInputElement).value)}
            />
          `,
        })}
        ${renderSettingsRow({
          title: t("activity.toolFilter"),
          control: html`
            <select
              class="settings-select"
              aria-label=${t("activity.toolFilter")}
              .value=${props.toolFilter}
              @change=${(event: Event) =>
                props.onToolFilterChange((event.target as HTMLSelectElement).value)}
            >
              <option value="">${t("activity.allTools")}</option>
              ${toolNames.map((name) => html`<option value=${name}>${name}</option>`)}
            </select>
          `,
        })}
        ${renderSettingsRow({
          title: t("activity.statusFilters"),
          control: html`
            <span
              role="group"
              aria-label=${t("activity.statusFilters")}
              class="activity-status-filters"
            >
              ${STATUS_ORDER.map((status) => renderStatusFilter(props, status))}
            </span>
          `,
        })}
        ${renderSettingsRow({
          title: t("activity.autoFollow"),
          control: renderSettingsToggle({
            checked: props.autoFollow,
            ariaLabel: t("activity.autoFollow"),
            onChange: (checked) => props.onToggleAutoFollow(checked),
          }),
        })}
        <div
          class="activity-stream"
          role="list"
          aria-label=${t("activity.streamLabel")}
          @scroll=${props.onScroll}
        >
          ${filtered.length === 0
            ? html`
                <div class="activity-empty">
                  ${props.entries.length === 0 || !hasAnyFilters
                    ? t("activity.empty")
                    : t("activity.emptyFiltered")}
                </div>
              `
            : filtered.map((entry) => renderEntry(props, entry))}
        </div>
      </div>
    </section>
  `;
}
