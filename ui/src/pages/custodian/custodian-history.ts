import type { SystemChangeEntry } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";

function changeSourceLabel(source: SystemChangeEntry["source"]): string {
  switch (source) {
    case "system-agent":
      return t("custodian.history.sources.systemAgent");
    case "doctor":
      return t("custodian.history.sources.doctor");
    case "config-rpc":
      return t("custodian.history.sources.settings");
    case "external":
      return t("custodian.history.sources.manualEdit");
    case "cli":
      return t("custodian.history.sources.cli");
    case "plugin-install":
      return t("custodian.history.sources.pluginInstall");
    case "unknown":
      return t("custodian.history.sources.unknown");
  }
  return source satisfies never;
}

function renderHistoryCard(entry: SystemChangeEntry) {
  return html`
    <article class="custodian__change-card ${entry.invalid ? "is-invalid" : ""}">
      <div class="custodian__change-meta">
        <span class="custodian__change-source">${changeSourceLabel(entry.source)}</span>
        <time datetime=${new Date(entry.at).toISOString()}
          >${formatRelativeTimestamp(entry.at)}</time
        >
      </div>
      <div class="custodian__change-summary">${entry.summary}</div>
      ${entry.invalid
        ? html`<div class="custodian__change-warning">${t("custodian.history.invalidEdit")}</div>`
        : nothing}
      ${entry.opaqueChange
        ? html`<div class="custodian__change-note">${t("custodian.history.opaqueChange")}</div>`
        : nothing}
      ${entry.changedPaths?.length
        ? html`<details class="custodian__change-paths">
            <summary>
              ${t("custodian.history.changedPaths", { count: String(entry.changedPaths.length) })}
            </summary>
            <ul>
              ${entry.changedPaths.map((path) => html`<li><code>${path}</code></li>`)}
            </ul>
          </details>`
        : nothing}
    </article>
  `;
}

export function renderCustodianChangeHistory(params: {
  entries: SystemChangeEntry[];
  error: string | null;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  onLoad: (reset: boolean) => void;
}) {
  return html`
    <section class="custodian__history" aria-label=${t("custodian.history.title")}>
      <div class="custodian__history-heading">
        <strong>${t("custodian.history.title")}</strong>
        <span>${t("custodian.history.description")}</span>
      </div>
      ${params.error
        ? html`<div class="custodian__history-error" role="alert">
            <span>${params.error}</span>
            <button class="btn btn--sm" type="button" @click=${() => params.onLoad(true)}>
              ${t("common.retry")}
            </button>
          </div>`
        : nothing}
      <div class="custodian__change-list">
        ${params.entries.map(renderHistoryCard)}
        ${params.loading
          ? html`<div class="custodian__history-state" role="status">
              ${t("custodian.history.loading")}
            </div>`
          : params.loaded && params.entries.length === 0 && !params.error
            ? html`<div class="custodian__history-state" role="status">
                ${t("custodian.history.empty")}
              </div>`
            : nothing}
      </div>
      ${params.nextCursor
        ? html`<button
            class="btn btn--ghost custodian__history-more"
            type="button"
            ?disabled=${params.loadingMore}
            @click=${() => params.onLoad(false)}
          >
            ${params.loadingMore
              ? t("custodian.history.loadingMore")
              : t("custodian.history.loadMore")}
          </button>`
        : nothing}
    </section>
  `;
}
