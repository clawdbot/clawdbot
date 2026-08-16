import { readControlUiBuildMismatchId } from "@openclaw/gateway-client/browser";
import type { ControlUiBootstrapProfileHint } from "../../../src/gateway/control-ui-contract.js";
// Control UI module owns the application gateway store: the reactive
// snapshot around GatewayBrowserClient consumed by the app shell.
import type { EventLogEntry } from "../api/event-log.ts";
import {
  GatewayBrowserClient,
  resolveGatewayErrorDetailCode,
  type GatewayBrowserClientOptions,
  type GatewayEventListener,
  type GatewayHelloOk,
} from "../api/gateway.ts";
import { CONTROL_UI_BUILD_INFO, controlUiBuildDiffersFrom } from "../build-info.ts";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../lib/chat/canvas-widget-frame-generation.ts";
import { formatUiError } from "../lib/format-error.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar.ts";
import { resolveSessionKey } from "../lib/sessions/index.ts";
import { generateUUID } from "../lib/uuid.ts";
import type {
  ApplicationGateway,
  ApplicationGatewayConnectOptions,
  ApplicationGatewayConnection,
  ApplicationGatewaySnapshot,
} from "./context.ts";
import { resolveControlUiAuthHeader } from "./control-ui-auth.ts";
import { loadSettings, patchSettings, persistSessionToken } from "./settings.ts";
import { scheduleStaleChunkReload } from "./stale-chunk-reload.ts";
import { readPresenceEntries, resolveSelfPresenceUser } from "./user-profile.ts";

type GatewayClientFactory = (opts: GatewayBrowserClientOptions) => GatewayBrowserClient;
type CanvasSurfaceLeaseModule = typeof import("./canvas-surface-lease.runtime.ts");
type CanvasSurfaceLease = ReturnType<CanvasSurfaceLeaseModule["createCanvasSurfaceLease"]>;

const defaultClientFactory: GatewayClientFactory = (opts) => new GatewayBrowserClient(opts);
// Grace window before offline presentation appears; reconnects never wait.
const OFFLINE_INDICATOR_DELAY_MS = 2_000;

function notifyGatewayObservers<T>(
  listeners: ReadonlySet<(value: T) => void>,
  value: T,
  errorLabel: string,
  isCurrent?: (value: T) => boolean,
): void {
  // Snapshot membership because callbacks may mutate subscriptions or replace their owner.
  for (const listener of Array.from(listeners)) {
    if (isCurrent && !isCurrent(value)) {
      return;
    }
    try {
      listener(value);
    } catch (error) {
      console.error(`[gateway] ${errorLabel} handler error:`, error);
    }
  }
}

function sameSelfUser(
  left: ApplicationGatewaySnapshot["selfUser"],
  right: ApplicationGatewaySnapshot["selfUser"],
): boolean {
  return (
    left?.id === right?.id &&
    left?.email === right?.email &&
    left?.name === right?.name &&
    left?.avatarUrl === right?.avatarUrl
  );
}

export function createApplicationGateway(
  initialSettings: ReturnType<typeof loadSettings>,
  initialPassword = "",
  initialBootstrapToken = "",
  createClient: GatewayClientFactory = defaultClientFactory,
  options: {
    persistDefaultConnectionSettings?: boolean;
    basePath?: string;
    bootstrapProfile?: ControlUiBootstrapProfileHint;
  } = {},
): ApplicationGateway {
  let settings = initialSettings;
  let persistConnectionSettings = options.persistDefaultConnectionSettings !== false;
  let connection: ApplicationGatewayConnection = {
    gatewayUrl: settings.gatewayUrl,
    token: settings.token,
    bootstrapToken: initialBootstrapToken,
    ...(options.bootstrapProfile ? { bootstrapProfile: options.bootstrapProfile } : {}),
    password: initialPassword,
  };
  let snapshot: ApplicationGatewaySnapshot = {
    client: null,
    phase: "stopped",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: settings.sessionKey,
    lastError: null,
    lastErrorCode: null,
    selfUser: null,
  };
  let client: GatewayBrowserClient | null = null;
  let canvasSurfaceLease: CanvasSurfaceLease | null = null;
  let canvasSurfaceLeaseLoad: Promise<CanvasSurfaceLease> | null = null;
  let canvasSurfaceLeaseClient: GatewayBrowserClient | null = null;
  let canvasSurfaceLeaseStarted = false;
  let canvasSurfaceLeaseGeneration = 0;
  // Session lineage belongs to the selected Gateway: once its hello succeeds,
  // transport drops render as "reconnecting" (shell + banner) instead of
  // kicking the operator back to the login gate.
  let everConnected = false;
  let stopped = true;
  // Snapshot observers can synchronously stop or replace their publishing client.
  const isCurrentClient = (expected: GatewayBrowserClient | null) =>
    !stopped && client === expected;
  let offlineIndicatorTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const eventLogListeners = new Set<(events: readonly EventLogEntry[]) => void>();
  let eventLog: EventLogEntry[] = [];
  const clearOfflineIndicatorTimer = () => {
    if (offlineIndicatorTimer !== null) {
      globalThis.clearTimeout(offlineIndicatorTimer);
      offlineIndicatorTimer = null;
    }
  };
  const scheduleOfflineIndicator = () => {
    if (
      stopped ||
      snapshot.phase === "connected" ||
      snapshot.offlineStable ||
      offlineIndicatorTimer !== null
    ) {
      return;
    }
    offlineIndicatorTimer = globalThis.setTimeout(() => {
      offlineIndicatorTimer = null;
      if (!stopped && snapshot.phase !== "connected") {
        setSnapshot({ ...snapshot, offlineStable: true });
      }
    }, OFFLINE_INDICATOR_DELAY_MS);
  };
  const setSnapshot = (next: ApplicationGatewaySnapshot) => {
    if (next.phase === "connected") {
      clearOfflineIndicatorTimer();
      snapshot = next.offlineStable ? { ...next, offlineStable: false } : next;
    } else {
      snapshot = next;
      scheduleOfflineIndicator();
    }
    notifyGatewayObservers(listeners, snapshot, "snapshot", (current) => current === snapshot);
  };
  const loadCanvasSurfaceLease = (): Promise<CanvasSurfaceLease> => {
    if (canvasSurfaceLease) {
      return Promise.resolve(canvasSurfaceLease);
    }
    if (canvasSurfaceLeaseLoad) {
      return canvasSurfaceLeaseLoad;
    }
    const load = import("./canvas-surface-lease.runtime.ts").then(
      ({ createCanvasSurfaceLease }) => {
        const lease = createCanvasSurfaceLease({
          request: (method, params) => {
            const requestClient = canvasSurfaceLeaseClient;
            if (!requestClient || client !== requestClient) {
              return Promise.reject(
                new Error("canvas surface lease has no current gateway client"),
              );
            }
            return requestClient.request(method, params);
          },
          onChange: (canvasPluginSurfaceUrl) => {
            if (!canvasSurfaceLeaseClient || client !== canvasSurfaceLeaseClient) {
              return;
            }
            setSnapshot({ ...snapshot, canvasPluginSurfaceUrl });
          },
        });
        canvasSurfaceLease = lease;
        return lease;
      },
    );
    canvasSurfaceLeaseLoad = load;
    void load.catch(() => {
      if (canvasSurfaceLeaseLoad === load) {
        canvasSurfaceLeaseLoad = null;
      }
    });
    return load;
  };
  const beginCanvasSurfaceLease = (nextClient: GatewayBrowserClient): number => {
    canvasSurfaceLeaseClient = null;
    canvasSurfaceLease?.stop();
    canvasSurfaceLeaseGeneration += 1;
    canvasSurfaceLeaseStarted = true;
    canvasSurfaceLeaseClient = nextClient;
    // Rotation keeps mounted frames; a new hello starts a connection and must
    // re-key them before the synchronously published URL can render.
    bumpCanvasWidgetFrameConnectionGeneration();
    return canvasSurfaceLeaseGeneration;
  };
  const startCanvasSurfaceLease = (
    nextClient: GatewayBrowserClient,
    expectedGeneration: number,
    helloUrl: string | undefined,
  ): void => {
    void loadCanvasSurfaceLease()
      .then((lease) => {
        if (
          canvasSurfaceLeaseStarted &&
          canvasSurfaceLeaseGeneration === expectedGeneration &&
          canvasSurfaceLeaseClient === nextClient &&
          client === nextClient
        ) {
          lease.start(helloUrl);
        }
      })
      .catch(() => {
        // main.ts owns lazy-chunk fetch recovery through the Vite preload-error
        // listener; retrying the same module URL cannot escape its cached failure.
      });
  };
  const stopCanvasSurfaceLease = () => {
    if (!canvasSurfaceLeaseStarted) {
      canvasSurfaceLeaseClient = null;
      return;
    }
    canvasSurfaceLeaseGeneration += 1;
    canvasSurfaceLeaseStarted = false;
    canvasSurfaceLeaseClient = null;
    canvasSurfaceLease?.stop();
    // Disconnect invalidates every capability URL, including those held by a
    // frame that remounts after the socket closes.
    bumpCanvasWidgetFrameConnectionGeneration();
  };
  const updateSettings = (patch: Partial<typeof settings>, selectGateway = false) => {
    const next = { ...settings, ...patch };
    if (!persistConnectionSettings && !selectGateway) {
      settings = next;
      if (patch.gatewayUrl !== undefined || patch.token !== undefined) {
        persistSessionToken(next.gatewayUrl, next.token);
      }
      return;
    }
    persistConnectionSettings = true;
    settings = patchSettings(patch, { selectGateway });
  };
  const recordGatewayEvent = (event: Parameters<GatewayEventListener>[0]) => {
    const eventClient = client;
    if (event.event === "presence") {
      const entries = readPresenceEntries(event.payload);
      if (entries) {
        const selfUser = resolveSelfPresenceUser(entries, client?.instanceId);
        // A live connection owns its authenticated identity until onClose. Older
        // gateways can omit still-connected clients after presence TTL pruning.
        if (selfUser && !sameSelfUser(snapshot.selfUser, selfUser)) {
          setSnapshot({ ...snapshot, selfUser });
          // A presence observer can replace its client before this event reaches the log.
          if (!isCurrentClient(eventClient)) {
            return;
          }
        }
      }
    }
    eventLog = [{ ts: Date.now(), event: event.event, payload: event.payload }, ...eventLog].slice(
      0,
      250,
    );
    const ownsEventLog = (current: readonly EventLogEntry[]) =>
      current === eventLog && isCurrentClient(eventClient);
    notifyGatewayObservers(eventLogListeners, eventLog, "event", ownsEventLog);
  };

  const connect = (overrides: ApplicationGatewayConnectOptions = {}) => {
    stopped = false;
    const { sessionKey: requestedSessionKey, ...connectionOverrides } = overrides;
    const nextConnection = {
      ...connection,
      ...connectionOverrides,
      ...(connectionOverrides.bootstrapToken !== undefined &&
      connectionOverrides.bootstrapProfile === undefined
        ? { bootstrapProfile: undefined }
        : {}),
    };
    const hasRequestedSessionKey = requestedSessionKey !== undefined;
    const nextSessionKey = hasRequestedSessionKey
      ? requestedSessionKey.trim()
      : snapshot.sessionKey;
    // Only a gateway URL that differs from the current connection counts as an
    // explicit selection. The login gate always resubmits its prefilled URL, so
    // treating any override as a selection would let an ephemeral approval
    // document persist the serving gateway and clobber a saved remote choice.
    const gatewayUrlChanged =
      connectionOverrides.gatewayUrl !== undefined &&
      connectionOverrides.gatewayUrl !== connection.gatewayUrl;
    // A different Gateway has no established session to keep mounted on failure.
    if (gatewayUrlChanged) {
      everConnected = false;
    }
    connection = nextConnection;
    // Trust the connected gateway's origin for avatar route resolution so
    // split-origin Control UI deployments load uploaded/proxied avatars.
    setAvatarGatewayOrigin(
      nextConnection.gatewayUrl,
      resolveControlUiAuthHeader({
        settings: { token: nextConnection.token },
        password: nextConnection.password,
      }),
      options.basePath,
    );
    updateSettings(
      {
        gatewayUrl: nextConnection.gatewayUrl,
        token: nextConnection.token,
        ...(hasRequestedSessionKey
          ? {
              sessionKey: nextSessionKey,
              lastActiveSessionKey: nextSessionKey,
            }
          : {}),
      },
      persistConnectionSettings || gatewayUrlChanged,
    );
    stopCanvasSurfaceLease();
    client?.stop();

    const nextClient = createClient({
      url: nextConnection.gatewayUrl,
      token: nextConnection.token.trim() ? nextConnection.token : undefined,
      bootstrapToken: nextConnection.bootstrapToken.trim()
        ? nextConnection.bootstrapToken
        : undefined,
      bootstrapProfile: nextConnection.bootstrapProfile,
      password: nextConnection.password.trim() ? nextConnection.password : undefined,
      clientName: "openclaw-control-ui",
      clientVersion: CONTROL_UI_BUILD_INFO.version ?? "dev",
      clientBuildId: CONTROL_UI_BUILD_INFO.buildId,
      mode: "webchat",
      instanceId: generateUUID(),
      onHello: (hello: GatewayHelloOk) => {
        if (client !== nextClient) {
          return;
        }
        const exactBuildIdentityAvailable = Boolean(hello.server?.buildId?.trim());
        const controlUiBuildFresh = !(
          isSameOriginGateway(nextConnection.gatewayUrl) &&
          (exactBuildIdentityAvailable || everConnected) &&
          controlUiBuildDiffersFrom({
            version: hello.server?.version,
            buildId: hello.server?.buildId,
            controlUiBuildSource: hello.server?.controlUiBuildSource,
          })
        );
        if (!controlUiBuildFresh) {
          // Keep every connected-only drain fenced. The stale document may
          // render the shell and refresh action, but it must not mutate state.
          setSnapshot({
            ...snapshot,
            client: nextClient,
            phase: "reconnecting",
            hello,
            canvasPluginSurfaceUrl: null,
            selfUser: null,
            lastError: null,
            lastErrorCode: null,
          });
          const targetBuildId = hello.server?.buildId?.trim() || hello.server?.version?.trim();
          if (targetBuildId) {
            void scheduleStaleChunkReload({ buildId: targetBuildId });
          }
          return;
        }
        setAvatarGatewayOrigin(
          nextConnection.gatewayUrl,
          resolveControlUiAuthHeader({
            hello,
            settings: { token: nextConnection.token },
            password: nextConnection.password,
          }),
          options.basePath,
        );
        connection = { ...connection, bootstrapToken: "", bootstrapProfile: undefined };
        if (persistConnectionSettings) {
          settings = loadSettings();
        }
        const sessionDefaults = readSessionDefaults(hello);
        const sessionKey = resolveSessionKey(snapshot.sessionKey, hello);
        const lastActiveSessionKey = resolveSessionKey(settings.lastActiveSessionKey, hello);
        if (
          sessionKey !== settings.sessionKey ||
          lastActiveSessionKey !== settings.lastActiveSessionKey
        ) {
          updateSettings({
            sessionKey,
            lastActiveSessionKey,
          });
        }
        everConnected = true;
        const canvasPluginSurfaceUrl = normalizeCanvasPluginSurfaceUrl(
          hello.pluginSurfaceUrls?.canvas,
        );
        const canvasLeaseGeneration = beginCanvasSurfaceLease(nextClient);
        setSnapshot({
          ...snapshot,
          client: nextClient,
          phase: "connected",
          hello,
          canvasPluginSurfaceUrl,
          // Trim guards a whitespace-only defaultId from becoming a truthy selection.
          assistantAgentId: sessionDefaults?.defaultAgentId?.trim() || null,
          sessionKey,
          lastError: null,
          lastErrorCode: null,
          selfUser: resolveSelfPresenceUser(
            readPresenceEntries(hello.snapshot) ?? [],
            nextClient.instanceId,
          ),
        });
        startCanvasSurfaceLease(
          nextClient,
          canvasLeaseGeneration,
          canvasPluginSurfaceUrl ?? undefined,
        );
      },
      onRecoveryScopeChange: () => {
        if (client !== nextClient || snapshot.phase !== "connected") {
          return;
        }
        setSnapshot({ ...snapshot });
      },
      onClose: ({ code, reason, error, willRetry }) => {
        if (client !== nextClient) {
          return;
        }
        stopCanvasSurfaceLease();
        const mismatchedBuildId = readControlUiBuildMismatchId(error?.details);
        if (mismatchedBuildId) {
          void scheduleStaleChunkReload({ buildId: mismatchedBuildId });
        }
        setSnapshot({
          ...snapshot,
          client: nextClient,
          phase: everConnected
            ? willRetry
              ? "reconnecting"
              : "offline"
            : willRetry
              ? "connecting"
              : "stopped",
          hello: null,
          canvasPluginSurfaceUrl: null,
          selfUser: null,
          lastError: error
            ? formatUiError(error)
            : `disconnected (${code}): ${reason || "no reason"}`,
          lastErrorCode: resolveGatewayErrorDetailCode(error) ?? error?.code ?? null,
        });
      },
      onGap: ({ expected, received }) => {
        if (!isCurrentClient(nextClient)) {
          return;
        }
        setSnapshot({
          ...snapshot,
          lastError: `event gap detected (expected seq ${expected}, got ${received}); reconnecting`,
          lastErrorCode: null,
        });
        if (isCurrentClient(nextClient)) {
          connect();
        }
      },
      onEvent: (event) => {
        // A replaced socket can still deliver queued events; never let it
        // project presence or history into the current gateway connection.
        if (client !== nextClient) {
          return;
        }
        try {
          recordGatewayEvent(event);
        } catch (error) {
          // Preserve protocol-client isolation: a broken log subscriber must
          // not prevent chat, approvals, or the remaining app from updating.
          console.error("[gateway] event handler error:", error);
        }
        const isActiveClient = () => isCurrentClient(nextClient);
        notifyGatewayObservers(eventListeners, event, "event listener", isActiveClient);
      },
    });
    client = nextClient;
    setSnapshot({
      ...snapshot,
      client: nextClient,
      // Keep the shell mounted while a fresh client attempts event-gap
      // recovery or a manual retry when a session already existed.
      phase: everConnected ? "reconnecting" : "connecting",
      hello: null,
      canvasPluginSurfaceUrl: null,
      assistantAgentId: null,
      selfUser: null,
      sessionKey: nextSessionKey,
      lastError: null,
      lastErrorCode: null,
    });
    if (isCurrentClient(nextClient)) {
      nextClient.start();
    }
  };

  const gateway: ApplicationGateway = {
    get snapshot() {
      return snapshot;
    },
    get connection() {
      return connection;
    },
    get eventLog() {
      return eventLog;
    },
    connect,
    setSessionKey: (sessionKey) => {
      const nextSessionKey = sessionKey.trim();
      if (!nextSessionKey || nextSessionKey === snapshot.sessionKey) {
        return;
      }
      updateSettings({
        sessionKey: nextSessionKey,
        lastActiveSessionKey: nextSessionKey,
      });
      setSnapshot({ ...snapshot, sessionKey: nextSessionKey });
    },
    start: () => connect(),
    stop: () => {
      stopped = true;
      clearOfflineIndicatorTimer();
      stopCanvasSurfaceLease();
      client?.stop();
      client = null;
      everConnected = false;
      setSnapshot({
        ...snapshot,
        client: null,
        phase: "stopped",
        offlineStable: false,
        hello: null,
        canvasPluginSurfaceUrl: null,
        assistantAgentId: null,
        selfUser: null,
        lastError: null,
        lastErrorCode: null,
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: (listener) => {
      eventLogListeners.add(listener);
      return () => eventLogListeners.delete(listener);
    },
    subscribeEvents: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    updateSelfUser: (patch) => {
      if (!snapshot.selfUser) {
        return;
      }
      setSnapshot({ ...snapshot, selfUser: { ...snapshot.selfUser, ...patch } });
    },
  };
  return gateway;
}

function isSameOriginGateway(gatewayUrl: string): boolean {
  try {
    return new URL(gatewayUrl.replace(/^ws/u, "http")).origin === globalThis.location?.origin;
  } catch {
    return false;
  }
}

function normalizeCanvasPluginSurfaceUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readSessionDefaults(
  hello: GatewayHelloOk,
): { defaultAgentId?: string | null } | undefined {
  const snapshot = hello.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !("sessionDefaults" in snapshot)) {
    return undefined;
  }
  const defaults = snapshot.sessionDefaults;
  return defaults && typeof defaults === "object"
    ? (defaults as { defaultAgentId?: string | null })
    : undefined;
}
