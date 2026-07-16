// Control UI view renders sessions screen content.
import { html, nothing } from "lit";
import type { SessionsSearchHit } from "../../../../packages/gateway-protocol/src/index.js";
import type {
  AgentIdentityResult,
  GatewaySessionRow,
  SessionRunStatus,
  GatewayThinkingLevelOption,
  FastMode,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import "../../styles/sessions.css";
import { pathForRoute } from "../../app-route-paths.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentRuntimeLabel } from "../../lib/agents/display.ts";
import {
  formatInheritedThinkingLabel,
  formatThinkingOverrideLabel,
  normalizeThinkingOptionValue,
} from "../../lib/chat/thinking.ts";
import {
  formatDurationCompact,
  formatMs,
  formatRelativeTimestamp,
  formatTokens,
  parseSessionKeyParts,
} from "../../lib/format.ts";
import { formatSessionTokens } from "../../lib/presenter.ts";
import { formatGoalDetail, formatGoalSummary } from "../../lib/session-goal.ts";
import { sessionModelMatchesDefaults } from "../../lib/session-model-defaults.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import {
  groupSessionRows,
  SESSION_GROUP_MODES,
  type SessionRowGroup,
  type SessionsGroupBy,
  UNGROUPED_ID,
} from "../../lib/sessions/grouping.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../lib/string-coerce.ts";
import { parseFilterInteger } from "./page-state.ts";

export type TranscriptSearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "results";
      results: SessionsSearchHit[];
      indexing: boolean;
      truncated: boolean;
    };

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  showArchived: boolean;
  basePath: string;
  searchQuery: string;
  transcriptSearchAvailable: boolean;
  transcriptSearchQuery: string;
  transcriptSearch: TranscriptSearchState;
  agentIdentityById: Record<string, AgentIdentityResult>;
  sortColumn: "key" | "kind" | "updated" | "tokens";
  sortDir: "asc" | "desc";
  groupBy: SessionsGroupBy;
  knownCategories: string[];
  page: number;
  pageSize: number;
  selectedKeys: Set<string>;
  sessionMenu: { key: string } | null;
  expandedSessionKey: string | null;
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
  onClearFilters: () => void;
  onSearchChange: (query: string) => void;
  onTranscriptSearchChange: (query: string) => void;
  onTranscriptSearch: () => void;
  onClearTranscriptSearch: () => void;
  onSortChange: (column: "key" | "kind" | "updated" | "tokens", dir: "asc" | "desc") => void;
  onGroupByChange: (mode: SessionsGroupBy) => void;
  onAssignCategory: (key: string, category: string | null) => void;
  onRequestNewCategory: (sessionKey?: string) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRefresh: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      category?: string | null;
      archived?: boolean;
      pinned?: boolean;
      unread?: boolean;
      thinkingLevel?: string | null;
      fastMode?: FastMode | null;
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
  onOpenSessionMenu: (
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) => void;
  onToggleDetails: (sessionKey: string) => void;
  onBranchFromCheckpoint: (sessionKey: string, checkpointId: string) => void | Promise<void>;
  onRestoreCheckpoint: (sessionKey: string, checkpointId: string) => void | Promise<void>;
};

const DEFAULT_THINK_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const VERBOSE_LEVEL_VALUES = ["", "off", "on", "full"] as const;
const FAST_LEVEL_VALUES = ["", "auto", "on", "off"] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;
const PAGE_SIZES = [10, 25, 50, 100] as const;

function getAgentIdentity(
  agentIdentityById: Record<string, AgentIdentityResult>,
  agentId: string,
): AgentIdentityResult | null {
  return Object.hasOwn(agentIdentityById, agentId) ? (agentIdentityById[agentId] ?? null) : null;
}

function resolveThinkLevelOptions(
  row: GatewaySessionRow,
  defaults?: SessionsListResult["defaults"],
): readonly { value: string; label: string }[] {
  const modelMatchesDefaults = sessionModelMatchesDefaults(row, defaults);
  const defaultLabel = formatInheritedThinkingLabel(
    row.thinkingDefault ?? (modelMatchesDefaults ? defaults?.thinkingDefault : undefined),
  );
  const options: readonly GatewayThinkingLevelOption[] = row.thinkingLevels?.length
    ? row.thinkingLevels
    : modelMatchesDefaults && defaults?.thinkingLevels?.length
      ? defaults.thinkingLevels
      : (row.thinkingOptions?.length
          ? row.thinkingOptions
          : modelMatchesDefaults && defaults?.thinkingOptions?.length
            ? defaults.thinkingOptions
            : DEFAULT_THINK_LEVELS
        ).map((label) => ({
          id: normalizeThinkingOptionValue(label),
          label,
        }));
  return [
    { value: "", label: defaultLabel },
    ...options.map((option) => ({
      value: normalizeThinkingOptionValue(option.id),
      label: formatThinkingOverrideLabel(option.id, option.label),
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
  return [...options, { value: current, label: formatThinkingOverrideLabel(current) }];
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

function formatSessionRunStatus(status: SessionRunStatus): string {
  switch (status) {
    case "running":
      return t("sessionsView.statusRunning");
    case "done":
      return t("sessionsView.statusDone");
    case "failed":
      return t("sessionsView.statusFailed");
    case "killed":
      return t("sessionsView.statusKilled");
    case "timeout":
      return t("sessionsView.statusTimeout");
    default:
      return t("sessionsView.statusUnknown");
  }
}

function resolveSessionStatusBadge(row: GatewaySessionRow): {
  label: string;
  tone: "live" | "idle" | "done" | "failed" | "muted";
} {
  if (isSessionRunActive(row)) {
    return { label: t("sessionsView.statusLive"), tone: "live" };
  }
  if (row.status === "running" && row.hasActiveRun === false) {
    return { label: t("sessionsView.statusIdle"), tone: "idle" };
  }
  if (row.status) {
    const tone = row.status === "done" ? "done" : ("failed" as const);
    return { label: formatSessionRunStatus(row.status), tone };
  }
  if (row.hasActiveRun === false) {
    return { label: t("sessionsView.statusIdle"), tone: "idle" };
  }
  return { label: t("sessionsView.statusUnknown"), tone: "muted" };
}

const SESSION_STATUS_TONE_KIND = {
  live: "ok",
  idle: "muted",
  done: "ok",
  failed: "danger",
  muted: "muted",
} as const;

function renderSessionStatusBadge(row: GatewaySessionRow) {
  const badge = resolveSessionStatusBadge(row);
  const title = `${t("sessionsView.status")}: ${badge.label}`;
  return html`
    <openclaw-tooltip .content=${title}>
      ${renderSettingsStatus({ kind: SESSION_STATUS_TONE_KIND[badge.tone], label: badge.label })}
    </openclaw-tooltip>
  `;
}

const SESSION_KIND_ICONS = {
  cron: icons.clock,
  direct: icons.messageSquare,
  group: icons.users,
  global: icons.globe,
  unknown: icons.circle,
} satisfies Record<GatewaySessionRow["kind"], unknown>;

// Kind glyph anchors each row; the dot mirrors isSessionRunActive so run
// state also reads at the identity anchor while scanning the key column.
function renderSessionAvatar(row: GatewaySessionRow) {
  return html`
    <span class="session-avatar session-avatar--${row.kind}" aria-hidden="true">
      ${SESSION_KIND_ICONS[row.kind] ?? icons.circle}
      ${isSessionRunActive(row) ? html`<span class="session-avatar__status"></span>` : nothing}
    </span>
  `;
}

const CONTEXT_METER_WARN_PERCENT = 65;
const CONTEXT_METER_DANGER_PERCENT = 85;

function hasKnownTokenTotal(row: GatewaySessionRow): boolean {
  return typeof row.totalTokens === "number" && Number.isFinite(row.totalTokens);
}

function renderTokensCell(row: GatewaySessionRow) {
  const total = row.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    return html`<span class="muted">${t("common.na")}</span>`;
  }
  // Stale snapshots (post-compaction, incomplete usage reporting) stay visible
  // as "~" orientation but must not drive warn/danger tones; mirrors the chat
  // composer's context-usage convention.
  const fresh = row.totalTokensFresh !== false;
  const totalLabel = `${fresh ? "" : "~"}${formatTokens(total)}`;
  const context =
    typeof row.contextTokens === "number" && row.contextTokens > 0 ? row.contextTokens : null;
  if (!context) {
    return html`<span class="session-tokens__value">${totalLabel}</span>`;
  }
  const percent = Math.min(100, Math.round((total / context) * 100));
  const tone = !fresh
    ? "stale"
    : percent >= CONTEXT_METER_DANGER_PERCENT
      ? "danger"
      : percent >= CONTEXT_METER_WARN_PERCENT
        ? "warn"
        : "ok";
  const title = t(fresh ? "sessionsView.contextUsage" : "sessionsView.contextUsageApprox", {
    percent: String(percent),
    used: total.toLocaleString(),
    context: context.toLocaleString(),
  });
  return html`
    <openclaw-tooltip .content=${title}>
      <div class="session-tokens">
        <span class="session-tokens__value">${totalLabel} / ${formatTokens(context)}</span>
        <span
          class="session-context-meter session-context-meter--${tone}"
          role="img"
          aria-label=${title}
        >
          <span class="session-context-meter__fill" style=${`width: ${percent}%`}></span>
        </span>
      </div>
    </openclaw-tooltip>
  `;
}

function renderSessionsOverview(rows: GatewaySessionRow[], liveCount: number) {
  const unreadCount = rows.filter((row) => row.unread === true).length;
  // Sum only known token totals; "~" marks the sum as partial/approximate when
  // rows lack a snapshot or carry a stale one, and no snapshot at all is n/a
  // rather than a fabricated 0.
  const rowsWithTokens = rows.filter(hasKnownTokenTotal);
  const totalTokens = rowsWithTokens.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0);
  const tokensApproximate =
    rowsWithTokens.length < rows.length ||
    rowsWithTokens.some((row) => row.totalTokensFresh === false);
  const tokensValue =
    rowsWithTokens.length === 0
      ? t("common.na")
      : `${tokensApproximate ? "~" : ""}${formatTokens(totalTokens)}`;
  const tiles = [
    {
      id: "sessions",
      icon: icons.messageSquare,
      label: t("sessionsView.title"),
      value: String(rows.length),
      active: false,
    },
    {
      id: "live",
      icon: icons.zap,
      label: t("sessionsView.statusLive"),
      value: String(liveCount),
      active: liveCount > 0,
    },
    {
      id: "unread",
      icon: icons.eye,
      label: t("sessionsView.unread"),
      value: String(unreadCount),
      active: unreadCount > 0,
    },
    {
      id: "tokens",
      icon: icons.barChart,
      label: t("sessionsView.tokens"),
      value: tokensValue,
      active: false,
    },
  ];
  return html`
    <div class="sessions-overview">
      ${tiles.map((tile) => {
        const tileClass = [
          "sessions-overview__tile",
          `sessions-overview__tile--${tile.id}`,
          tile.active ? "sessions-overview__tile--active" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return html`
          <div class=${tileClass}>
            <span class="sessions-overview__icon" aria-hidden="true">${tile.icon}</span>
            <span class="sessions-overview__meta">
              <span class="sessions-overview__value">${tile.value}</span>
              <span class="sessions-overview__label">${tile.label}</span>
            </span>
          </div>
        `;
      })}
    </div>
  `;
}

function transcriptSearchSessionLabel(hit: SessionsSearchHit, rows: GatewaySessionRow[]): string {
  const row = rows.find((candidate) => candidate.key === hit.sessionKey);
  return (
    normalizeOptionalString(row?.label) ??
    normalizeOptionalString(row?.displayName) ??
    hit.sessionKey
  );
}

function renderTranscriptSearch(props: SessionsProps, rows: GatewaySessionRow[]) {
  const hasQuery = props.transcriptSearchQuery.trim().length > 0;
  const state = props.transcriptSearch;
  const results = state.status === "results" ? state.results : [];
  const loading = state.status === "loading";
  return html`
    <section
      class="sessions-transcript-search"
      aria-label=${t("sessionsView.transcriptSearchTitle")}
    >
      <form
        class="sessions-transcript-search__form"
        role="search"
        aria-label=${t("sessionsView.transcriptSearchTitle")}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          if (props.transcriptSearchAvailable && hasQuery && !loading) {
            props.onTranscriptSearch();
          }
        }}
      >
        <div class="data-table-search sessions-transcript-search__input">
          <input
            type="search"
            maxlength="4096"
            aria-label=${t("sessionsView.transcriptSearchInputLabel")}
            placeholder=${t("sessionsView.transcriptSearchPlaceholder")}
            .value=${props.transcriptSearchQuery}
            ?disabled=${!props.transcriptSearchAvailable}
            @input=${(event: Event) =>
              props.onTranscriptSearchChange((event.target as HTMLInputElement).value)}
          />
        </div>
        <button
          class="btn primary"
          type="submit"
          ?disabled=${!props.transcriptSearchAvailable || !hasQuery || loading}
        >
          ${loading
            ? t("sessionsView.transcriptSearchSearching")
            : t("sessionsView.transcriptSearchAction")}
        </button>
        ${hasQuery
          ? html`
              <button class="btn" type="button" @click=${props.onClearTranscriptSearch}>
                ${t("sessionsView.transcriptSearchClear")}
              </button>
            `
          : nothing}
      </form>
      ${!props.transcriptSearchAvailable
        ? html`
            <div class="muted" role="status">${t("sessionsView.transcriptSearchUnavailable")}</div>
          `
        : nothing}
      <div
        class="sessions-transcript-search__status"
        aria-live="polite"
        aria-busy=${loading ? "true" : "false"}
      >
        ${loading
          ? html`<span class="muted">${t("sessionsView.transcriptSearchSearching")}</span>`
          : nothing}
        ${state.status === "error"
          ? html`
              <div
                class="sessions-transcript-search__notice sessions-transcript-search__notice--danger"
              >
                <span>${t("sessionsView.transcriptSearchError")}: ${state.message}</span>
                <button class="btn btn--sm" type="button" @click=${props.onTranscriptSearch}>
                  ${t("sessionsView.transcriptSearchRetry")}
                </button>
              </div>
            `
          : nothing}
        ${state.status === "results" && state.indexing
          ? html`
              <div class="sessions-transcript-search__notice">
                <span>${t("sessionsView.transcriptSearchIndexing")}</span>
                <button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${loading}
                  @click=${props.onTranscriptSearch}
                >
                  ${t("sessionsView.transcriptSearchRetry")}
                </button>
              </div>
            `
          : nothing}
        ${state.status === "results" && results.length === 0 && !state.indexing
          ? html`
              <div class="sessions-transcript-search__empty" role="status">
                ${t("sessionsView.transcriptSearchEmpty")}
              </div>
            `
          : nothing}
        ${results.length > 0
          ? html`
              <div class="sessions-transcript-search__results">
                <div class="sessions-transcript-search__summary">
                  <strong
                    >${t("sessionsView.transcriptSearchMatches", {
                      count: String(results.length),
                    })}</strong
                  >
                  ${state.status === "results" && state.truncated
                    ? html`<span class="muted"
                        >${t("sessionsView.transcriptSearchTruncated")}</span
                      >`
                    : nothing}
                </div>
                <div class="sessions-transcript-search__list">
                  ${results.map((hit) => {
                    const timestamp =
                      hit.timestamp > 0 ? formatRelativeTimestamp(hit.timestamp) : t("common.na");
                    const timestampTitle = hit.timestamp > 0 ? formatMs(hit.timestamp) : timestamp;
                    return html`
                      <button
                        class="sessions-transcript-search__result"
                        type="button"
                        @click=${() => props.onNavigateToChat?.(hit.sessionKey)}
                      >
                        <span class="sessions-transcript-search__result-header">
                          <strong>${transcriptSearchSessionLabel(hit, rows)}</strong>
                          <span class="muted" title=${timestampTitle}>
                            ${t(`sessionsView.${hit.role}`)} · ${timestamp}
                          </span>
                        </span>
                        <span class="sessions-transcript-search__snippet">${hit.snippet}</span>
                        <span class="sessions-transcript-search__key">${hit.sessionKey}</span>
                      </button>
                    `;
                  })}
                </div>
              </div>
            `
          : nothing}
      </div>
    </section>
  `;
}

const SKELETON_ROW_COUNT = 4;

// Initial load renders shimmer rows instead of flashing the empty state
// before the first sessions.list result arrives.
function renderSkeletonRows(columnCount: number) {
  return Array.from(
    { length: SKELETON_ROW_COUNT },
    (_, rowIndex) => html`
      <tr class="session-skeleton-row" aria-hidden="true">
        ${Array.from({ length: columnCount }, (_cell, columnIndex) =>
          columnIndex === 0
            ? html`<td class="data-table-checkbox-col"></td>`
            : html`<td>
                <span
                  class="session-skeleton ${columnIndex === 1 ? "session-skeleton--key" : ""}"
                  style=${`animation-delay: ${rowIndex * 120}ms`}
                ></span>
              </td>`,
        )}
      </tr>
    `,
  );
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
    const category = normalizeLowercaseStringOrEmpty(row.category);
    const kind = normalizeLowercaseStringOrEmpty(row.kind);
    const displayName = normalizeLowercaseStringOrEmpty(row.displayName);
    const runtime = normalizeLowercaseStringOrEmpty(resolveAgentRuntimeLabel(row.agentRuntime));
    const status = normalizeLowercaseStringOrEmpty(row.status);
    const goal = row.goal
      ? normalizeLowercaseStringOrEmpty(
          `${row.goal.objective} ${row.goal.status} ${formatGoalSummary(row.goal)} ${
            row.goal.lastStatusNote ?? ""
          }`,
        )
      : "";
    const liveState = isSessionRunActive(row)
      ? "live running"
      : row.hasActiveRun === false
        ? "idle"
        : "";
    if (
      key.includes(q) ||
      label.includes(q) ||
      category.includes(q) ||
      kind.includes(q) ||
      displayName.includes(q) ||
      runtime.includes(q) ||
      status.includes(q) ||
      goal.includes(q) ||
      liveState.includes(q)
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
    const pinnedDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    if (pinnedDiff !== 0) {
      return pinnedDiff;
    }
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
  return parseFilterInteger(value) !== undefined;
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
  return formatDurationCompact(runtimeMs, { spaced: true }) ?? "0ms";
}

// Goal state is a dot + summary; the tooltip carries the objective detail.
function renderSessionGoalStatus(goal: GatewaySessionRow["goal"]) {
  if (!goal) {
    return nothing;
  }
  const kind =
    goal.status === "active"
      ? "accent"
      : goal.status === "complete"
        ? "ok"
        : goal.status === "blocked" ||
            goal.status === "budget_limited" ||
            goal.status === "usage_limited"
          ? "warn"
          : "muted";
  const detail = formatGoalDetail(goal);
  // tabindex lets keyboard users trigger the tooltip; aria-label exposes the
  // full objective detail that sighted users only get on hover.
  return html`
    <openclaw-tooltip .content=${detail}>
      <span tabindex="0" aria-label=${detail}>
        ${renderSettingsStatus({ kind, label: formatGoalSummary(goal) })}
      </span>
    </openclaw-tooltip>
  `;
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
  add(t("sessionsView.group"), row.category);
  add(t("sessionsView.status"), row.status);
  if (row.goal) {
    details.push({ label: t("sessionsView.goal"), value: formatGoalDetail(row.goal) });
  }
  add(t("sessionsView.goalNote"), row.goal?.lastStatusNote);
  add(t("sessionsView.model"), row.model);
  add(t("sessionsView.provider"), row.modelProvider);
  // The roster dropped its Runtime column; the drawer is where agent runtime
  // and run duration live now.
  add(t("sessionsView.runtime"), resolveAgentRuntimeLabel(row.agentRuntime));
  add(t("sessionsView.runDuration"), formatRuntimeMs(row.runtimeMs));
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
  if (typeof row.pinned === "boolean") {
    details.push({
      label: t("sessionsView.pinned"),
      value: row.pinned ? t("common.yes") : t("common.no"),
    });
  }
  return details;
}

const NEW_GROUP_OPTION = "__new-group__";

function sessionsTableColumnCount(props: SessionsProps): number {
  return props.groupBy === "category" ? 8 : 7;
}

function groupModeLabel(mode: SessionsGroupBy): string {
  switch (mode) {
    case "category":
      return t("sessionsView.groupByCategory");
    case "channel":
      return t("sessionsView.groupByChannel");
    case "kind":
      return t("sessionsView.groupByKind");
    case "agent":
      return t("sessionsView.groupByAgent");
    case "date":
      return t("sessionsView.groupByDate");
    default:
      return t("sessionsView.groupByNone");
  }
}

function sessionGroupLabel(id: string, props: SessionsProps): string {
  if (props.groupBy === "date") {
    switch (id) {
      case "today":
        return t("sessionsView.dateToday");
      case "yesterday":
        return t("sessionsView.dateYesterday");
      case "week":
        return t("sessionsView.dateThisWeek");
      case "older":
        return t("sessionsView.dateOlder");
      default:
        return t("sessionsView.dateNoActivity");
    }
  }
  if (id === UNGROUPED_ID) {
    return t("sessionsView.ungrouped");
  }
  if (props.groupBy === "agent") {
    const identity = getAgentIdentity(props.agentIdentityById, id);
    const name = normalizeOptionalString(identity?.name);
    if (name) {
      const emoji = normalizeOptionalString(identity?.emoji);
      return emoji ? `${emoji} ${name}` : name;
    }
  }
  return id;
}

// Drag-over highlighting toggles a class directly on the target row instead of
// re-rendering per dragover event; lit re-renders mid-drag would cancel the drag.
function setDropTargetActive(event: DragEvent, active: boolean) {
  (event.currentTarget as HTMLElement | null)?.classList.toggle(
    "session-drop-target--active",
    active,
  );
}

function categoryDropHandlers(props: SessionsProps, category: string | null) {
  if (props.groupBy !== "category") {
    return { dragover: nothing, dragleave: nothing, drop: nothing } as const;
  }
  const carriesSessionKey = (event: DragEvent) =>
    event.dataTransfer?.types.includes(SESSION_DRAG_MIME) === true;
  return {
    dragover: (event: DragEvent) => {
      if (!carriesSessionKey(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      setDropTargetActive(event, true);
    },
    dragleave: (event: DragEvent) => setDropTargetActive(event, false),
    drop: (event: DragEvent) => {
      if (!carriesSessionKey(event)) {
        return;
      }
      event.preventDefault();
      setDropTargetActive(event, false);
      const key = event.dataTransfer?.getData(SESSION_DRAG_MIME);
      if (key) {
        props.onAssignCategory(key, category);
      }
    },
  } as const;
}

function renderGroupHeaderRow(group: SessionRowGroup, props: SessionsProps) {
  const label = sessionGroupLabel(group.id, props);
  const count =
    group.rows.length === 1
      ? t("sessionsView.groupRowCountOne", { count: "1" })
      : t("sessionsView.groupRowCount", { count: String(group.rows.length) });
  const drop = categoryDropHandlers(props, group.id === UNGROUPED_ID ? null : group.id);
  return html`
    <tr
      class="session-group-row"
      @dragover=${drop.dragover}
      @dragleave=${drop.dragleave}
      @drop=${drop.drop}
    >
      <td colspan=${sessionsTableColumnCount(props)}>
        <div class="session-group-row__header">
          <span class="session-group-row__icon" aria-hidden="true">${icons.folder}</span>
          <span class="session-group-row__label">${label}</span>
          <span class="session-group-row__count">${count}</span>
        </div>
      </td>
    </tr>
  `;
}

function renderCategoryCell(row: GatewaySessionRow, props: SessionsProps) {
  const current = normalizeOptionalString(row.category) ?? "";
  const options = [...props.knownCategories];
  if (current && !options.includes(current)) {
    options.push(current);
  }
  return html`
    <td>
      <select
        ?disabled=${props.loading}
        aria-label=${t("sessionsView.moveToGroup")}
        class="session-group-select"
        @change=${(e: Event) => {
          const select = e.target as HTMLSelectElement;
          if (select.value === NEW_GROUP_OPTION) {
            // The page prompts for a name and patches; restore until the refresh lands.
            select.value = current;
            props.onRequestNewCategory(row.key);
            return;
          }
          props.onAssignCategory(row.key, select.value || null);
        }}
      >
        <option value="" ?selected=${!current}>${t("sessionsView.ungrouped")}</option>
        ${options.map(
          (name) => html`<option value=${name} ?selected=${current === name}>${name}</option>`,
        )}
        <option value=${NEW_GROUP_OPTION}>${t("sessionsView.newGroup")}</option>
      </select>
    </td>
  `;
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
    <openclaw-tooltip .content=${params.title}>
      <label class=${className}>
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
    </openclaw-tooltip>
  `;
}

function renderOverrideSelect(params: {
  label: string;
  disabled: boolean;
  options: readonly { value: string; label: string }[];
  current: string;
  onChange: (value: string) => void;
}) {
  return html`
    <label class="session-override-field">
      <span class="session-override-field__label">${params.label}</span>
      <select
        class="settings-select"
        ?disabled=${params.disabled}
        @change=${(e: Event) => params.onChange((e.target as HTMLSelectElement).value)}
      >
        ${params.options.map(
          (option) =>
            html`<option value=${option.value} ?selected=${params.current === option.value}>
              ${option.label}
            </option>`,
        )}
      </select>
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
  // Grouping shows all rows in their sections; pagination would split groups confusingly.
  const groupingActive = props.groupBy !== "none";
  const groups = groupingActive
    ? groupSessionRows({
        rows: sorted,
        mode: props.groupBy,
        knownCategories: props.knownCategories,
      })
    : null;
  const paginated = groupingActive ? sorted : paginateRows(sorted, page, props.pageSize);
  const emptyBecauseFiltered =
    rawRows.length === 0 ? hasActiveFilters(props) : filtered.length === 0;
  const liveCount = rawRows.filter((row) => isSessionRunActive(row)).length;

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

  const sessionsTitle = html`
    ${t("sessionsView.title")}
    ${props.result
      ? html`
          <openclaw-tooltip .content=${t("sessionsView.store", { path: props.result.path })}>
            <span class="settings-count">${rawRows.length}</span>
          </openclaw-tooltip>
        `
      : nothing}
  `;
  const refreshAction = html`
    <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
      ${props.loading ? t("common.loading") : t("common.refresh")}
    </button>
  `;
  const children = [
    props.error ? html`<div class="sessions-error">${props.error}</div>` : nothing,
    props.result ? renderSettingsSection({}, renderSessionsOverview(rawRows, liveCount)) : nothing,
    // When the gateway lacks sessions.search the section still renders: the
    // form disables itself and shows the unavailable notice (shipped behavior).
    renderSettingsSection(
      {
        title: t("sessionsView.transcriptSearchTitle"),
        description: t("sessionsView.transcriptSearchDescription"),
      },
      renderTranscriptSearch(props, rawRows),
    ),
    renderSettingsSection(
      {
        title: sessionsTitle,
        description: t("sessionsView.subtitle"),
        actions: refreshAction,
      },
      renderSessionsTable(props, {
        paginated,
        groups,
        groupingActive,
        emptyBecauseFiltered,
        totalRows,
        totalPages,
        page,
        sortHeader,
      }),
    ),
  ];
  return renderSettingsPage(children, { wide: true });
}

type SessionsTableContext = {
  paginated: GatewaySessionRow[];
  groups: SessionRowGroup[] | null;
  groupingActive: boolean;
  emptyBecauseFiltered: boolean;
  totalRows: number;
  totalPages: number;
  page: number;
  sortHeader: (
    col: "key" | "kind" | "updated" | "tokens",
    label: string,
    extraClass?: string,
  ) => unknown;
};

function renderSessionsTable(props: SessionsProps, ctx: SessionsTableContext) {
  const { paginated, groups, groupingActive, emptyBecauseFiltered, totalRows, totalPages, page } =
    ctx;
  const sortHeader = ctx.sortHeader;
  const activeTooltip = t("sessionsView.activeTooltip", { count: props.activeMinutes.trim() });
  const limitTooltip = t("sessionsView.limitTooltip");
  const globalTooltip = t("sessionsView.globalTooltip");
  const unknownTooltip = t("sessionsView.unknownTooltip");
  const showArchivedTooltip = t("sessionsView.archivedOnlyTooltip");
  return html`
    <div
      class="sessions-toolbar sessions-filter-bar"
      aria-label=${t("sessionsView.filterControls")}
    >
      <div class="data-table-search sessions-toolbar__search">
        ${icons.search}
        <input
          type="text"
          placeholder=${t("sessionsView.searchPlaceholder")}
          .value=${props.searchQuery}
          @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="session-filter-primary-row">
        <openclaw-tooltip .content=${activeTooltip}>
          <label class="session-filter-field">
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
        </openclaw-tooltip>
        <openclaw-tooltip .content=${limitTooltip}>
          <label class="session-filter-field">
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
        </openclaw-tooltip>
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
          label: t("sessionsView.archivedOnly"),
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
      <span class="sessions-toolbar__divider" aria-hidden="true"></span>
      <label class="session-groupby">
        <span class="session-groupby__label">${t("sessionsView.groupBy")}</span>
        <select
          class="session-groupby__select"
          @change=${(e: Event) =>
            props.onGroupByChange((e.target as HTMLSelectElement).value as SessionsGroupBy)}
        >
          ${SESSION_GROUP_MODES.map(
            (mode) =>
              html`<option value=${mode} ?selected=${props.groupBy === mode}>
                ${groupModeLabel(mode)}
              </option>`,
          )}
        </select>
      </label>
      ${props.groupBy === "category"
        ? html`
            <button class="btn btn--sm" @click=${() => props.onRequestNewCategory()}>
              ${icons.plus} ${t("sessionsView.newGroup")}
            </button>
          `
        : nothing}
    </div>

    ${props.selectedKeys.size > 0
      ? html`
          <div class="data-table-bulk-bar">
            <span>${t("sessionsView.selected", { count: String(props.selectedKeys.size) })}</span>
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
            ${props.groupBy === "category" ? html`<th>${t("sessionsView.group")}</th>` : nothing}
            ${sortHeader("kind", t("sessionsView.kind"))}
            <th class="session-status-col">${t("sessionsView.status")}</th>
            ${sortHeader("updated", t("sessionsView.updated"))}
            ${sortHeader("tokens", t("sessionsView.tokens"))}
            <th class="session-actions-col">
              <span class="sessions-sr-only">${t("sessionsView.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          ${props.loading && !props.result
            ? renderSkeletonRows(sessionsTableColumnCount(props))
            : paginated.length === 0
              ? html`
                  <tr>
                    <td colspan=${sessionsTableColumnCount(props)} class="data-table-empty-cell">
                      ${emptyBecauseFiltered
                        ? html`
                            <div class="data-table-empty-state" role="status" aria-live="polite">
                              <div class="data-table-empty-state__message">
                                ${icons.search}
                                <span>${t("sessionsView.noSessionsMatchFilters")}</span>
                              </div>
                              <button class="btn btn--sm" @click=${props.onClearFilters}>
                                ${t("sessionsView.showAll")}
                              </button>
                            </div>
                          `
                        : html`
                            <div class="data-table-empty-state" role="status" aria-live="polite">
                              <div class="data-table-empty-state__message">
                                ${icons.messageSquare}
                                <span>${t("sessionsView.noSessions")}</span>
                              </div>
                            </div>
                          `}
                    </td>
                  </tr>
                `
              : groups
                ? groups.flatMap((group) => {
                    const section = group.rows.flatMap((row) => renderRows(row, props));
                    section.unshift(renderGroupHeaderRow(group, props));
                    return section;
                  })
                : paginated.flatMap((row) => renderRows(row, props))}
        </tbody>
      </table>
    </div>

    ${totalRows > 0 && !groupingActive
      ? html`
          <div class="data-table-pagination">
            <div class="data-table-pagination__info">
              ${t("sessionsView.pagination", {
                start: String(page * props.pageSize + 1),
                end: String(Math.min((page + 1) * props.pageSize, totalRows)),
                total: String(totalRows),
              })}
            </div>
            <div class="data-table-pagination__controls">
              <select
                class="data-table-pagination__size"
                .value=${String(props.pageSize)}
                @change=${(e: Event) =>
                  props.onPageSizeChange(Number((e.target as HTMLSelectElement).value))}
              >
                ${PAGE_SIZES.map(
                  (s) =>
                    html`<option value=${s}>
                      ${t("sessionsView.rowsPerPage", { count: String(s) })}
                    </option>`,
                )}
              </select>
              <button ?disabled=${page <= 0} @click=${() => props.onPageChange(page - 1)}>
                ${t("common.previous")}
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
  `;
}

function renderRows(row: GatewaySessionRow, props: SessionsProps) {
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : t("common.na");
  const latestCheckpoint = row.latestCompactionCheckpoint;
  const checkpointCount = row.compactionCheckpointCount ?? 0;
  const visibleCheckpointCount = Math.max(checkpointCount, latestCheckpoint ? 1 : 0);
  const hasCheckpoints = checkpointCount > 0 || Boolean(latestCheckpoint);
  const isExpanded = props.expandedSessionKey === row.key;
  const detailsId = `session-details-${encodeURIComponent(row.key)}`;
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
    ? `${pathForRoute("chat", props.basePath)}${searchForSession(row.key)}`
    : null;
  const kindClass = `session-kind session-kind--${row.kind}`;
  const rowClass = [
    "session-data-row",
    "session-data-row--expandable",
    isExpanded ? "session-data-row--expanded" : "",
    props.sessionMenu?.key === row.key ? "session-data-row--menu-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // The {count} placeholder predates the drawer redesign; it carries the session title.
  const detailsToggleLabel = isExpanded
    ? t("sessionsView.hideSessionDetails", { count: keyCellTitle })
    : t("sessionsView.showSessionDetails", { count: keyCellTitle });
  const categoryMode = props.groupBy === "category";
  // Dropping on a row targets that row's group so the whole section area accepts drops.
  const rowDrop = categoryDropHandlers(props, normalizeOptionalString(row.category) ?? null);

  return [
    html`<tr
      class=${rowClass}
      tabindex="0"
      aria-expanded=${String(isExpanded)}
      aria-controls=${detailsId}
      draggable=${categoryMode ? "true" : nothing}
      aria-description=${categoryMode ? t("sessionsView.dragSessionHint") : nothing}
      @dragstart=${categoryMode
        ? (e: DragEvent) => {
            e.dataTransfer?.setData(SESSION_DRAG_MIME, row.key);
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = "move";
            }
          }
        : nothing}
      @dragover=${rowDrop.dragover}
      @dragleave=${rowDrop.dragleave}
      @drop=${rowDrop.drop}
      @contextmenu=${(event: MouseEvent) => {
        event.preventDefault();
        props.onOpenSessionMenu(row, { x: event.clientX, y: event.clientY }, null);
      }}
      @click=${(e: MouseEvent) => {
        if (isRowControlTarget(e.target)) {
          return;
        }
        props.onToggleDetails(row.key);
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (isRowControlTarget(e.target)) {
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onToggleDetails(row.key);
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
        <openclaw-tooltip .content=${keyCellTitle}>
          <div class=${friendlyKeyLabel ? "session-key-cell" : "mono session-key-cell"}>
            ${renderSessionAvatar(row)}
            <div class="session-key-cell__text">
              <span class="session-key-cell__primary">
                ${row.unread === true
                  ? html`<span
                      class="session-unread-dot"
                      role="img"
                      aria-label=${t("sessionsView.unread")}
                    ></span>`
                  : nothing}
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
                  : html`<span>${friendlyKeyLabel ?? row.key}</span>`}
                ${trimmedLabel
                  ? html`<span class="session-label-chip" title=${trimmedLabel}
                      >${trimmedLabel}</span
                    >`
                  : nothing}
              </span>
              ${showDisplayName
                ? html`<span class="muted session-key-display-name">${displayName}</span>`
                : nothing}
            </div>
          </div>
        </openclaw-tooltip>
      </td>
      ${categoryMode ? renderCategoryCell(row, props) : nothing}
      <td>
        <span class=${kindClass}>${row.kind}</span>
      </td>
      <td class="session-status-col">
        <div class="session-status-stack">
          ${renderSessionStatusBadge(row)} ${renderSessionGoalStatus(row.goal)}
        </div>
      </td>
      <td>${updated}</td>
      <td class="session-token-cell">${renderTokensCell(row)}</td>
      <td class="session-actions-cell">
        <div class="session-actions">
          <button
            class="session-details-toggle"
            type="button"
            aria-expanded=${String(isExpanded)}
            aria-controls=${detailsId}
            aria-label=${detailsToggleLabel}
            @click=${(e: MouseEvent) => {
              e.stopPropagation();
              props.onToggleDetails(row.key);
            }}
          >
            ${visibleCheckpointCount > 0
              ? html`<span class="settings-count session-compaction-count"
                  >${visibleCheckpointCount}</span
                >`
              : nothing}
            ${icons.chevronDown}
          </button>
          <button
            class="icon-btn"
            type="button"
            title=${t("chat.sidebar.openSessionMenu")}
            aria-label=${t("chat.sidebar.openSessionMenu")}
            aria-haspopup="menu"
            aria-expanded=${String(props.sessionMenu?.key === row.key)}
            @click=${(event: MouseEvent) => {
              event.stopPropagation();
              const trigger = event.currentTarget as HTMLElement;
              const rect = trigger.getBoundingClientRect();
              props.onOpenSessionMenu(row, { x: rect.right, y: rect.bottom + 4 }, trigger);
            }}
          >
            ${icons.moreHorizontal}
          </button>
        </div>
      </td>
    </tr>`,
    ...(isExpanded
      ? [
          renderSessionDetailsRow({
            row,
            props,
            detailsId,
            friendlyKeyLabel,
            keyCellTitle,
            displayName,
            showDisplayName,
            kindClass,
            updated,
            visibleCheckpointCount,
            hasCheckpoints,
          }),
        ]
      : []),
  ];
}

function renderSessionDetailsRow(params: {
  row: GatewaySessionRow;
  props: SessionsProps;
  detailsId: string;
  friendlyKeyLabel: string | null;
  keyCellTitle: string;
  displayName: string | null;
  showDisplayName: boolean;
  kindClass: string;
  updated: string;
  visibleCheckpointCount: number;
  hasCheckpoints: boolean;
}) {
  const {
    row,
    props,
    detailsId,
    friendlyKeyLabel,
    displayName,
    showDisplayName,
    kindClass,
    updated,
    visibleCheckpointCount,
    hasCheckpoints,
  } = params;
  const rawThinking = row.thinkingLevel ?? "";
  const thinking = rawThinking ? normalizeThinkingOptionValue(rawThinking) : "";
  const thinkLevels = withCurrentLabeledOption(
    resolveThinkLevelOptions(row, props.result?.defaults),
    thinking,
  );
  const fastMode =
    row.fastMode === "auto"
      ? "auto"
      : row.fastMode === true
        ? "on"
        : row.fastMode === false
          ? "off"
          : "";
  const fastLevels = withCurrentLabeledOption(buildFastLevelOptions(), fastMode);
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentLabeledOption(buildVerboseLevelOptions(), verbose);
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentOption(REASONING_LEVELS, reasoning);
  const checkpointItems = props.checkpointItemsByKey[row.key] ?? [];
  const checkpointError = props.checkpointErrorByKey[row.key];
  const checkpointLabel = formatCheckpointCount(visibleCheckpointCount);
  const sessionDetails = sessionDetailItems({
    row,
    updated,
    checkpointCount: visibleCheckpointCount,
  });

  return html`<tr id=${detailsId} class="session-details-row">
    <td colspan=${sessionsTableColumnCount(props)}>
      <div class="session-details-panel">
        <div class="session-details-panel__hero">
          <div>
            <div class="session-details-panel__eyebrow">${t("sessionsView.sessionDetails")}</div>
            <div class="session-details-panel__title">${friendlyKeyLabel ?? row.key}</div>
            ${showDisplayName
              ? html`<div class="muted session-details-panel__subtitle">${displayName}</div>`
              : nothing}
          </div>
          <div class="session-details-panel__badges">
            ${renderSessionStatusBadge(row)} ${renderSessionGoalStatus(row.goal)}
            <span class=${kindClass}>${row.kind}</span>
          </div>
        </div>

        <div class="session-details-section">
          <div class="session-details-panel__eyebrow">${t("sessionsView.overrides")}</div>
          <div class="session-overrides-grid">
            <label class="session-override-field">
              <span class="session-override-field__label">${t("sessionsView.label")}</span>
              <input
                class="settings-input"
                .value=${row.label ?? ""}
                ?disabled=${props.loading}
                placeholder=${t("sessionsView.optionalPlaceholder")}
                @change=${(e: Event) => {
                  const value =
                    normalizeOptionalString((e.target as HTMLInputElement).value) ?? null;
                  props.onPatch(row.key, { label: value });
                }}
              />
            </label>
            ${renderOverrideSelect({
              label: t("sessionsView.thinking"),
              disabled: props.loading,
              options: thinkLevels,
              current: thinking,
              onChange: (value) =>
                props.onPatch(row.key, { thinkingLevel: resolveThinkLevelPatchValue(value) }),
            })}
            ${renderOverrideSelect({
              label: t("sessionsView.fast"),
              disabled: props.loading,
              options: fastLevels,
              current: fastMode,
              onChange: (value) =>
                props.onPatch(row.key, {
                  fastMode: value === "" ? null : value === "auto" ? "auto" : value === "on",
                }),
            })}
            ${renderOverrideSelect({
              label: t("sessionsView.verbose"),
              disabled: props.loading,
              options: verboseLevels,
              current: verbose,
              onChange: (value) => props.onPatch(row.key, { verboseLevel: value || null }),
            })}
            ${renderOverrideSelect({
              label: t("sessionsView.reasoning"),
              disabled: props.loading,
              options: reasoningLevels.map((level) => ({
                value: level,
                label: level || t("sessionsView.inherit"),
              })),
              current: reasoning,
              onChange: (value) => props.onPatch(row.key, { reasoningLevel: value || null }),
            })}
          </div>
        </div>

        <div class="session-details-grid">
          ${sessionDetails.map(
            (item) => html`
              <div class="session-detail-stat">
                <div class="session-detail-stat__label">${item.label}</div>
                <openclaw-tooltip .content=${item.value}>
                  <div class="session-detail-stat__value">${item.value}</div>
                </openclaw-tooltip>
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
              : !hasCheckpoints || checkpointItems.length === 0
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
                              : html`<div class="muted">${t("sessionsView.noSummary")}</div>`}
                            <div class="session-checkpoint-card__actions">
                              <button
                                class="btn btn--sm"
                                ?disabled=${props.checkpointBusyKey === checkpoint.checkpointId}
                                @click=${() =>
                                  props.onBranchFromCheckpoint(row.key, checkpoint.checkpointId)}
                              >
                                ${t("sessionsView.branchFromCheckpoint")}
                              </button>
                              <button
                                class="btn btn--sm"
                                ?disabled=${props.checkpointBusyKey === checkpoint.checkpointId}
                                @click=${() =>
                                  props.onRestoreCheckpoint(row.key, checkpoint.checkpointId)}
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
  </tr>`;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
