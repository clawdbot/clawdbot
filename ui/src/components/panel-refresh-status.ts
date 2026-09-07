import { html, nothing, type TemplateResult } from "lit";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isAwaitingGatewayFailure } from "../lib/gateway-availability.ts";

export type PanelRefreshStatus = Readonly<{
  error: string | null;
  hasLoaded: boolean;
  stale: boolean;
  awaitingGateway: boolean;
}>;

export function createPanelRefreshStatus(): PanelRefreshStatus {
  return { error: null, hasLoaded: false, stale: false, awaitingGateway: false };
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
  return { error: null, hasLoaded: true, stale: false, awaitingGateway: false };
}

export function failPanelRefresh(
  status: PanelRefreshStatus,
  error: unknown,
  gateway: ApplicationGatewaySnapshot | null | undefined,
): PanelRefreshStatus {
  const awaitingGateway = isAwaitingGatewayFailure(error, gateway);
  return {
    error: awaitingGateway ? null : formatUiError(error),
    hasLoaded: status.hasLoaded,
    stale: status.hasLoaded,
    awaitingGateway,
  };
}

export function renderPanelRefreshStatus(params: {
  status: PanelRefreshStatus;
  errorMessage?: string;
  className?: string;
}): TemplateResult | typeof nothing {
  const { status } = params;
  if (status.awaitingGateway) {
    return nothing;
  }
  const rawError = params.errorMessage ?? status.error;
  const error = rawError ? formatUiError(rawError) : rawError;
  if (!error && !status.stale) {
    return nothing;
  }
  const className = params.className ? ` ${params.className}` : "";
  return html`
    <div
      class="callout ${error ? "danger" : "warn"}${className}"
      role=${error ? "alert" : "status"}
    >
      ${error ? html`<span>${error}</span>` : nothing}
      ${error && status.stale ? html`<br />` : nothing}
      ${status.stale ? html`<strong>${t("common.staleData")}</strong>` : nothing}
    </div>
  `;
}
