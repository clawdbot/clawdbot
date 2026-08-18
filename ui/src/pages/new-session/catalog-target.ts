import { html, nothing } from "lit";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { newSessionLocationFromSearch, type NewSessionRouteData } from "./location.ts";

function draftRouteKey(requestedAgentId: string, catalogId: string, group: string): string {
  return JSON.stringify([requestedAgentId, catalogId, group]);
}

/**
 * Which draft a new-session route has open. This keys on the requested agent,
 * not the resolved one: a catalog route resolves its agent through the Gateway
 * and reports it empty until the roster arrives, so keying on the resolved id
 * would make that fill-in look like a navigation and discard the draft.
 */
export function routeKey(data?: NewSessionRouteData): string {
  return draftRouteKey(data?.requestedAgentId ?? "", data?.catalogId ?? "", data?.group ?? "");
}

export function routeKeyFromSearch(search: string): string {
  const location = newSessionLocationFromSearch(search);
  return draftRouteKey(location.agentId, location.catalogId, location.group ?? "");
}

export function isTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId);
}

function isResolvedTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId && data.model && data.catalogLabel);
}

function isPendingRouteTarget(data?: NewSessionRouteData): boolean {
  return (
    (isTarget(data) && !isResolvedTarget(data)) ||
    Boolean(data?.group && data.groupStatus !== "resolved")
  );
}

export function groupDefaultsKey(data?: NewSessionRouteData): string {
  return JSON.stringify([
    data?.groupStatus ?? "",
    data?.groupCwd ?? "",
    data?.groupWorktree === true,
    data?.groupCatalogGeneration ?? -1,
    data?.groupDefaultsStatus ?? "idle",
  ]);
}

function groupRouteNeedsRevalidation(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability,
): boolean {
  const groupName = data?.group?.trim();
  if (!groupName) {
    return false;
  }
  const generation = sessions.groupsGeneration();
  const status = sessions.groupsStatus();
  if (data?.groupCatalogGeneration !== generation || data.groupDefaultsStatus !== status) {
    return true;
  }
  if (status !== "ready") {
    return false;
  }
  const current = sessions.state.groupSettings.find((group) => group.name === groupName);
  return current
    ? data.groupStatus !== "resolved" ||
        (data.groupCwd ?? "") !== (current.cwd ?? "") ||
        data.groupWorktree !== (current.worktree === true)
    : data.groupStatus === "resolved";
}

function groupRouteCatalogKey(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability,
): string {
  const current = sessions.state.groupSettings.find((group) => group.name === data?.group);
  return JSON.stringify([
    data?.group ?? "",
    sessions.groupsGeneration(),
    sessions.groupsStatus(),
    Boolean(current),
    current?.cwd ?? "",
    current?.worktree === true,
  ]);
}

export function isGroupRoutePending(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability | undefined,
): boolean {
  return Boolean(data?.group && (!sessions || groupRouteNeedsRevalidation(data, sessions)));
}

export function isRoutePending(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability | undefined,
): boolean {
  return isPendingRouteTarget(data) || isGroupRoutePending(data, sessions);
}

export function resolvedGroupName(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability | undefined,
): string | undefined {
  return data?.groupStatus === "resolved" && !isGroupRoutePending(data, sessions)
    ? data.group
    : undefined;
}

export class GroupRouteRevalidation {
  private pending: Promise<unknown> | null = null;
  private lastKey = "";

  constructor(
    private readonly readData: () => NewSessionRouteData | undefined,
    private readonly revalidate: () => Promise<unknown> | undefined,
  ) {}

  synchronize(sessions: SessionCapability) {
    if (this.pending) {
      return;
    }
    const data = this.readData();
    const key = groupRouteCatalogKey(data, sessions);
    if (this.lastKey === key || !groupRouteNeedsRevalidation(data, sessions)) {
      return;
    }
    const pending = this.revalidate();
    if (!pending) {
      return;
    }
    this.lastKey = key;
    this.pending = pending;
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (this.pending === pending) {
          this.pending = null;
          this.synchronize(sessions);
        }
      });
  }
}

export function resolveAgentId(
  data: Pick<NewSessionRouteData, "agentId" | "catalogId"> | undefined,
  availableAgents: readonly { id: string }[],
  fallback: string,
): string {
  const rawRequested = data?.agentId?.trim();
  if (!rawRequested) {
    return fallback && normalizeAgentId(fallback);
  }
  const requested = normalizeAgentId(rawRequested);
  return availableAgents.some((candidate) => normalizeAgentId(candidate.id) === requested)
    ? requested
    : fallback && normalizeAgentId(fallback);
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
  groupPending?: boolean;
}) {
  const pending = isPendingRouteTarget(params.data) || params.groupPending === true;
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
