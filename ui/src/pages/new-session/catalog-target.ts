import { html, nothing } from "lit";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { newSessionLocationFromSearch, type NewSessionRouteData } from "./location.ts";

function draftRouteKey(requestedAgentId: string, catalogId: string): string {
  return JSON.stringify([requestedAgentId, catalogId]);
}

/**
 * Which draft a new-session route has open. This keys on the requested agent,
 * not the resolved one: a catalog route resolves its agent through the Gateway
 * and reports it empty until the roster arrives, so keying on the resolved id
 * would make that fill-in look like a navigation and discard the draft.
 */
export function routeKey(data?: NewSessionRouteData): string {
  return draftRouteKey(data?.requestedAgentId ?? "", data?.catalogId ?? "");
}

export function routeKeyFromSearch(search: string): string {
  const location = newSessionLocationFromSearch(search);
  return draftRouteKey(location.agentId, location.catalogId);
}

export function isTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId);
}

export function isResolvedTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId && data.model && data.catalogLabel);
}

export function resolveAgentId(
  data: Pick<NewSessionRouteData, "agentId" | "catalogId"> | undefined,
  availableAgents: readonly { id: string }[],
  fallback: string,
): string {
  const rawRequested = data?.agentId?.trim();
  if (!rawRequested) {
    return normalizeAgentId(fallback);
  }
  const requested = normalizeAgentId(rawRequested);
  return availableAgents.some((candidate) => normalizeAgentId(candidate.id) === requested)
    ? requested
    : normalizeAgentId(fallback);
}

export function allowsSelectedAgent(
  data: NewSessionRouteData | undefined,
  selectedAgent: unknown,
): boolean {
  return !isTarget(data) || (isResolvedTarget(data) && Boolean(selectedAgent));
}

export async function resolveCreateTarget(
  client: GatewayBrowserClient,
  catalogId: string,
  agentId?: string,
): Promise<Pick<NewSessionRouteData, "model" | "catalogLabel" | "startTerminal"> | undefined> {
  try {
    const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      ...(agentId ? { agentId } : {}),
      catalogId,
      limitPerHost: 1,
    });
    const catalog = result.catalogs.find((candidate) => candidate.id === catalogId);
    const model = catalog?.capabilities.createSession?.model.trim();
    return catalog && model
      ? {
          model,
          catalogLabel: catalog.label,
          startTerminal: catalog.capabilities.createSession?.startTerminal === true,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function renderTarget(data?: NewSessionRouteData) {
  if (!isTarget(data)) {
    return nothing;
  }
  const ready = isResolvedTarget(data);
  const label = data?.catalogLabel || data?.catalogId || "";
  return html`<span
    class="new-session-page__trigger new-session-page__runtime"
    title=${ready ? data?.model : t("newSession.catalogUnavailable")}
  >
    <span class="new-session-page__target-icon" aria-hidden="true">${icons.terminal}</span>
    <span>${label}</span>
  </span>`;
}

export function renderBar(params: {
  data?: NewSessionRouteData;
  agentSelect: unknown;
  placeSelect: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const pending = isTarget(params.data) && !isResolvedTarget(params.data);
  return html`
    <div class="new-session-page__triggers">
      ${renderTarget(params.data)} ${isTarget(params.data) ? nothing : params.agentSelect}
      ${params.placeSelect}
      ${pending
        ? html`<span class="new-session-page__catalog-unavailable">
            ${t("newSession.catalogUnavailable")}
            <button
              class="btn btn--sm"
              type="button"
              ?disabled=${params.retrying}
              @click=${params.onRetry}
            >
              ${params.retrying ? t("common.loading") : t("lazyView.retry")}
            </button>
          </span>`
        : nothing}
    </div>
  `;
}
