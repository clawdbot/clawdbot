import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import { ConnectErrorDetailCodes } from "../../../src/gateway/protocol/connect-error-details.js";
import {
  CHAT_SESSIONS_ACTIVE_MINUTES,
  CHAT_SESSIONS_REFRESH_LIMIT,
  clearPendingQueueItemsForRun,
  flushChatQueueForEvent,
  refreshChatAvatar,
} from "./app-chat.ts";
import type { EventLogEntry } from "./app-events.ts";
import {
  applySettings,
  loadCron,
  refreshActiveTab,
  setLastActiveSessionKey,
  syncUrlWithSessionKey,
} from "./app-settings.ts";
import { handleAgentEvent, resetToolStream, type AgentEventPayload } from "./app-tool-stream.ts";
import { shouldReloadHistoryForFinalEvent } from "./chat-event-reload.ts";
import { parseChatSideResult, type ChatSideResult } from "./chat/side-result.ts";
import { formatConnectError } from "./connect-error.ts";
import { recordControlUiRpcTiming } from "./control-ui-performance.ts";
import { loadAgents, type AgentsState } from "./controllers/agents.ts";
import {
  loadAssistantIdentity,
  type AssistantIdentityState,
} from "./controllers/assistant-identity.ts";
import {
  loadChatHistory,
  handleChatEvent,
  type ChatEventPayload,
  type ChatState,
} from "./controllers/chat.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import { loadDevices, type DevicesState } from "./controllers/devices.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  parsePluginApprovalRequested,
  pruneExecApprovalQueue,
  removeExecApproval,
} from "./controllers/exec-approval.ts";
import { loadHealthState, type HealthState } from "./controllers/health.ts";
import {
  applySessionsChangedEvent,
  loadSessions,
  subscribeSessions,
  type SessionsState,
} from "./controllers/sessions.ts";
import {
  resolveGatewayErrorDetailCode,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "./gateway.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import { buildAgentMainSessionKey, normalizeAgentId, parseAgentSessionKey } from "./session-key.ts";
import type { UiSettings } from "./storage.ts";
import type {
  AgentsListResult,
  PresenceEntry,
  HealthSummary,
  StatusSummary,
  UpdateAvailable,
} from "./types.ts";

function isGenericBrowserFetchFailure(message: string): boolean {
  return /^(?:typeerror:\s*)?(?:fetch failed|failed to fetch)$/i.test(message.trim());
}

type GatewayHost = {
  settings: UiSettings;
  password: string;
  clientInstanceId: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  lastErrorCode: string | null;
  onboarding?: boolean;
  eventLogBuffer: EventLogEntry[];
  eventLog: EventLogEntry[];
  tab: Tab;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: StatusSummary | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  healthLoading: boolean;
  healthResult: HealthSummary | null;
  healthError: string | null;
  debugHealth: HealthSummary | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  pendingUpdateExpectedVersion: string | null;
  updateStatusBanner: { tone: "danger" | "warn" | "info"; text: string } | null;
  sessionKey: string;
  chatRunId: string | null;
  pendingAbort?: { runId?: string | null; sessionKey: string } | null;
  refreshSessionsAfterChat: Set<string>;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalError: string | null;
  updateAvailable: UpdateAvailable | null;
  reconcileWebPushState?: () => Promise<void> | void;
  sessionsChangedReloadTimer?: number | ReturnType<typeof globalThis.setTimeout> | null;
};

type GatewayHostWithDeferredSessionMessageReload = GatewayHost & {
  pendingSessionMessageReloadSessionKey?: string | null;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

type GatewayHostWithShutdownMessage = GatewayHost & {
  pendingShutdownMessage?: string | null;
  resumeChatQueueAfterReconnect?: boolean;
};

type GatewayHostWithSideResults = GatewayHost & {
  chatSideResult?: ChatSideResult | null;
  chatSideResultTerminalRuns?: Set<string>;
};

const SESSIONS_CHANGED_RELOAD_DEBOUNCE_MS = 5_000;

function enqueueApprovalRequest(host: GatewayHost, entry: ExecApprovalRequest | null) {
  if (!entry) {
    return;
  }
  host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
  host.execApprovalError = null;
  const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
  window.setTimeout(() => {
    host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
  }, delay);
}

function removeResolvedApprovalRequest(host: GatewayHost, payload: unknown) {
  const resolved = parseExecApprovalResolved(payload);
  if (resolved) {
    host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
  }
}

function isTerminalChatState(
  state: ChatEventPayload["state"] | ReturnType<typeof handleChatEvent> | null | undefined,
): state is "final" | "aborted" | "error" {
  return state === "final" || state === "aborted" || state === "error";
}

function isChatTurnSessionChangedPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as { phase?: unknown; reason?: unknown };
  return (
    record.phase === "start" ||
    record.phase === "message" ||
    record.phase === "end" ||
    record.phase === "error" ||
    record.reason === "send" ||
    record.reason === "steer"
  );
}

function clearSessionsChangedReloadTimer(host: GatewayHost) {
  if (host.sessionsChangedReloadTimer == null) {
    return;
  }
  globalThis.clearTimeout(host.sessionsChangedReloadTimer);
  host.sessionsChangedReloadTimer = null;
}

function shouldRunDeferredSessionsReload(host: GatewayHost): boolean {
  return host.connected && Boolean(host.client) && host.tab !== "chat";
}

function scheduleSessionsChangedReload(host: GatewayHost) {
  clearSessionsChangedReloadTimer(host);
  host.sessionsChangedReloadTimer = globalThis.setTimeout(() => {
    host.sessionsChangedReloadTimer = null;
    if (!shouldRunDeferredSessionsReload(host)) {
      return;
    }
    void loadSessions(host as unknown as SessionsState);
  }, SESSIONS_CHANGED_RELOAD_DEBOUNCE_MS);
}

type ConnectGatewayOptions = {
  reason?: "initial" | "seq-gap";
};

type UpdateRestartStatusResponse = {
  sentinel?: {
    kind?: string;
    status?: string;
    stats?: {
      reason?: string | null;
      after?: { version?: string | null } | null;
    } | null;
  } | null;
};

function resolveUpdateVerificationBanner(params: {
  expectedVersion: string;
  actualVersion: string | null;
}): { tone: "danger"; text: string } {
  const actualSuffix = params.actualVersion
    ? ` Expected v${params.expectedVersion}, running v${params.actualVersion}.`
    : "";
  return {
    tone: "danger",
    text: `Update installed but running version did not change — restart may have been blocked.${actualSuffix}`,
  };
}

function resolvePostRestartUpdateBanner(reason: string | null | undefined): {
  tone: "danger";
  text: string;
} {
  const normalizedReason = reason?.trim() || "restart-unhealthy";
  const guidance =
    normalizedReason === "restart-unhealthy"
      ? "The replacement process never became healthy and the previous process stayed up."
      : "Check the gateway logs for the replacement failure.";
  return {
    tone: "danger",
    text: `Update error: ${normalizedReason}. ${guidance}`,
  };
}

async function verifyPendingUpdateVersion(
  host: GatewayHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const expectedVersion = host.pendingUpdateExpectedVersion?.trim();
  if (!expectedVersion) {
    return;
  }
  const deadline = Date.now() + 10_000;
  while (host.client === client && host.connected && Date.now() < deadline) {
    let response: UpdateRestartStatusResponse | null = null;
    try {
      response = await client.request<UpdateRestartStatusResponse>("update.status", {});
    } catch {
      response = null;
    }
    const sentinel = response?.sentinel;
    const actualVersion = sentinel?.stats?.after?.version?.trim() || null;
    if (sentinel?.kind === "update" && actualVersion) {
      host.pendingUpdateExpectedVersion = null;
      if (sentinel.status && sentinel.status !== "ok") {
        host.updateStatusBanner = resolvePostRestartUpdateBanner(sentinel.stats?.reason ?? null);
        return;
      }
      if (actualVersion !== expectedVersion) {
        host.updateStatusBanner = resolveUpdateVerificationBanner({
          expectedVersion,
          actualVersion,
        });
      }
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  if (host.client !== client || !host.connected) {
    return;
  }
  const currentVersion = host.hello?.server?.version?.trim() || null;
  host.pendingUpdateExpectedVersion = null;
  if (currentVersion !== expectedVersion) {
    host.updateStatusBanner = resolveUpdateVerificationBanner({
      expectedVersion,
      actualVersion: currentVersion,
    });
  }
}

export function resolveControlUiClientVersion(params: {
  gatewayUrl: string;
  serverVersion: string | null;
  pageUrl?: string;
}): string | undefined {
  const serverVersion = params.serverVersion?.trim();
  if (!serverVersion) {
    return undefined;
  }
  const pageUrl =
    params.pageUrl ?? (typeof window === "undefined" ? undefined : window.location.href);
  if (!pageUrl) {
    return undefined;
  }
  try {
    const page = new URL(pageUrl);
    const gateway = new URL(params.gatewayUrl, page);
    const allowedProtocols = new Set(["ws:", "wss:", "http:", "https:"]);
    if (!allowedProtocols.has(gateway.protocol) || !isSameControlUiVersionEndpoint(page, gateway)) {
      return undefined;
    }
    return serverVersion;
  } catch {
    return undefined;
  }
}

function isSameControlUiVersionEndpoint(page: URL, gateway: URL): boolean {
  if (gateway.host === page.host) {
    return true;
  }
  return (
    isLoopbackHostname(page.hostname) &&
    isLoopbackHostname(gateway.hostname) &&
    resolveUrlEffectivePort(page) === resolveUrlEffectivePort(gateway)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function resolveUrlEffectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  switch (url.protocol) {
    case "http:":
    case "ws:":
      return "80";
    case "https:":
    case "wss:":
      return "443";
    default:
      return "";
  }
}

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) {
    return raw;
  }
  if (!raw) {
    return mainSessionKey;
  }
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) {
    return;
  }

  // Detect if user has already selected a specific session (not an alias like "main").
  // If normalization doesn't change the value, it's a user-selected session.
  const normalizedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const isUserSelectedSession = normalizedSessionKey === host.sessionKey;

  if (isUserSelectedSession) {
    // User has selected a specific session; preserve their choice
    // Only normalize lastActiveSessionKey, don't override current sessionKey
    const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
      host.settings.lastActiveSessionKey,
      defaults,
    );
    if (resolvedLastActiveSessionKey !== host.settings.lastActiveSessionKey) {
      applySettings(host as unknown as Parameters<typeof applySettings>[0], {
        ...host.settings,
        lastActiveSessionKey: resolvedLastActiveSessionKey,
      });
    }
    return; // Keep user's session selection
  }
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  const nextSessionKey = resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

function resolveMainSessionFallback(host: GatewayHost): string {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const configuredMainKey =
    snapshot?.sessionDefaults?.mainKey?.trim() || host.agentsList?.mainKey?.trim();
  if (configuredMainKey && parseAgentSessionKey(configuredMainKey)) {
    return configuredMainKey;
  }
  const defaultAgentId = host.agentsList?.defaultId?.trim() || "main";
  return buildAgentMainSessionKey({
    agentId: defaultAgentId,
    mainKey: configuredMainKey,
  });
}

function fallbackUnconfiguredSessionSelection(host: GatewayHost) {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (!parsed) {
    return;
  }
  const configuredAgentIds = new Set(
    (host.agentsList?.agents ?? []).map((entry) => normalizeAgentId(entry.id)),
  );
  if (configuredAgentIds.size === 0 || configuredAgentIds.has(normalizeAgentId(parsed.agentId))) {
    return;
  }
  const nextSessionKey = resolveMainSessionFallback(host);
  host.sessionKey = nextSessionKey;
  applySettings(host as unknown as Parameters<typeof applySettings>[0], {
    ...host.settings,
    sessionKey: nextSessionKey,
    lastActiveSessionKey: nextSessionKey,
  });
  syncUrlWithSessionKey(
    host as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
    nextSessionKey,
    true,
  );
}

async function loadAgentsThenRefreshActiveTab(host: GatewayHost) {
  try {
    await loadAgents(host as unknown as AgentsState);
    fallbackUnconfiguredSessionSelection(host);
  } finally {
    await refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
  }
}

export function connectGateway(host: GatewayHost, options?: ConnectGatewayOptions) {
  const shutdownHost = host as GatewayHostWithShutdownMessage;
  const reconnectReason = options?.reason ?? "initial";
  shutdownHost.pendingShutdownMessage = null;
  shutdownHost.resumeChatQueueAfterReconnect = false;
  clearSessionsChangedReloadTimer(host);
  host.lastError = null;
  host.lastErrorCode = null;
  host.hello = null;
  host.connected = false;
  if (reconnectReason === "seq-gap") {
    host.execApprovalQueue = pruneExecApprovalQueue(host.execApprovalQueue);
    clearPendingQueueItemsForRun(
      host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
      host.chatRunId ?? undefined,
    );
    shutdownHost.resumeChatQueueAfterReconnect = true;
  } else {
    host.execApprovalQueue = pruneExecApprovalQueue(host.execApprovalQueue);
  }
  host.execApprovalError = null;

  const previousClient = host.client;
  const clientVersion = resolveControlUiClientVersion({
    gatewayUrl: host.settings.gatewayUrl,
    serverVersion: host.serverVersion,
  });
  const client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: host.settings.token.trim() ? host.settings.token : undefined,
    password: host.password.trim() ? host.password : undefined,
    clientName: "openclaw-control-ui",
    clientVersion,
    mode: "webchat",
    instanceId: host.clientInstanceId,
    onHello: (hello) => {
      if (host.client !== client) {
        return;
      }
      shutdownHost.pendingShutdownMessage = null;
      host.connected = true;
      host.lastError = null;
      host.lastErrorCode = null;
      host.hello = hello;
      applySnapshot(host, hello);
      void loadControlUiBootstrapConfig(
        host as unknown as Parameters<typeof loadControlUiBootstrapConfig>[0],
        { applyIdentity: false },
      );
      // Process any pending abort from before the disconnect.
      if (host.pendingAbort) {
        const abort = host.pendingAbort;
        host.pendingAbort = null;
        void host.client
          .request(
            "chat.abort",
            abort.runId
              ? { sessionKey: abort.sessionKey, runId: abort.runId }
              : { sessionKey: abort.sessionKey },
          )
          .catch((err) => {
            // Log to console for diagnostics; user sees no feedback for a stale abort
            // since the run likely completed during the disconnect window anyway.
            console.warn("[openclaw] pending abort failed:", err);
          });
      }
      // Reset orphaned chat run state from before disconnect.
      // Any in-flight run's final event was lost during the disconnect window.
      host.chatRunId = null;
      (host as unknown as { chatStream: string | null }).chatStream = null;
      (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt = null;
      (host as GatewayHostWithSideResults).chatSideResultTerminalRuns?.clear();
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      if (shutdownHost.resumeChatQueueAfterReconnect) {
        // The interrupted run will never emit its terminal event now that the
        // old client is gone, so resume any deferred commands after hello.
        shutdownHost.resumeChatQueueAfterReconnect = false;
        void flushChatQueueForEvent(
          host as unknown as Parameters<typeof flushChatQueueForEvent>[0],
        );
      }
      void subscribeSessions(host as unknown as SessionsState);
      void loadAssistantIdentity(host as unknown as AssistantIdentityState);
      if (host.tab !== "chat") {
        void refreshChatAvatar(host as unknown as Parameters<typeof refreshChatAvatar>[0]);
      }
      void loadHealthState(host as unknown as HealthState);
      void loadAgentsThenRefreshActiveTab(host);
      // Re-run push reconciliation now that the gateway client is available.
      void host.reconcileWebPushState?.();
      void verifyPendingUpdateVersion(host, client);
    },
    onClose: ({ code, reason, error }) => {
      if (host.client !== client) {
        return;
      }
      host.connected = false;
      clearSessionsChangedReloadTimer(host);
      // Code 1012 = Service Restart (expected during config saves, don't show as error)
      host.lastErrorCode =
        resolveGatewayErrorDetailCode(error) ??
        (typeof error?.code === "string" ? error.code : null);
      if (code !== 1012) {
        if (error?.message) {
          host.lastError =
            host.lastErrorCode &&
            (host.lastErrorCode === ConnectErrorDetailCodes.PAIRING_REQUIRED ||
              isGenericBrowserFetchFailure(error.message))
              ? formatConnectError({
                  message: error.message,
                  details: error.details,
                  code: error.code,
                } as Parameters<typeof formatConnectError>[0])
              : error.message;
          return;
        }
        host.lastError =
          shutdownHost.pendingShutdownMessage ?? `disconnected (${code}): ${reason || "no reason"}`;
      } else {
        host.lastError = shutdownHost.pendingShutdownMessage ?? null;
        host.lastErrorCode = null;
      }
    },
    onEvent: (evt) => {
      if (host.client !== client) {
        return;
      }
      handleGatewayEvent(host, evt);
    },
    onRequestTiming: (timing) => {
      if (host.client !== client) {
        return;
      }
      recordControlUiRpcTiming(host, timing);
    },
    onGap: ({ expected, received }) => {
      if (host.client !== client) {
        return;
      }
      host.lastError = `event gap detected (expected seq ${expected}, got ${received}); reconnecting`;
      host.lastErrorCode = null;
      connectGateway(host, { reason: "seq-gap" });
    },
  });
  host.client = client;
  previousClient?.stop();
  client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleTerminalChatEvent(
  host: GatewayHost,
  payload: ChatEventPayload | undefined,
  state: ReturnType<typeof handleChatEvent>,
  activeRunIdBeforeEvent: string | null,
): boolean {
  if (state !== "final" && state !== "error" && state !== "aborted") {
    return false;
  }
  if (isEventForDifferentActiveRun(payload, activeRunIdBeforeEvent)) {
    return false;
  }
  // Check if tool events were seen before resetting (resetToolStream clears toolStreamOrder).
  const toolHost = host as unknown as Parameters<typeof resetToolStream>[0];
  const hadToolEvents = toolHost.toolStreamOrder.length > 0;
  const flushQueue = () =>
    void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
  clearPendingQueueItemsForRun(
    host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
    payload?.runId,
  );
  const runId = payload?.runId;
  if (runId && host.refreshSessionsAfterChat.has(runId)) {
    host.refreshSessionsAfterChat.delete(runId);
    if (state === "final") {
      void loadSessions(host as unknown as SessionsState, {
        activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
        agentId: resolveChatEventSessionListAgentId(host, payload),
        limit: CHAT_SESSIONS_REFRESH_LIMIT,
      });
    }
  }
  // Reload history when tools were used so the persisted tool results
  // replace the now-cleared streaming state.
  if (hadToolEvents && state === "final") {
    const completedRunId = runId ?? null;
    void loadChatHistory(host as unknown as ChatState).finally(() => {
      if (completedRunId && host.chatRunId && host.chatRunId !== completedRunId) {
        return;
      }
      resetToolStream(toolHost);
      flushQueue();
    });
    return true;
  }
  resetToolStream(toolHost);
  flushQueue();
  return false;
}

function isEventForDifferentActiveRun(
  payload: ChatEventPayload | undefined,
  activeRunId: string | null,
): boolean {
  return Boolean(activeRunId && payload && payload.runId !== activeRunId);
}

function resolveChatEventSessionListAgentId(
  host: GatewayHost,
  payload: ChatEventPayload | undefined,
): string {
  const sessionKey = payload?.sessionKey?.trim() || host.sessionKey;
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  return normalizeAgentId(snapshot?.sessionDefaults?.defaultAgentId);
}

function handleChatGatewayEvent(host: GatewayHost, payload: ChatEventPayload | undefined) {
  if (payload?.sessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      payload.sessionKey,
    );
  }
  const sideResultHost = host as GatewayHostWithSideResults;
  const isTrackedSideResultTerminalEvent =
    isTerminalChatState(payload?.state) &&
    typeof payload?.runId === "string" &&
    sideResultHost.chatSideResultTerminalRuns?.has(payload.runId) === true;
  if (isTrackedSideResultTerminalEvent && payload?.runId) {
    sideResultHost.chatSideResultTerminalRuns?.delete(payload.runId);
    return;
  }
  const activeRunIdBeforeEvent = host.chatRunId;
  const state = handleChatEvent(host as unknown as ChatState, payload);
  const terminalEventIsForDifferentActiveRun = isEventForDifferentActiveRun(
    payload,
    activeRunIdBeforeEvent,
  );
  const historyReloaded = handleTerminalChatEvent(host, payload, state, activeRunIdBeforeEvent);
  const deferredReloadHost = host as GatewayHostWithDeferredSessionMessageReload;
  const deferredSessionKey = deferredReloadHost.pendingSessionMessageReloadSessionKey?.trim();
  const payloadSessionKey = payload?.sessionKey?.trim();
  const finalEventNeedsHistoryReload =
    state === "final" && shouldReloadHistoryForFinalEvent(payload);
  const shouldResolveDeferredSessionMessageReload = Boolean(
    deferredSessionKey &&
    payloadSessionKey &&
    deferredSessionKey === payloadSessionKey &&
    isTerminalChatState(state) &&
    !terminalEventIsForDifferentActiveRun &&
    payloadSessionKey === host.sessionKey &&
    !host.chatRunId,
  );
  const shouldReplayDeferredSessionMessageReload =
    shouldResolveDeferredSessionMessageReload &&
    (state !== "final" || finalEventNeedsHistoryReload);
  if (shouldResolveDeferredSessionMessageReload) {
    deferredReloadHost.pendingSessionMessageReloadSessionKey = null;
  }
  if (finalEventNeedsHistoryReload && !historyReloaded && !terminalEventIsForDifferentActiveRun) {
    void loadChatHistory(host as unknown as ChatState);
    return;
  }
  if (shouldReplayDeferredSessionMessageReload && !historyReloaded) {
    void loadChatHistory(host as unknown as ChatState);
  }
}

function handleSessionMessageGatewayEvent(
  host: GatewayHost,
  payload: { sessionKey?: string } | undefined,
) {
  applySessionsChangedEvent(host as unknown as SessionsState, payload);
  const deferredReloadHost = host as GatewayHostWithDeferredSessionMessageReload;
  const sessionKey = payload?.sessionKey?.trim();
  if (!sessionKey || sessionKey !== host.sessionKey) {
    return;
  }
  // Skip history reload while a chat run is active. The chat event handler
  // manages streaming state and appends the final assistant message. Reloading
  // history mid-run races with the optimistic user-message update and resets
  // chatStream, which delays the user message card from appearing until the
  // first LLM delta arrives.
  if (host.chatRunId) {
    deferredReloadHost.pendingSessionMessageReloadSessionKey = sessionKey;
    return;
  }
  deferredReloadHost.pendingSessionMessageReloadSessionKey = null;
  void loadChatHistory(host as unknown as ChatState);
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  host.eventLogBuffer = [
    { ts: Date.now(), event: evt.event, payload: evt.payload },
    ...host.eventLogBuffer,
  ].slice(0, 250);
  if (host.tab === "debug" || host.tab === "overview") {
    host.eventLog = host.eventLogBuffer;
  }

  if (evt.event === "agent") {
    if (host.onboarding) {
      return;
    }
    handleAgentEvent(
      host as unknown as Parameters<typeof handleAgentEvent>[0],
      evt.payload as AgentEventPayload | undefined,
    );
    return;
  }

  if (evt.event === "chat") {
    handleChatGatewayEvent(host, evt.payload as ChatEventPayload | undefined);
    return;
  }

  if (evt.event === "chat.side_result") {
    const sideResult = parseChatSideResult(evt.payload);
    if (!sideResult || sideResult.sessionKey !== host.sessionKey) {
      return;
    }
    const sideResultHost = host as GatewayHostWithSideResults;
    sideResultHost.chatSideResult = sideResult;
    sideResultHost.chatSideResultTerminalRuns?.add(sideResult.runId);
    return;
  }

  if (evt.event === "session.message") {
    handleSessionMessageGatewayEvent(host, evt.payload as { sessionKey?: string } | undefined);
    return;
  }

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      host.presenceEntries = payload.presence;
      host.presenceError = null;
      host.presenceStatus = null;
    }
    return;
  }

  if (evt.event === "shutdown") {
    const payload = evt.payload as { reason?: unknown; restartExpectedMs?: unknown } | undefined;
    const reason =
      payload && typeof payload.reason === "string" && payload.reason.trim()
        ? payload.reason.trim()
        : "gateway stopping";
    const shutdownMessage =
      typeof payload?.restartExpectedMs === "number"
        ? `Restarting: ${reason}`
        : `Disconnected: ${reason}`;
    (host as GatewayHostWithShutdownMessage).pendingShutdownMessage = shutdownMessage;
    host.lastError = shutdownMessage;
    host.lastErrorCode = null;
    return;
  }

  if (evt.event === "sessions.changed") {
    const result = applySessionsChangedEvent(host as unknown as SessionsState, evt.payload);
    if (result.applied || isChatTurnSessionChangedPayload(evt.payload)) {
      return;
    }
    scheduleSessionsChangedReload(host);
    return;
  }

  if (evt.event === "cron" && host.tab === "cron") {
    void loadCron(host as unknown as Parameters<typeof loadCron>[0]);
  }

  if (evt.event === "device.pair.requested" || evt.event === "device.pair.resolved") {
    void loadDevices(host as unknown as DevicesState, { quiet: true });
  }

  if (evt.event === "exec.approval.requested") {
    enqueueApprovalRequest(host, parseExecApprovalRequested(evt.payload));
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    removeResolvedApprovalRequest(host, evt.payload);
    return;
  }

  if (evt.event === "plugin.approval.requested") {
    enqueueApprovalRequest(host, parsePluginApprovalRequested(evt.payload));
    return;
  }

  if (evt.event === "plugin.approval.resolved") {
    removeResolvedApprovalRequest(host, evt.payload);
    return;
  }

  if (evt.event === GATEWAY_EVENT_UPDATE_AVAILABLE) {
    const payload = evt.payload as GatewayUpdateAvailableEventPayload | undefined;
    host.updateAvailable = payload?.updateAvailable ?? null;
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
        presence?: PresenceEntry[];
        health?: HealthSummary;
        sessionDefaults?: SessionDefaultsSnapshot;
        updateAvailable?: UpdateAvailable;
      }
    | undefined;
  if (snapshot?.presence && Array.isArray(snapshot.presence)) {
    host.presenceEntries = snapshot.presence;
  }
  if (snapshot?.health) {
    host.debugHealth = snapshot.health;
    host.healthResult = snapshot.health;
  }
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
  host.updateAvailable = snapshot?.updateAvailable ?? null;
}
