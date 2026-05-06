import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, parseSessionKeyParts } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import { normalizeThinkLevel } from "../thinking.ts";
import type {
  AgentIdentityResult,
  GatewaySessionRow,
  GatewayThinkingLevelOption,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../types.ts";
import { resolveAgentRuntimeLabel } from "./agents-utils.ts";

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  showArchived: boolean;
  filtersCollapsed: boolean;
  basePath: string;
  searchQuery: string;
  agentIdentityById: Record<string, AgentIdentityResult>;
  sortColumn: "key" | "kind" | "updated" | "tokens";
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
  selectedKeys: Set<string>;
  expandedCheckpointKey: string | null;
  checkpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  checkpointLoadingKey: string | null;
  checkpointBusyKey: string | null;
  checkpointErrorByKey: Record<string, string>;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
    showArchived: boolean;
  }) => void;
  onToggleFiltersCollapsed: () => void;
  onClearFilters: () => void;
  onSearchChange: (query: string) => void;
  onSortChange: (column: "key" | "kind" | "updated" | "tokens", dir: "asc" | "desc") => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRefresh: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      thinkingLevel?: string | null;
      fastMode?: boolean | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onToggleSelect: (key: string) => void;
  onSelectPage: (keys: string[]) => void;
  onDeselectPage: (keys: string[]) => void;
  onDeselectAll: () => void;
  onDeleteSelected: () => void;
  onNavigateToChat?: (sessionKey: string) => void;
  onToggleCheckpointDetails: (sessionKey: string) => void;
  onBranchFromCheckpoint: (sessionKey: string, checkpointId: string) => void | Promise<void>;
  onRestoreCheckpoint: (sessionKey: string, checkpointId: string) => void | Promise<void>;
};

const DEFAULT_THINK_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const VERBOSE_LEVEL_VALUES = ["", "off", "on", "full"] as const;
const FAST_LEVEL_VALUES = ["", "on", "off"] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;
const PAGE_SIZES = [10, 25, 50, 100] as const;

function getAgentIdentity(
  agentIdentityById: Record<string, AgentIdentityResult>,
  agentId: string,
): AgentIdentityResult | null {
  return Object.prototype.hasOwnProperty.call(agentIdentityById, agentId)
    ? (agentIdentityById[agentId] ?? null)
    : null;
}

function normalizeThinkingOptionValue(raw: string): string {
  return normalizeThinkLevel(raw) ?? normalizeLowercaseStringOrEmpty(raw);
}

function resolveThinkLevelOptions(
  row: GatewaySessionRow,
): readonly { value: string; label: string }[] {
  const defaultLabel = row.thinkingDefault
    ? t("sessionsView.defaultOption", { value: row.thinkingDefault })
    : t("sessionsView.inherit");
  const options: readonly GatewayThinkingLevelOption[] = row.thinkingLevels?.length
    ? row.thinkingLevels
    : (row.thinkingOptions?.length ? row.thinkingOptions : DEFAULT_THINK_LEVELS).map((label) => ({
        id: normalizeThinkingOptionValue(label),
        label,
      }));
  return [
    { value: "", label: defaultLabel },
    ...options.map((option) => ({
      value: normalizeThinkingOptionValue(option.id),
      label: option.label,
    })),
  ];
}

function withCurrentOption(options: readonly string[], current: string): string[] {
  if (!current) {
    return [...options];
  }
  if (options.includes(current)) {
    return [...options];
  }
  return [...options, current];
}

function withCurrentLabeledOption(
  options: readonly { value: string; label: string }[],
  current: string,
): Array<{ value: string; label: string }> {
  if (!current) {
    return [...options];
  }
  if (options.some((option) => option.value === current)) {
    return [...options];
  }
  return [
    ...options,
    { value: current, label: t("sessionsView.customOption", { value: current }) },
  ];
}

function buildVerboseLevelOptions(): Array<{ value: string; label: string }> {
  return VERBOSE_LEVEL_VALUES.map((value) => ({
    value,
    label:
      value === ""
        ? t("sessionsView.inherit")
        : value === "off"
          ? t("sessionsView.offExplicit")
          : t(`sessionsView.${value}`),
  }));
}

function buildFastLevelOptions(): Array<{ value: string; label: string }> {
  return FAST_LEVEL_VALUES.map((value) => ({
    value,
    label: value === "" ? t("sessionsView.inherit") : t(`sessionsView.${value}`),
  }));
}

function resolveThinkLevelPatchValue(value: string): string | null {
  if (!value) {
    return null;
  }
  return value;
}

function filterRows(
  rows: GatewaySessionRow[],
  query: string,
  agentIdentityById: Record<string, AgentIdentityResult>,
): GatewaySessionRow[] {
  const q = normalizeLowercaseStringOrEmpty(query);
  if (!q) {
    return rows;
  }
  return rows.filter((row) => {
    const key = normalizeLowercaseStringOrEmpty(row.key);
    const label = normalizeLowercaseStringOrEmpty(row.label);
    const kind = normalizeLowercaseStringOrEmpty(row.kind);
    const displayName = normalizeLowercaseStringOrEmpty(row.displayName);
    const runtime = normalizeLowercaseStringOrEmpty(resolveAgentRuntimeLabel(row.agentRuntime));
    if (
      key.includes(q) ||
      label.includes(q) ||
      kind.includes(q) ||
      displayName.includes(q) ||
      runtime.includes(q)
    ) {
      return true;
    }
    const keyParts = parseSessionKeyParts(row.key);
    const identityName = keyParts
      ? normalizeLowercaseStringOrEmpty(getAgentIdentity(agentIdentityById, keyParts.agentId)?.name)
      : "";
    return identityName.includes(q);
  });
}

function sortRows(
  rows: GatewaySessionRow[],
  column: "key" | "kind" | "updated" | "tokens",
  dir: "asc" | "desc",
): GatewaySessionRow[] {
  const cmp = dir === "asc" ? 1 : -1;
  return [...rows].toSorted((a, b) => {
    let diff = 0;
    switch (column) {
      case "key":
        diff = (a.key ?? "").localeCompare(b.key ?? "");
        break;
      case "kind":
        diff = (a.kind ?? "").localeCompare(b.kind ?? "");
        break;
      case "updated": {
        const au = a.updatedAt ?? 0;
        const bu = b.updatedAt ?? 0;
        diff = au - bu;
        break;
      }
      case "tokens": {
        const at = a.totalTokens ?? a.inputTokens ?? a.outputTokens ?? 0;
        const bt = b.totalTokens ?? b.inputTokens ?? b.outputTokens ?? 0;
        diff = at - bt;
        break;
      }
    }
    return diff * cmp;
  });
}

function paginateRows<T>(rows: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  return rows.slice(start, start + pageSize);
}

function hasPositiveNumberFilter(value: string): boolean {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0;
}

function hasActiveFilters(props: SessionsProps): boolean {
  return (
    normalizeLowercaseStringOrEmpty(props.searchQuery).length > 0 ||
    hasPositiveNumberFilter(props.activeMinutes) ||
    hasPositiveNumberFilter(props.limit) ||
    !props.includeGlobal ||
    !props.includeUnknown ||
    !props.showArchived
  );
}

function formatCheckpointReason(reason: SessionCompactionCheckpoint["reason"]): string {
  switch (reason) {
    case "manual":
      return t("sessionsView.manual");
    case "auto-threshold":
      return t("sessionsView.autoThreshold");
    case "overflow-retry":
      return t("sessionsView.overflowRetry");
    case "timeout-retry":
      return t("sessionsView.timeoutRetry");
    default:
      return reason;
  }
}

function formatCheckpointCount(count: number): string {
  return count === 1
    ? t("sessionsView.checkpoint", { count: String(count) })
    : t("sessionsView.checkpoints", { count: String(count) });
}

function formatCheckpointDelta(checkpoint: SessionCompactionCheckpoint): string {
  if (
    typeof checkpoint.tokensBefore === "number" &&
    typeof checkpoint.tokensAfter === "number" &&
    Number.isFinite(checkpoint.tokensBefore) &&
    Number.isFinite(checkpoint.tokensAfter)
  ) {
    return t("sessionsView.tokenRange", {
      before: checkpoint.tokensBefore.toLocaleString(),
      after: checkpoint.tokensAfter.toLocaleString(),
    });
  }
  if (typeof checkpoint.tokensBefore === "number" && Number.isFinite(checkpoint.tokensBefore)) {
    return t("sessionsView.tokensBefore", { count: checkpoint.tokensBefore.toLocaleString() });
  }
  return t("sessionsView.tokenDeltaUnavailable");
}

function formatRuntimeMs(runtimeMs: number | undefined): string | null {
  if (typeof runtimeMs !== "number" || !Number.isFinite(runtimeMs) || runtimeMs < 0) {
    return null;
  }
  const totalSeconds = Math.round(runtimeMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function sessionDetailItems(params: {
  row: GatewaySessionRow;
  updated: string;
  checkpointCount: number;
}): Array<{ label: string; value: string }> {
  const { row, updated, checkpointCount } = params;
  const details: Array<{ label: string; value: string }> = [
    { label: t("sessionsView.key"), value: row.key },
    { label: t("sessionsView.kind"), value: row.kind },
    { label: t("sessionsView.updated"), value: updated },
    { label: t("sessionsView.tokens"), value: formatSessionTokens(row) },
    { label: t("sessionsView.compaction"), value: formatCheckpointCount(checkpointCount) },
  ];
  const add = (label: string, value: string | null | undefined) => {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      details.push({ label, value: normalized });
    }
  };
  add(t("sessionsView.status"), row.status);
  add(t("sessionsView.model"), row.model);
  add(t("sessionsView.provider"), row.modelProvider);
  add(t("sessionsView.runtime"), formatRuntimeMs(row.runtimeMs));
  add(t("sessionsView.surface"), row.surface);
  add(t("sessionsView.subject"), row.subject);
  add(t("sessionsView.room"), row.room);
  add(t("sessionsView.space"), row.space);
  add(t("sessionsView.sessionId"), row.sessionId);
  if (typeof row.hasActiveRun === "boolean") {
    details.push({
      label: t("sessionsView.activeRun"),
      value: row.hasActiveRun ? t("common.yes") : t("common.no"),
    });
  }
  if (typeof row.archived === "boolean") {
    details.push({
      label: t("sessionsView.archived"),
      value: row.archived ? t("common.yes") : t("common.no"),
    });
  }
  return details;
}

function isRowControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("a, button, input, label, select, textarea"))
  );
}

function renderFilterToggle(params: {
  name: string;
  checked: boolean;
  label: string;
  title: string;
  extraClass?: string;
  onChange: (checked: boolean) => void;
}) {
  const className = [
    "session-filter-check",
    "session-filter-toggle",
    params.extraClass ?? "",
    params.checked ? "session-filter-check--active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <label class=${className} data-tooltip=${params.title}>
      <input
        name=${params.name}
        class="session-filter-check__input"
        type="checkbox"
        .checked=${params.checked}
        @change=${(e: Event) => params.onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="session-filter-check__mark" aria-hidden="true">${icons.check}</span>
      <span class="session-filter-check__label">${params.label}</span>
    </label>
  `;
}

export function renderSessions(props: SessionsProps) {
  const rawRows = props.result?.sessions ?? [];
  const filtered = filterRows(rawRows, props.searchQuery, props.agentIdentityById);
  const sorted = sortRows(filtered, props.sortColumn, props.sortDir);
  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / props.pageSize));
  const page = Math.min(props.page, totalPages - 1);
  const paginated = paginateRows(sorted, page, props.pageSize);
  const emptyBecauseFiltered =
    rawRows.length === 0 ? hasActiveFilters(props) : filtered.length === 0;
  const activeTooltip = t("sessionsView.activeTooltip", { count: props.activeMinutes.trim() });
  const limitTooltip = t("sessionsView.limitTooltip");
  const globalTooltip = t("sessionsView.globalTooltip");
  const unknownTooltip = t("sessionsView.unknownTooltip");
  const showArchivedTooltip = t("sessionsView.showArchivedTooltip");
  const filtersExpanded = !props.filtersCollapsed;
  const filterPanelTitle = t("sessionsView.filters");
  const filterToggleLabel = filtersExpanded
    ? t("sessionsView.hideFilters")
    : t("sessionsView.showFilters");

  const sortHeader = (
    col: "key" | "kind" | "updated" | "tokens",
    label: string,
    extraClass = "",
  ) => {
    const isActive = props.sortColumn === col;
    const nextDir = isActive && props.sortDir === "asc" ? ("desc" as const) : ("asc" as const);
    return html`
      <th
        class=${extraClass}
        data-sortable
        data-sort-dir=${isActive ? props.sortDir : ""}
        @click=${() => props.onSortChange(col, isActive ? nextDir : "desc")}
      >
        ${label}
        <span class="data-table-sort-icon">${icons.arrowUpDown}</span>
      </th>
    `;
  };

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">${t("sessionsView.title")}</div>
          <div class="card-sub">
            ${props.result
              ? t("sessionsView.store", { path: props.result.path })
              : t("sessionsView.subtitle")}
          </div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>

      <div class="sessions-filter-panel">
        <div class="sessions-filter-panel__header">
          <div class="sessions-filter-panel__title">${filterPanelTitle}</div>
          <button
            class="sessions-filter-panel__toggle"
            type="button"
            aria-expanded=${String(filtersExpanded)}
            aria-controls="sessions-filter-bar"
            @click=${props.onToggleFiltersCollapsed}
          >
            ${filtersExpanded ? icons.chevronDown : icons.chevronRight}
            <span>${filterToggleLabel}</span>
          </button>
        </div>

        ${filtersExpanded
          ? html`
              <div
                id="sessions-filter-bar"
                class="sessions-filter-bar"
                aria-label="Session filters"
              >
                <div class="session-filter-primary-row">
                  <label class="session-filter-field" data-tooltip=${activeTooltip}>
                    <span class="session-filter-label">${t("sessionsView.active")}</span>
                    <input
                      class="session-filter-input session-filter-input--minutes"
                      placeholder=${t("sessionsView.minutesPlaceholder")}
                      .value=${props.activeMinutes}
                      ?disabled=${props.showArchived}
                      @input=${(e: Event) =>
                        props.onFiltersChange({
                          activeMinutes: (e.target as HTMLInputElement).value,
                          limit: props.limit,
                          includeGlobal: props.includeGlobal,
                          includeUnknown: props.includeUnknown,
                          showArchived: props.showArchived,
                        })}
                    />
                  </label>
                  <label class="session-filter-field" data-tooltip=${limitTooltip}>
                    <span class="session-filter-label">${t("sessionsView.limit")}</span>
                    <input
                      class="session-filter-input session-filter-input--limit"
                      .value=${props.limit}
                      @input=${(e: Event) =>
                        props.onFiltersChange({
                          activeMinutes: props.activeMinutes,
                          limit: (e.target as HTMLInputElement).value,
                          includeGlobal: props.includeGlobal,
                          includeUnknown: props.includeUnknown,
                          showArchived: props.showArchived,
                        })}
                    />
                  </label>
                </div>
                <div
                  class="session-filter-toggle-group"
                  role="group"
                  aria-label=${t("sessionsView.sourceFilters")}
                >
                  ${renderFilterToggle({
                    name: "includeGlobal",
                    checked: props.includeGlobal,
                    label: t("sessionsView.global"),
                    title: globalTooltip,
                    onChange: (checked) =>
                      props.onFiltersChange({
                        activeMinutes: props.activeMinutes,
                        limit: props.limit,
                        includeGlobal: checked,
                        includeUnknown: props.includeUnknown,
                        showArchived: props.showArchived,
                      }),
                  })}
                  ${renderFilterToggle({
                    name: "includeUnknown",
                    checked: props.includeUnknown,
                    label: t("sessionsView.unknown"),
                    title: unknownTooltip,
                    onChange: (checked) =>
                      props.onFiltersChange({
                        activeMinutes: props.activeMinutes,
                        limit: props.limit,
                        includeGlobal: props.includeGlobal,
                        includeUnknown: checked,
                        showArchived: props.showArchived,
                      }),
                  })}
                  ${renderFilterToggle({
                    name: "showArchived",
                    checked: props.showArchived,
                    label: t("sessionsView.showArchived"),
                    title: showArchivedTooltip,
                    extraClass: "session-archive-toggle",
                    onChange: (checked) =>
                      props.onFiltersChange({
                        activeMinutes: props.activeMinutes,
                        limit: props.limit,
                        includeGlobal: props.includeGlobal,
                        includeUnknown: props.includeUnknown,
                        showArchived: checked,
                      }),
                  })}
                </div>
              </div>
            `
          : nothing}
      </div>

      ${props.error
        ? html`<div class="callout danger" style="margin-bottom: 12px;">${props.error}</div>`
        : nothing}

      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              placeholder=${t("sessionsView.searchPlaceholder")}
              .value=${props.searchQuery}
              @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        ${props.selectedKeys.size > 0
          ? html`
              <div class="data-table-bulk-bar">
                <span
                  >${t("sessionsView.selected", { count: String(props.selectedKeys.size) })}</span
                >
                <button class="btn btn--sm" @click=${props.onDeselectAll}>
                  ${t("common.unselect")}
                </button>
                <button
                  class="btn btn--sm danger"
                  ?disabled=${props.loading}
                  @click=${props.onDeleteSelected}
                >
                  ${icons.trash} ${t("sessionsView.deleteSelected")}
                </button>
              </div>
            `
          : nothing}

        <div class="data-table-container">
          <table class="data-table sessions-table">
            <thead>
              <tr>
                <th class="data-table-checkbox-col">
                  ${paginated.length > 0
                    ? html`<input
                        type="checkbox"
                        .checked=${paginated.length > 0 &&
                        paginated.every((r) => props.selectedKeys.has(r.key))}
                        .indeterminate=${paginated.some((r) => props.selectedKeys.has(r.key)) &&
                        !paginated.every((r) => props.selectedKeys.has(r.key))}
                        @change=${() => {
                          const allSelected = paginated.every((r) => props.selectedKeys.has(r.key));
                          if (allSelected) {
                            props.onDeselectPage(paginated.map((r) => r.key));
                          } else {
                            props.onSelectPage(paginated.map((r) => r.key));
                          }
                        }}
                        aria-label=${t("sessionsView.selectAllOnPage")}
                      />`
                    : nothing}
                </th>
                ${sortHeader("key", t("sessionsView.key"), "data-table-key-col")}
                <th>${t("sessionsView.label")}</th>
                ${sortHeader("kind", t("sessionsView.kind"))}
                <th>${t("agents.context.runtime")}</th>
                ${sortHeader("updated", t("sessionsView.updated"))}
                ${sortHeader("tokens", t("sessionsView.tokens"))}
                <th class="session-compaction-col">${t("sessionsView.compaction")}</th>
                <th>${t("sessionsView.thinking")}</th>
                <th>${t("sessionsView.fast")}</th>
                <th>${t("sessionsView.verbose")}</th>
                <th>${t("sessionsView.reasoning")}</th>
              </tr>
            </thead>
            <tbody>
              ${paginated.length === 0
                ? html`
                    <tr>
                      <td colspan="12" class="data-table-empty-cell">
                        ${emptyBecauseFiltered
                          ? html`
                              <div class="data-table-empty-state" role="status" aria-live="polite">
                                <div>${t("sessionsView.noSessionsMatchFilters")}</div>
                                <button class="btn btn--sm" @click=${props.onClearFilters}>
                                  ${t("sessionsView.showAll")}
                                </button>
                              </div>
                            `
                          : t("sessionsView.noSessions")}
                      </td>
                    </tr>
                  `
                : paginated.flatMap((row) => renderRows(row, props))}
            </tbody>
          </table>
        </div>

        ${totalRows > 0
          ? html`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${page * props.pageSize + 1}-${Math.min((page + 1) * props.pageSize, totalRows)}
                  of ${totalRows} row${totalRows === 1 ? "" : "s"}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(props.pageSize)}
                    @change=${(e: Event) =>
                      props.onPageSizeChange(Number((e.target as HTMLSelectElement).value))}
                  >
                    ${PAGE_SIZES.map((s) => html`<option value=${s}>${s} per page</option>`)}
                  </select>
                  <button ?disabled=${page <= 0} @click=${() => props.onPageChange(page - 1)}>
                    Previous
                  </button>
                  <button
                    ?disabled=${page >= totalPages - 1}
                    @click=${() => props.onPageChange(page + 1)}
                  >
                    ${t("common.next")}
                  </button>
                </div>
              </div>
            `
          : nothing}
      </div>
    </section>
  `;
}

function renderRows(row: GatewaySessionRow, props: SessionsProps) {
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : t("common.na");
  const rawThinking = row.thinkingLevel ?? "";
  const thinking = rawThinking ? normalizeThinkingOptionValue(rawThinking) : "";
  const thinkLevels = withCurrentLabeledOption(resolveThinkLevelOptions(row), thinking);
  const fastMode = row.fastMode === true ? "on" : row.fastMode === false ? "off" : "";
  const fastLevels = withCurrentLabeledOption(buildFastLevelOptions(), fastMode);
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentLabeledOption(buildVerboseLevelOptions(), verbose);
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentOption(REASONING_LEVELS, reasoning);
  const latestCheckpoint = row.latestCompactionCheckpoint;
  const checkpointCount = row.compactionCheckpointCount ?? 0;
  const visibleCheckpointCount = Math.max(checkpointCount, latestCheckpoint ? 1 : 0);
  const hasCheckpoints = checkpointCount > 0 || Boolean(latestCheckpoint);
  const isExpanded = props.expandedCheckpointKey === row.key;
  const checkpointItems = props.checkpointItemsByKey[row.key] ?? [];
  const checkpointError = props.checkpointErrorByKey[row.key];
  const detailsId = `session-checkpoints-${encodeURIComponent(row.key)}`;
  const checkpointLabel = formatCheckpointCount(visibleCheckpointCount);
  const sessionDetails = sessionDetailItems({
    row,
    updated,
    checkpointCount: visibleCheckpointCount,
  });
  const displayName = normalizeOptionalString(row.displayName) ?? null;
  const trimmedLabel = normalizeOptionalString(row.label) ?? "";
  const showDisplayName = Boolean(
    displayName && displayName !== row.key && displayName !== trimmedLabel,
  );
  const keyParts = parseSessionKeyParts(row.key);
  const agentIdentity = keyParts
    ? getAgentIdentity(props.agentIdentityById, keyParts.agentId)
    : null;
  const identityEmoji = normalizeOptionalString(agentIdentity?.emoji) ?? "";
  const identityName = normalizeOptionalString(agentIdentity?.name) ?? "";
  const friendlyKeyLabel =
    identityName && keyParts
      ? `${identityEmoji ? `${identityEmoji} ` : ""}${identityName} (${keyParts.channel})`
      : null;
  const keyCellTitle = friendlyKeyLabel ?? row.key;
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? `${pathForTab("chat", props.basePath)}?session=${encodeURIComponent(row.key)}`
    : null;
  const badgeClass =
    row.kind === "cron"
      ? "data-table-badge--cron"
      : row.kind === "direct"
        ? "data-table-badge--direct"
        : row.kind === "group"
          ? "data-table-badge--group"
          : row.kind === "global"
            ? "data-table-badge--global"
            : "data-table-badge--unknown";
  const rowClass = [
    "session-data-row",
    hasCheckpoints ? "session-data-row--expandable" : "",
    isExpanded ? "session-data-row--expanded" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const activateCheckpointDetails = () => {
    if (hasCheckpoints) {
      props.onToggleCheckpointDetails(row.key);
    }
  };

  return [
    html`<tr
      class=${rowClass}
      tabindex=${hasCheckpoints ? "0" : nothing}
      aria-expanded=${hasCheckpoints ? String(isExpanded) : nothing}
      aria-controls=${hasCheckpoints ? detailsId : nothing}
      @click=${(e: MouseEvent) => {
        if (!hasCheckpoints || isRowControlTarget(e.target)) {
          return;
        }
        activateCheckpointDetails();
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (!hasCheckpoints || isRowControlTarget(e.target)) {
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activateCheckpointDetails();
        }
      }}
    >
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${props.selectedKeys.has(row.key)}
          @change=${() => props.onToggleSelect(row.key)}
          aria-label=${t("sessionsView.selectSession")}
        />
      </td>
      <td class="data-table-key-col">
        <div
          class=${friendlyKeyLabel ? "session-key-cell" : "mono session-key-cell"}
          title=${keyCellTitle}
        >
          ${canLink
            ? html`<a
                href=${chatUrl}
                class="session-link"
                @click=${(e: MouseEvent) => {
                  if (
                    e.defaultPrevented ||
                    e.button !== 0 ||
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey
                  ) {
                    return;
                  }
                  if (props.onNavigateToChat) {
                    e.preventDefault();
                    props.onNavigateToChat(row.key);
                  }
                }}
                >${friendlyKeyLabel ?? row.key}</a
              >`
            : (friendlyKeyLabel ?? row.key)}
          ${showDisplayName
            ? html`<span class="muted session-key-display-name">${displayName}</span>`
            : nothing}
        </div>
      </td>
      <td>
        <input
          .value=${row.label ?? ""}
          ?disabled=${props.loading}
          placeholder=${t("sessionsView.optionalPlaceholder")}
          style="width: 100%; max-width: 140px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm);"
          @change=${(e: Event) => {
            const value = normalizeOptionalString((e.target as HTMLInputElement).value) ?? null;
            props.onPatch(row.key, { label: value });
          }}
        />
      </td>
      <td>
        <span class="data-table-badge ${badgeClass}">${row.kind}</span>
      </td>
      <td class="session-runtime-cell">
        <span class="mono">${resolveAgentRuntimeLabel(row.agentRuntime)}</span>
      </td>
      <td>${updated}</td>
      <td class="session-token-cell">${formatSessionTokens(row)}</td>
      <td class="session-compaction-col">
        <div class="session-compaction-cell">
          ${hasCheckpoints
            ? html`
                <button
                  class="session-compaction-trigger"
                  type="button"
                  aria-expanded=${String(isExpanded)}
                  aria-controls=${detailsId}
                  aria-label=${isExpanded
                    ? t("sessionsView.hideSessionDetails", { count: checkpointLabel })
                    : t("sessionsView.showSessionDetails", { count: checkpointLabel })}
                  @click=${(e: MouseEvent) => {
                    e.stopPropagation();
                    activateCheckpointDetails();
                  }}
                >
                  <span class="session-compaction-count">${checkpointLabel}</span>
                </button>
              `
            : html`<span class="muted session-compaction-count">${t("common.none")}</span>`}
        </div>
      </td>
      <td>
        <select
          ?disabled=${props.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            props.onPatch(row.key, {
              thinkingLevel: resolveThinkLevelPatchValue(value),
            });
          }}
        >
          ${thinkLevels.map(
            (level) =>
              html`<option value=${level.value} ?selected=${thinking === level.value}>
                ${level.label}
              </option>`,
          )}
        </select>
      </td>
      <td>
        <select
          ?disabled=${props.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            props.onPatch(row.key, { fastMode: value === "" ? null : value === "on" });
          }}
        >
          ${fastLevels.map(
            (level) =>
              html`<option value=${level.value} ?selected=${fastMode === level.value}>
                ${level.label}
              </option>`,
          )}
        </select>
      </td>
      <td>
        <select
          ?disabled=${props.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            props.onPatch(row.key, { verboseLevel: value || null });
          }}
        >
          ${verboseLevels.map(
            (level) =>
              html`<option value=${level.value} ?selected=${verbose === level.value}>
                ${level.label}
              </option>`,
          )}
        </select>
      </td>
      <td>
        <select
          ?disabled=${props.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            props.onPatch(row.key, { reasoningLevel: value || null });
          }}
        >
          ${reasoningLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${reasoning === level}>
                ${level || t("sessionsView.inherit")}
              </option>`,
          )}
        </select>
      </td>
    </tr>`,
    ...(isExpanded && hasCheckpoints
      ? [
          html`<tr id=${detailsId} class="session-checkpoint-details-row">
            <td colspan="12">
              <div class="session-details-panel">
                <div class="session-details-panel__hero">
                  <div>
                    <div class="session-details-panel__eyebrow">
                      ${t("sessionsView.sessionDetails")}
                    </div>
                    <div class="session-details-panel__title">${friendlyKeyLabel ?? row.key}</div>
                    ${showDisplayName
                      ? html`
                          <div class="muted session-details-panel__subtitle">${displayName}</div>
                        `
                      : nothing}
                  </div>
                  <span class="data-table-badge ${badgeClass}">${row.kind}</span>
                </div>

                <div class="session-details-grid">
                  ${sessionDetails.map(
                    (item) => html`
                      <div class="session-detail-stat">
                        <div class="session-detail-stat__label">${item.label}</div>
                        <div class="session-detail-stat__value" title=${item.value}>
                          ${item.value}
                        </div>
                      </div>
                    `,
                  )}
                </div>

                <div class="session-details-section">
                  <div class="session-details-section__header">
                    <div>
                      <div class="session-details-panel__eyebrow">
                        ${t("sessionsView.compactionHistory")}
                      </div>
                      <div class="session-details-section__title">${checkpointLabel}</div>
                    </div>
                  </div>
                  ${props.checkpointLoadingKey === row.key
                    ? html`<div class="muted session-details-empty">
                        ${t("sessionsView.loadingCheckpoints")}
                      </div>`
                    : checkpointError
                      ? html`<div class="callout danger">${checkpointError}</div>`
                      : checkpointItems.length === 0
                        ? html`<div class="muted session-details-empty">
                            ${t("sessionsView.noCheckpoints")}
                          </div>`
                        : html`
                            <div class="session-checkpoint-list">
                              ${checkpointItems.map(
                                (checkpoint) => html`
                                  <div class="session-checkpoint-card">
                                    <div class="session-checkpoint-card__header">
                                      <strong>
                                        ${formatCheckpointReason(checkpoint.reason)} ·
                                        ${formatRelativeTimestamp(checkpoint.createdAt)}
                                      </strong>
                                      <span class="muted session-checkpoint-card__delta">
                                        ${formatCheckpointDelta(checkpoint)}
                                      </span>
                                    </div>
                                    ${checkpoint.summary
                                      ? html`<div class="session-checkpoint-card__summary">
                                          ${checkpoint.summary}
                                        </div>`
                                      : html`
                                          <div class="muted">${t("sessionsView.noSummary")}</div>
                                        `}
                                    <div class="session-checkpoint-card__actions">
                                      <button
                                        class="btn btn--sm"
                                        ?disabled=${props.checkpointBusyKey ===
                                        checkpoint.checkpointId}
                                        @click=${() =>
                                          props.onBranchFromCheckpoint(
                                            row.key,
                                            checkpoint.checkpointId,
                                          )}
                                      >
                                        ${t("sessionsView.branchFromCheckpoint")}
                                      </button>
                                      <button
                                        class="btn btn--sm"
                                        ?disabled=${props.checkpointBusyKey ===
                                        checkpoint.checkpointId}
                                        @click=${() =>
                                          props.onRestoreCheckpoint(
                                            row.key,
                                            checkpoint.checkpointId,
                                          )}
                                      >
                                        ${t("sessionsView.restoreCheckpoint")}
                                      </button>
                                    </div>
                                  </div>
                                `,
                              )}
                            </div>
                          `}
                </div>
              </div>
            </td>
          </tr>`,
        ]
      : []),
  ];
}
