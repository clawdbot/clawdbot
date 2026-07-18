import type {
  SessionCatalog,
  SessionsCatalogHostEvent,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { generateUUID } from "../lib/uuid.ts";
import {
  preserveExpandedCatalogHost,
  refetchExpandedSessionCatalogPages,
} from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

export const SESSION_CATALOG_CHANGED_REFRESH_MS = 5_000;
const SESSION_CATALOG_STABLE_REFRESH_MS = 30_000;

function sessionCatalogSnapshot(catalogs: readonly SessionCatalog[]): string {
  return JSON.stringify(catalogs);
}

export function sessionCatalogListClient(
  snapshot: ApplicationGatewaySnapshot | undefined,
  connected: boolean,
): GatewayBrowserClient | null {
  if (
    !connected ||
    !snapshot?.connected ||
    !snapshot.client ||
    isGatewayMethodAdvertised(snapshot, "sessions.catalog.list") !== true
  ) {
    return null;
  }
  return snapshot.client;
}

async function requestSessionCatalogList(params: {
  client: GatewayBrowserClient;
  agentId: string;
  progressId: string;
  progressive: boolean;
}): Promise<{ result: SessionsCatalogListResult; progressive: boolean }> {
  const baseParams = { agentId: params.agentId, limitPerHost: 40 };
  if (!params.progressive) {
    return {
      result: await params.client.request("sessions.catalog.list", baseParams),
      progressive: false,
    };
  }
  try {
    return {
      result: await params.client.request("sessions.catalog.list", {
        ...baseParams,
        progressId: params.progressId,
      }),
      progressive: true,
    };
  } catch (error) {
    if (!(error instanceof GatewayRequestError) || error.gatewayCode !== "INVALID_REQUEST") {
      throw error;
    }
    // Older Gateways advertise the list method but reject the additive field.
    // Retry once without streaming, then keep that connection on final pages.
    return {
      result: await params.client.request("sessions.catalog.list", baseParams),
      progressive: false,
    };
  }
}

function isSessionsCatalogHostEvent(value: unknown): value is SessionsCatalogHostEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Record<string, unknown>;
  const catalog = event.catalog;
  if (!catalog || typeof catalog !== "object") {
    return false;
  }
  const catalogRecord = catalog as Record<string, unknown>;
  const hosts = Array.isArray(catalogRecord.hosts) ? catalogRecord.hosts : [];
  const host = hosts[0];
  return (
    typeof event.progressId === "string" &&
    event.progressId.length > 0 &&
    typeof event.agentId === "string" &&
    event.agentId.length > 0 &&
    typeof catalogRecord.id === "string" &&
    typeof catalogRecord.label === "string" &&
    catalogRecord.capabilities !== null &&
    typeof catalogRecord.capabilities === "object" &&
    hosts.length === 1 &&
    host !== null &&
    typeof host === "object" &&
    typeof (host as Record<string, unknown>).hostId === "string" &&
    Array.isArray((host as Record<string, unknown>).sessions)
  );
}

/** Tracks one sidebar's progressive list streams and adaptive refresh lifecycle. */
export class SessionCatalogLiveState {
  timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  requestGeneration: number | null = null;
  sawChange = false;
  refreshPending = false;
  progressive = true;

  private activationTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private connectionEpoch = 0;
  private refetchOwner: symbol | null = null;
  private presenceSignature: string | null = null;
  private progressSequence = 0;
  private readonly progressSequences = new Map<string, number>();
  private readonly hostProgressSequences = new Map<string, number>();
  private readonly hostIdsByCatalog = new Map<string, ReadonlySet<string>>();
  private readonly requestChangedHostKeys = new Set<string>();
  private requestOwner: symbol | null = null;

  cancelTimer() {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  clear() {
    this.cancelScheduledRefreshes();
    this.requestGeneration = null;
    this.requestOwner = null;
    this.progressSequences.clear();
    this.hostProgressSequences.clear();
    this.hostIdsByCatalog.clear();
    this.requestChangedHostKeys.clear();
    this.presenceSignature = null;
    this.sawChange = false;
    this.refreshPending = false;
    this.refetchOwner = null;
  }

  resetConnection() {
    this.clear();
    this.connectionEpoch += 1;
    this.progressive = true;
  }

  async requestList(
    client: GatewayBrowserClient,
    agentId: string,
    progressId: string,
  ): Promise<SessionsCatalogListResult> {
    const connectionEpoch = this.connectionEpoch;
    const response = await requestSessionCatalogList({
      client,
      agentId,
      progressId,
      progressive: this.progressive,
    });
    if (connectionEpoch === this.connectionEpoch) {
      this.progressive = response.progressive;
    }
    return response.result;
  }

  mergeFinal(catalogs: SessionCatalog[], currentCatalogs: readonly SessionCatalog[]) {
    const current = new Map(currentCatalogs.map((catalog) => [catalog.id, catalog]));
    return catalogs.map((catalog) => {
      const currentHosts = new Map(
        current.get(catalog.id)?.hosts.map((host) => [host.hostId, host]) ?? [],
      );
      return {
        ...catalog,
        hosts: catalog.hosts.map((host) => {
          const progressiveHost = currentHosts.get(host.hostId);
          const changed = this.requestChangedHostKeys.has(
            sessionCatalogHostKey(catalog.id, host.hostId),
          );
          return host.error && changed && progressiveHost && !progressiveHost.error
            ? progressiveHost
            : host;
        }),
      };
    });
  }

  get refetching() {
    return this.refetchOwner !== null;
  }

  beginRefetch(active: boolean): symbol | null {
    if (!active) {
      return null;
    }
    const owner = Symbol("session-catalog-refetch");
    this.refetchOwner = owner;
    return owner;
  }

  endRefetch(owner: symbol | null) {
    if (owner !== null && this.refetchOwner === owner) {
      this.refetchOwner = null;
    }
  }

  beginRequest(generation: number): {
    progressId: string;
    progressSequence: number;
    requestOwner: symbol;
  } {
    this.requestGeneration = generation;
    const requestOwner = Symbol("session-catalog-request");
    this.requestOwner = requestOwner;
    this.sawChange = false;
    this.requestChangedHostKeys.clear();
    const progressId = generateUUID();
    const progressSequence = ++this.progressSequence;
    this.progressSequences.set(progressId, progressSequence);
    if (this.progressSequences.size > 8) {
      const oldest = this.progressSequences.keys().next().value;
      if (oldest) {
        this.progressSequences.delete(oldest);
      }
    }
    return { progressId, progressSequence, requestOwner };
  }

  ownsRequest(owner: symbol) {
    return this.requestOwner === owner;
  }

  markFinal(params: {
    catalogs: readonly SessionCatalog[];
    hadCatalogs: boolean;
    previousSnapshot: string;
    progressSequence: number;
  }) {
    this.sawChange =
      params.hadCatalogs && params.previousSnapshot !== sessionCatalogSnapshot(params.catalogs);
    const finalCatalogIds = new Set(params.catalogs.map((catalog) => catalog.id));
    for (const [catalogId, previousHostIds] of this.hostIdsByCatalog) {
      if (finalCatalogIds.has(catalogId)) {
        continue;
      }
      for (const hostId of previousHostIds) {
        this.hostProgressSequences.set(
          sessionCatalogHostKey(catalogId, hostId),
          params.progressSequence,
        );
      }
      this.hostIdsByCatalog.delete(catalogId);
    }
    for (const catalog of params.catalogs) {
      const previousHostIds = this.hostIdsByCatalog.get(catalog.id) ?? new Set<string>();
      const finalHostIds = new Set(catalog.hosts.map((host) => host.hostId));
      for (const hostId of previousHostIds) {
        if (!finalHostIds.has(hostId)) {
          this.hostProgressSequences.set(
            sessionCatalogHostKey(catalog.id, hostId),
            params.progressSequence,
          );
        }
      }
      for (const host of catalog.hosts) {
        if (host.error) {
          continue;
        }
        const key = sessionCatalogHostKey(catalog.id, host.hostId);
        this.hostProgressSequences.set(
          key,
          Math.max(this.hostProgressSequences.get(key) ?? -1, params.progressSequence),
        );
      }
      this.hostIdsByCatalog.set(catalog.id, finalHostIds);
    }
  }

  observePresence(payload: unknown): boolean {
    const presence =
      payload && typeof payload === "object"
        ? (payload as { presence?: unknown }).presence
        : undefined;
    if (!Array.isArray(presence)) {
      return false;
    }
    const states = new Map<string, "connected" | "offline">();
    for (const entry of presence) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const rawId = typeof record.deviceId === "string" ? record.deviceId : record.instanceId;
      const id = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
      const mode = typeof record.mode === "string" ? record.mode.trim().toLowerCase() : "";
      if (!id || mode === "gateway") {
        continue;
      }
      const reason = typeof record.reason === "string" ? record.reason.trim().toLowerCase() : "";
      states.set(id, reason === "disconnect" ? "offline" : "connected");
    }
    const signature = JSON.stringify(
      [...states].toSorted(([left], [right]) => left.localeCompare(right)),
    );
    const previous = this.presenceSignature;
    this.presenceSignature = signature;
    return previous === null ? states.size > 0 : previous !== signature;
  }

  applyHost(params: {
    payload: unknown;
    agentId: string;
    catalogs: SessionCatalog[];
    pageDepths: ReadonlyMap<string, number>;
  }): { catalogs: SessionCatalog[]; catalogId: string } | null {
    if (!isSessionsCatalogHostEvent(params.payload)) {
      return null;
    }
    const event = params.payload;
    if (normalizeAgentId(event.agentId) !== normalizeAgentId(params.agentId)) {
      return null;
    }
    const sequence = this.progressSequences.get(event.progressId);
    const freshHost = event.catalog.hosts[0];
    if (sequence === undefined || !freshHost) {
      return null;
    }
    const hostKey = sessionCatalogHostKey(event.catalog.id, freshHost.hostId);
    if (sequence < (this.hostProgressSequences.get(hostKey) ?? -1)) {
      return null;
    }
    this.hostProgressSequences.set(hostKey, sequence);
    if (this.requestGeneration !== null) {
      this.requestChangedHostKeys.add(hostKey);
    }
    const currentCatalog = params.catalogs.find((catalog) => catalog.id === event.catalog.id);
    let catalogs: SessionCatalog[];
    if (!currentCatalog) {
      catalogs = [...params.catalogs, { ...event.catalog, hosts: [freshHost] }].toSorted(
        (left, right) => left.id.localeCompare(right.id),
      );
    } else {
      const currentHost = currentCatalog.hosts.find((host) => host.hostId === freshHost.hostId);
      const mergedHost =
        (params.pageDepths.get(hostKey) ?? 0) > 0
          ? preserveExpandedCatalogHost(freshHost, currentHost)
          : freshHost;
      const hosts = currentHost
        ? currentCatalog.hosts.map((host) => (host.hostId === freshHost.hostId ? mergedHost : host))
        : [...currentCatalog.hosts, mergedHost];
      catalogs = params.catalogs.map((catalog) =>
        catalog.id === event.catalog.id
          ? {
              ...event.catalog,
              hosts: hosts.toSorted((left, right) => left.label.localeCompare(right.label)),
            }
          : catalog,
      );
    }
    if (sessionCatalogSnapshot(catalogs) === sessionCatalogSnapshot(params.catalogs)) {
      return null;
    }
    this.sawChange = true;
    return { catalogs, catalogId: event.catalog.id };
  }

  schedule(delayMs: number, isConnected: boolean, refresh: () => void) {
    if (document.visibilityState === "hidden" || !isConnected) {
      return;
    }
    this.cancelTimer();
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      refresh();
    }, delayMs);
  }

  requestRefresh(params: {
    visible: boolean;
    connected: boolean;
    generation: number;
    refresh: () => void;
  }) {
    if (!params.visible || !params.connected) {
      return;
    }
    this.cancelTimer();
    if (this.requestGeneration === params.generation) {
      this.refreshPending = true;
      return;
    }
    params.refresh();
  }

  cancelActivation() {
    if (this.activationTimer !== null) {
      globalThis.clearTimeout(this.activationTimer);
      this.activationTimer = null;
    }
  }

  cancelScheduledRefreshes() {
    this.cancelTimer();
    this.cancelActivation();
  }

  scheduleActivation(refresh: () => void) {
    if (this.activationTimer !== null) {
      return;
    }
    // Browsers fire visibilitychange and focus as one foregrounding pair.
    // The short window prevents that pair from triggering two fleet scans.
    this.activationTimer = globalThis.setTimeout(() => {
      this.activationTimer = null;
      refresh();
    }, 50);
  }
}

/** Runs one progressive list/reconciliation cycle without binding it to a Lit element. */
export async function refreshSessionCatalogsLive(params: {
  live: SessionCatalogLiveState;
  client: GatewayBrowserClient;
  agentId: string;
  generation: number;
  revision: number;
  currentGeneration: () => number;
  currentRevision: () => number;
  currentClient: () => GatewayBrowserClient | null;
  catalogs: () => SessionCatalog[];
  pageDepths: ReadonlyMap<string, number>;
  connected: () => boolean;
  applyFinal: (catalogs: SessionCatalog[], revisedCatalogIds: ReadonlySet<string>) => void;
  refresh: () => void;
}) {
  const { live, client, generation, revision } = params;
  if (live.requestGeneration === generation) {
    return;
  }
  const { progressId, progressSequence, requestOwner } = live.beginRequest(generation);
  const hadCatalogs = params.catalogs().length > 0;
  const previousSnapshot = sessionCatalogSnapshot(params.catalogs());
  let refetchOwner: symbol | null = null;
  const requestIsCurrent = () =>
    live.ownsRequest(requestOwner) &&
    generation === params.currentGeneration() &&
    client === params.currentClient();
  const revisionIsCurrent = () => requestIsCurrent() && revision === params.currentRevision();
  try {
    const result = await live.requestList(client, params.agentId, progressId);
    if (!requestIsCurrent()) {
      return;
    }
    refetchOwner = live.beginRefetch(params.pageDepths.size > 0);
    const previousCatalogs = params.catalogs();
    const catalogs = await refetchExpandedSessionCatalogPages({
      catalogs: live.mergeFinal(result.catalogs, previousCatalogs),
      previousCatalogs,
      client,
      agentId: params.agentId,
      pageDepths: params.pageDepths,
      isCurrent: revisionIsCurrent,
    });
    if (!revisionIsCurrent()) {
      return;
    }
    const revisedCatalogIds = new Set([
      ...params.catalogs().map((catalog) => catalog.id),
      ...catalogs.map((catalog) => catalog.id),
    ]);
    params.applyFinal(catalogs, revisedCatalogIds);
    live.markFinal({ catalogs, hadCatalogs, previousSnapshot, progressSequence });
  } catch {
    // A transient poll failure must not collapse already visible or expanded pages.
  } finally {
    live.endRefetch(refetchOwner);
    const ownsRequest = live.ownsRequest(requestOwner);
    if (ownsRequest) {
      live.requestGeneration = null;
    }
    if (ownsRequest && requestIsCurrent() && params.connected()) {
      const pending = live.refreshPending;
      live.refreshPending = false;
      live.schedule(
        pending
          ? 0
          : live.sawChange
            ? SESSION_CATALOG_CHANGED_REFRESH_MS
            : SESSION_CATALOG_STABLE_REFRESH_MS,
        params.connected(),
        params.refresh,
      );
    }
  }
}
