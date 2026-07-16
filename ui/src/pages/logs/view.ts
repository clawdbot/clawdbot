// Control UI view renders logs screen content.
import { html, nothing } from "lit";
import {
  renderPanelRefreshStatus,
  type PanelRefreshStatus,
} from "../../components/panel-refresh-status.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsStatus,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import type { LogEntry, LogLevel } from "./log-lines.ts";

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
type ExportFileLabel = "filtered" | "visible";

type LogsProps = {
  loading: boolean;
  status: PanelRefreshStatus;
  file: string | null;
  entries: LogEntry[];
  filterText: string;
  levelFilters: Record<LogLevel, boolean>;
  autoFollow: boolean;
  truncated: boolean;
  onFilterTextChange: (next: string) => void;
  onLevelToggle: (level: LogLevel, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onRefresh: () => void;
  onExport: (lines: string[], label: string) => void;
  onScroll: (event: Event) => void;
};

function formatTime(value?: string | null) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

function matchesFilter(entry: LogEntry, needle: string) {
  if (!needle) {
    return true;
  }
  const haystack = normalizeLowercaseStringOrEmpty(
    [entry.message, entry.subsystem, entry.raw].filter(Boolean).join(" "),
  );
  return haystack.includes(needle);
}

export function renderLogs(props: LogsProps) {
  const needle = normalizeLowercaseStringOrEmpty(props.filterText);
  const levelFiltered = LEVELS.some((level) => !props.levelFilters[level]);
  const filtered = props.entries.filter((entry) => {
    if (entry.level && !props.levelFilters[entry.level]) {
      return false;
    }
    return matchesFilter(entry, needle);
  });
  const exportFileLabel: ExportFileLabel = needle || levelFiltered ? "filtered" : "visible";
  const exportDisplayLabel = t(`logsView.exportLabels.${exportFileLabel}`);

  // The stream fills the remaining viewport height; the settings-page column
  // wrapper is intentionally skipped so the fill-height flex chain
  // (.settings-workspace--fill-height … .logs-card … .log-stream) stays intact.
  return html`
    <div class="settings-section__header">
      <h2 class="settings-section__heading">${t("logsView.title")}</h2>
      <div class="settings-section__actions">
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
        <button
          class="btn"
          ?disabled=${filtered.length === 0}
          @click=${() =>
            props.onExport(
              filtered.map((entry) => entry.raw),
              exportFileLabel,
            )}
        >
          ${t("logsView.exportButton", { label: exportDisplayLabel })}
        </button>
      </div>
    </div>
    <p class="settings-section__desc">${t("logsView.subtitle")}</p>
    ${renderPanelRefreshStatus({
      status: props.status,
      onRetry: props.onRefresh,
      className: "logs-refresh-status",
    })}
    <div class="settings-group logs-card">
      ${renderSettingsRow({
        title: t("logsView.filter"),
        description: props.file ? t("logsView.file", { file: props.file }) : undefined,
        control: html`
          <input
            class="settings-input"
            aria-label=${t("logsView.filter")}
            .value=${props.filterText}
            @input=${(e: Event) => props.onFilterTextChange((e.target as HTMLInputElement).value)}
            placeholder=${t("logsView.searchPlaceholder")}
          />
        `,
      })}
      <div class="settings-row">
        <div class="chip-row">
          ${LEVELS.map(
            (level) => html`
              <label class="chip log-chip ${level}">
                <input
                  type="checkbox"
                  .checked=${props.levelFilters[level]}
                  @change=${(e: Event) =>
                    props.onLevelToggle(level, (e.target as HTMLInputElement).checked)}
                />
                <span>${level}</span>
              </label>
            `,
          )}
        </div>
        <div class="settings-row__control">
          ${renderSettingsToggle({
            checked: props.autoFollow,
            ariaLabel: t("logsView.autoFollow"),
            onChange: (checked) => props.onToggleAutoFollow(checked),
          })}
          <span class="settings-row__value">${t("logsView.autoFollow")}</span>
        </div>
      </div>
      ${props.truncated
        ? html`
            <div class="settings-row">
              ${renderSettingsStatus({ kind: "warn", label: t("logsView.truncated") })}
            </div>
          `
        : nothing}
      <div class="log-stream" @scroll=${props.onScroll}>
        ${filtered.length === 0
          ? renderSettingsEmpty(t("logsView.empty"))
          : filtered.map(
              (entry) => html`
                <div class="log-row">
                  <div class="log-time mono">${formatTime(entry.time)}</div>
                  <div class="log-level ${entry.level ?? ""}">${entry.level ?? ""}</div>
                  <div class="log-subsystem mono">${entry.subsystem ?? ""}</div>
                  <div class="log-message mono">${entry.message ?? entry.raw}</div>
                </div>
              `,
            )}
      </div>
    </div>
  `;
}
