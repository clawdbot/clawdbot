import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalog,
  SessionsCatalogHostEvent,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
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

function sessionCatalogMaterialSnapshot(catalogs: readonly SessionCatalog[]): string {
  // Fast follow-up polls cover catalog/host/session identity sets, labels, connectivity,
  // and session title/status. Ordering and recency timestamps cannot pin the 5s cadence.
  return JSON.stringify(
    catalogs
      .map((catalog) => ({
        id: catalog.id,
        label: catalog.label,
        hosts: catalog.hosts
          .map((host) => ({
            hostId: host.hostId,
            label: host.label,
            connected: host.connected,
            errorCode: host.error?.code,
            sessions: host.sessions
              .map((session) => ({
                threadId: session.threadId,
                name: session.name,
                status: session.status,
                archived: session.archived,
              }))
              .toSorted((left, right) => left.threadId.localeCompare(right.threadId)),
          }))
          .toSorted((left, right) => left.hostId.localeCompare(right.hostId)),
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  );
}

export function sessionCatalogListClient(
  snapshot: ApplicationGatewaySnapshot | undefined,
  connected: boolean,
): GatewayBrowserClient | null {
  if (
    !connected ||
    snapshot?.phase !== "connected" ||
    !snapshot.client ||
    isGatewayMethodAdvertised(snapshot, "sessions.catalog.list") !== true
  ) {
    return null;
  }
  return snapshot.client;
}

function isLegacyProgressIdRejection(error: unknown): boolean {
  if (!(error instanceof GatewayRequestError) || error.gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("progressid") &&
    /(?:unexpected|unknown|unrecognized) property|additional propert(?:y|ies)/.test(message)
  );
}

function isSessionsCatalogHostEvent(value: unknown): value is SessionsCatalogHostEvent {
  const event = asNullableRecord(value);
  const catalog = asNullableRecord(event?.catalog);
  const hosts = Array.isArray(catalog?.hosts) ? catalog.hosts : [];
  const host = asNullableRecord(hosts[0]);
  return Boolean(
    event &&
    catalog &&
    host &&
    typeof event.progressId === "string" &&
    event.progressId.length > 0 &&
    typeof event.agentId === "string" &&
    event.agentId.length > 0 &&
    typeof catalog.id === "string" &&
    typeof catalog.label === "string" &&
    catalog.capabilities !== null &&
    typeof catalog.capabilities === "object" &&
    hosts.length === 1 &&
    typeof host.hostId === "string" &&
    Array.isArray(host.sessions),
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
  private knownHostKeys = new Set<string>();
  private readonly requestChangedHostKeys = new Set<string>();
  private readonly warnedRequestErrors = new Set<string>();
  private requestOwner: symbol | null = null;

  cancelTimer(timer: "timer" | "activationTimer" = "timer") {
    const handle = this[timer];
    if (handle !== null) {
      globalThis.clearTimeout(handle);
      this[timer] = null;
    }
  }

  clear() {
    this.cancelScheduledRefreshes();
    this.requestGeneration = null;
    this.requestOwner = null;
    this.progressSequences.clear();
    this.hostProgressSequences.clear();
    this.knownHostKeys.clear();
    this.requestChangedHostKeys.clear();
    this.presenceSignature = null;
    this.sawChange = false;
    this.refreshPending = false;
    this.refetchOwner = null;
  }

  resetConnection() {
    this.retireConnection(true);
  }

  retireConnection(reset = false): void {
    this.clear();
    if (reset) {
      this.connectionEpoch += 1;
      this.progressive = true;
    }
  }

  async requestList(
    client: GatewayBrowserClient,
    agentId: string,
    progressId: string,
  ): Promise<SessionsCatalogListResult> {
    const connectionEpoch = this.connectionEpoch;
    const baseParams = { agentId, limitPerHost: 40 };
    let progressive = this.progressive;
    let result: SessionsCatalogListResult;
    try {
      result = await client.request("sessions.catalog.list", {
        ...baseParams,
        ...(progressive ? { progressId } : {}),
      });
    } catch (error) {
      if (!progressive || !isLegacyProgressIdRejection(error)) {
        throw error;
      }
      // Older Gateways advertise the list method but reject the additive field.
      // Retry once without streaming, then keep that connection on final pages.
      result = await client.request("sessions.catalog.list", baseParams);
      progressive = false;
    }
    if (connectionEpoch === this.connectionEpoch) {
      this.progressive = progressive;
    }
    return result;
  }

  mergeFinal(catalogs: SessionCatalog[], currentCatalogs: readonly SessionCatalog[]) {
    const currentHosts = new Map(
      currentCatalogs.flatMap((catalog) =>
        catalog.hosts.map(
          (host) => [sessionCatalogHostKey(catalog.id, host.hostId), host] as const,
        ),
      ),
    );
    return catalogs.map((catalog) => ({
      ...catalog,
      hosts: catalog.hosts.map((host) => {
        const hostKey = sessionCatalogHostKey(catalog.id, host.hostId);
        const progressiveHost = currentHosts.get(hostKey);
        return host.error &&
          this.requestChangedHostKeys.has(hostKey) &&
          progressiveHost &&
          !progressiveHost.error
          ? progressiveHost
          : host;
      }),
    }));
  }

  get refetching() {
    return this.refetchOwner !== null;
  }

  get hasRequested() {
    return this.progressSequence > 0;
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

  warnRequestError(error: unknown) {
    const code = error instanceof GatewayRequestError ? error.gatewayCode : "UNAVAILABLE";
    const message = formatUiError(error);
    const signature = `${code}\u0000${message}`;
    if (this.warnedRequestErrors.has(signature)) {
      return;
    }
    this.warnedRequestErrors.add(signature);
    console.warn("Session catalog refresh failed", error);
  }

  markFinal(params: {
    catalogs: readonly SessionCatalog[];
    hadCatalogs: boolean;
    previousMaterialSnapshot: string;
    progressSequence: number;
  }) {
    this.sawChange =
      params.hadCatalogs &&
      (this.sawChange ||
        params.previousMaterialSnapshot !== sessionCatalogMaterialSnapshot(params.catalogs));
    const finalHostKeys = new Set<string>();
    for (const catalog of params.catalogs) {
      for (const host of catalog.hosts) {
        const key = sessionCatalogHostKey(catalog.id, host.hostId);
        finalHostKeys.add(key);
        if (host.error) {
          continue;
        }
        this.hostProgressSequences.set(
          key,
          Math.max(this.hostProgressSequences.get(key) ?? -1, params.progressSequence),
        );
      }
    }
    for (const hostKey of this.knownHostKeys) {
      if (!finalHostKeys.has(hostKey)) {
        this.hostProgressSequences.set(hostKey, params.progressSequence);
      }
    }
    this.knownHostKeys = finalHostKeys;
  }

  observePresence(payload: unknown): boolean {
    const presence = asNullableRecord(payload)?.presence;
    if (!Array.isArray(presence)) {
      return false;
    }
    const states = new Map<string, "connected" | "offline">();
    for (const entry of presence) {
      const record = asNullableRecord(entry);
      if (!record) {
        continue;
      }
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
  }): { catalogs: SessionCatalog[]; catalogId: string; materialChange: boolean } | null {
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
    let nextCatalog: SessionCatalog;
    if (!currentCatalog) {
      nextCatalog = { ...event.catalog, hosts: [freshHost] };
      catalogs = [...params.catalogs, nextCatalog].toSorted((left, right) =>
        left.id.localeCompare(right.id),
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
      nextCatalog = {
        ...event.catalog,
        hosts: hosts.toSorted((left, right) => left.label.localeCompare(right.label)),
      };
      catalogs = params.catalogs.map((catalog) =>
        catalog.id === event.catalog.id ? nextCatalog : catalog,
      );
    }
    const currentHost = currentCatalog?.hosts.find((host) => host.hostId === freshHost.hostId);
    const nextHost = nextCatalog.hosts.find((host) => host.hostId === freshHost.hostId);
    const sameCatalogMetadata =
      currentCatalog !== undefined &&
      currentCatalog.label === nextCatalog.label &&
      JSON.stringify(currentCatalog.capabilities) === JSON.stringify(nextCatalog.capabilities) &&
      JSON.stringify(currentCatalog.error) === JSON.stringify(nextCatalog.error);
    if (sameCatalogMetadata && JSON.stringify(currentHost) === JSON.stringify(nextHost)) {
      return null;
    }
    const materialChange =
      !currentCatalog ||
      !currentHost ||
      !nextHost ||
      sessionCatalogMaterialSnapshot([{ ...nextCatalog, hosts: [nextHost] }]) !==
        sessionCatalogMaterialSnapshot([{ ...currentCatalog, hosts: [currentHost] }]);
    this.sawChange ||= materialChange;
    return { catalogs, catalogId: event.catalog.id, materialChange };
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
    this.cancelTimer("activationTimer");
  }

  cancelScheduledRefreshes() {
    this.cancelTimer();
    this.cancelActivation();
  }

  scheduleActivation(refresh: () => void) {
    if (this.activationTimer !== null) {
      return;
    }
    // Presence, host updates, visibilitychange, and focus arrive in activation bursts.
    // One short window keeps the burst to a single fleet scan.
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
  applyError: (error: unknown) => void;
  refresh: () => void;
}) {
  const { live, client, generation, revision } = params;
  if (live.requestGeneration === generation) {
    return;
  }
  const { progressId, progressSequence, requestOwner } = live.beginRequest(generation);
  const hadCatalogs = params.catalogs().length > 0;
  const previousMaterialSnapshot = sessionCatalogMaterialSnapshot(params.catalogs());
  let refetchOwner: symbol | null = null;
  const requestIsCurrent = () =>
    live.ownsRequest(requestOwner) &&
    generation === params.currentGeneration() &&
    client === params.currentClient();
  const revisionIsCurrent = () => requestIsCurrent() && revision === params.currentRevision();
  try {
    const result = await live.requestList(client, params.agentId, progressId);
    if (!requestIsCurrent() || !result?.catalogs) {
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
    params.applyFinal(
      catalogs,
      new Set([...params.catalogs(), ...catalogs].map((catalog) => catalog.id)),
    );
    live.markFinal({ catalogs, hadCatalogs, previousMaterialSnapshot, progressSequence });
  } catch (error) {
    // A transient poll failure must not collapse already visible or expanded pages.
    if (revisionIsCurrent()) {
      live.warnRequestError(error);
      params.applyError(error);
    }
  } finally {
    live.endRefetch(refetchOwner);
    const ownsRequest = live.ownsRequest(requestOwner);
    if (ownsRequest) {
      live.requestGeneration = null;
    }
    if (ownsRequest && requestIsCurrent() && params.connected()) {
      const delayMs = live.refreshPending
        ? 0
        : live.sawChange
          ? SESSION_CATALOG_CHANGED_REFRESH_MS
          : SESSION_CATALOG_STABLE_REFRESH_MS;
      live.refreshPending = false;
      live.schedule(delayMs, params.connected(), params.refresh);
    }
  }
}
