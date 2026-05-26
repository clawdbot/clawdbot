import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { ActivityEntry, ActivityStatus } from "../activity-model.ts";
import { icons } from "../icons.ts";
import { normalizeLowercaseStringOrEmpty, sortUniqueStrings } from "../string-coerce.ts";

const STATUS_ORDER: ActivityStatus[] = ["running", "done", "error"];

export type ActivityProps = {
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
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return t("common.na");
  }
  if (value < 1_000) {
    return t("activity.duration.ms", { count: String(Math.round(value)) });
  }
  if (value < 60_000) {
    return t("activity.duration.seconds", { count: (value / 1_000).toFixed(1) });
  }
  const roundedSeconds = Math.round(value / 1_000);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return t("activity.duration.minutes", {
    minutes: String(minutes),
    seconds: String(seconds),
  });
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
  return t("activity.entrySummary", {
    argumentSummary: hiddenArgumentsLabel(entry.hiddenArgumentCount),
    status: statusLabel(entry.status),
    tool: entry.toolName,
  });
}

function matchesEntry(entry: ActivityEntry, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = normalizeLowercaseStringOrEmpty(
    [
      entry.toolName,
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

function renderStatusChip(props: ActivityProps, status: ActivityStatus) {
  return html`
    <label class="activity-status-filter activity-status-filter--${status}">
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
            <span class="activity-status activity-status--${entry.status}">
              ${statusLabel(entry.status)}
            </span>
            <span class="activity-entry__tool mono">${entry.toolName}</span>
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
          <span>${hiddenArgumentsLabel(entry.hiddenArgumentCount)}</span>
          <span class="mono">${t("activity.toolCallId")}: ${entry.toolCallId}</span>
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

  return html`
    <section class="activity-page" aria-label=${t("activity.title")}>
      <div class="activity-toolbar" aria-label=${t("activity.filtersLabel")}>
        <label class="activity-field activity-field--search">
          <span>${t("activity.search")}</span>
          <input
            type="search"
            .value=${props.filterText}
            placeholder=${t("activity.searchPlaceholder")}
            @input=${(event: Event) =>
              props.onFilterTextChange((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="activity-field">
          <span>${t("activity.toolFilter")}</span>
          <select
            .value=${props.toolFilter}
            @change=${(event: Event) =>
              props.onToolFilterChange((event.target as HTMLSelectElement).value)}
          >
            <option value="">${t("activity.allTools")}</option>
            ${toolNames.map((name) => html`<option value=${name}>${name}</option>`)}
          </select>
        </label>
        <div class="activity-status-filters" role="group" aria-label=${t("activity.statusFilters")}>
          ${STATUS_ORDER.map((status) => renderStatusChip(props, status))}
        </div>
        <label class="activity-autofollow">
          <input
            type="checkbox"
            .checked=${props.autoFollow}
            @change=${(event: Event) =>
              props.onToggleAutoFollow((event.target as HTMLInputElement).checked)}
          />
          <span>${t("activity.autoFollow")}</span>
        </label>
        <div class="activity-actions">
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
        <div class="activity-toolbar__count" aria-live="polite">
          ${t("activity.visibleCount", {
            visible: String(filtered.length),
            total: String(props.entries.length),
          })}
        </div>
      </div>

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
    </section>
  `;
}
