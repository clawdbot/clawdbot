import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";

export type PanelRefreshStatus = Readonly<{
  error: string | null;
  hasLoaded: boolean;
  stale: boolean;
}>;

export function createPanelRefreshStatus(): PanelRefreshStatus {
  return { error: null, hasLoaded: false, stale: false };
}

export function beginPanelRefresh(
  status: PanelRefreshStatus,
  options?: { clearError?: boolean },
): PanelRefreshStatus {
  return {
    ...status,
    error: options?.clearError === false ? status.error : null,
  };
}

export function completePanelRefresh(): PanelRefreshStatus {
  return { error: null, hasLoaded: true, stale: false };
}

export function failPanelRefresh(status: PanelRefreshStatus, error: string): PanelRefreshStatus {
  return {
    error,
    hasLoaded: status.hasLoaded,
    stale: status.hasLoaded,
  };
}

export function renderPanelRefreshStatus(params: {
  status: PanelRefreshStatus;
  errorMessage?: string;
  onRetry: () => void;
  className?: string;
}): TemplateResult | typeof nothing {
  const { status } = params;
  const error = params.errorMessage ?? status.error;
  if (!error && !status.stale) {
    return nothing;
  }
  const className = params.className ? ` ${params.className}` : "";
  if (!error) {
    return html`
      <div class="callout warn${className}" role="status">
        <strong>${t("common.staleData")}</strong>
      </div>
    `;
  }
  return html`
    <div class="callout danger callout--dismissible${className}" role="alert">
      <span class="callout__content">
        <span>${error}</span>
        ${status.stale ? html`<br /><strong>${t("common.staleData")}</strong>` : nothing}
      </span>
      <button class="btn btn--sm" @click=${params.onRetry}>${t("common.retry")}</button>
    </div>
  `;
}
