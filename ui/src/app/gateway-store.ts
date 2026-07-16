// Control UI module owns the application gateway store: the reactive
// snapshot around GatewayBrowserClient consumed by the app shell.
import type { EventLogEntry } from "../api/event-log.ts";
import {
  GatewayBrowserClient,
  type GatewayBrowserClientOptions,
  type GatewayEventListener,
  type GatewayHelloOk,
} from "../api/gateway.ts";
import { resolveSessionKey } from "../lib/sessions/index.ts";
import { generateUUID } from "../lib/uuid.ts";
import type {
  ApplicationGateway,
  ApplicationGatewayConnectOptions,
  ApplicationGatewayConnection,
  ApplicationGatewaySnapshot,
} from "./context.ts";
import { loadSettings, patchSettings, persistSessionToken } from "./settings.ts";

type GatewayClientFactory = (opts: GatewayBrowserClientOptions) => GatewayBrowserClient;

const defaultClientFactory: GatewayClientFactory = (opts) => new GatewayBrowserClient(opts);

export function createApplicationGateway(
  initialSettings: ReturnType<typeof loadSettings>,
  initialPassword = "",
  initialBootstrapToken = "",
  createClient: GatewayClientFactory = defaultClientFactory,
  options: { persistDefaultConnectionSettings?: boolean } = {},
): ApplicationGateway {
  let settings = initialSettings;
  let persistConnectionSettings = options.persistDefaultConnectionSettings !== false;
  let connection: ApplicationGatewayConnection = {
    gatewayUrl: settings.gatewayUrl,
    token: settings.token,
    bootstrapToken: initialBootstrapToken,
    password: initialPassword,
  };
  let snapshot: ApplicationGatewaySnapshot = {
    client: null,
    connected: false,
    reconnecting: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: settings.sessionKey,
    lastError: null,
    lastErrorCode: null,
  };
  let client: GatewayBrowserClient | null = null;
  // Session lineage for this page lifetime: once a hello succeeded, later
  // transport drops render as "reconnecting" (shell + banner) instead of
  // kicking the operator back to the login gate.
  let everConnected = false;
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const eventLogListeners = new Set<(events: readonly EventLogEntry[]) => void>();
  let eventLog: EventLogEntry[] = [];
  let stopClientEvents: (() => void) | undefined;
  const syncClientEvents = (nextClient: GatewayBrowserClient | null) => {
    stopClientEvents?.();
    stopClientEvents = undefined;
    if (!nextClient || eventListeners.size === 0) {
      return;
    }
    const removers = [...eventListeners].map((listener) => nextClient.addEventListener(listener));
    stopClientEvents = () => {
      for (const remove of removers) {
        remove();
      }
    };
  };
  const notify = () => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  const setSnapshot = (next: ApplicationGatewaySnapshot) => {
    snapshot = next;
    notify();
  };
  const publishEventLog = () => {
    for (const listener of eventLogListeners) {
      listener(eventLog);
    }
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
    eventLog = [{ ts: Date.now(), event: event.event, payload: event.payload }, ...eventLog].slice(
      0,
      250,
    );
    publishEventLog();
  };

  const connect = (overrides: ApplicationGatewayConnectOptions = {}) => {
    const { sessionKey: requestedSessionKey, ...connectionOverrides } = overrides;
    const nextConnection = { ...connection, ...connectionOverrides };
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
    connection = nextConnection;
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
    client?.stop();
    stopClientEvents?.();
    stopClientEvents = undefined;

    const nextClient = createClient({
      url: nextConnection.gatewayUrl,
      token: nextConnection.token.trim() ? nextConnection.token : undefined,
      bootstrapToken: nextConnection.bootstrapToken.trim()
        ? nextConnection.bootstrapToken
        : undefined,
      password: nextConnection.password.trim() ? nextConnection.password : undefined,
      clientName: "openclaw-control-ui",
      clientVersion: "dev",
      mode: "webchat",
      instanceId: generateUUID(),
      onHello: (hello: GatewayHelloOk) => {
        if (client !== nextClient) {
          return;
        }
        connection = { ...connection, bootstrapToken: "" };
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
        setSnapshot({
          ...snapshot,
          client: nextClient,
          connected: true,
          reconnecting: false,
          hello,
          assistantAgentId: sessionDefaults?.defaultAgentId ?? "main",
          sessionKey,
          lastError: null,
          lastErrorCode: null,
        });
      },
      onRecoveryScopeChange: () => {
        if (client !== nextClient || !snapshot.connected) {
          return;
        }
        setSnapshot({ ...snapshot });
      },
      onClose: ({ code, reason, error, willRetry }) => {
        if (client !== nextClient) {
          return;
        }
        setSnapshot({
          ...snapshot,
          client: nextClient,
          connected: false,
          reconnecting: everConnected && willRetry,
          hello: null,
          lastError: error?.message ?? `disconnected (${code}): ${reason || "no reason"}`,
          lastErrorCode: error?.code ?? null,
        });
      },
      onGap: ({ expected, received }) => {
        if (client !== nextClient) {
          return;
        }
        setSnapshot({
          ...snapshot,
          lastError: `event gap detected (expected seq ${expected}, got ${received}); reconnecting`,
          lastErrorCode: null,
        });
        connect();
      },
      onEvent: recordGatewayEvent,
    });
    client = nextClient;
    syncClientEvents(nextClient);
    setSnapshot({
      ...snapshot,
      client: nextClient,
      connected: false,
      // Keep the shell mounted while a fresh client attempts (event-gap
      // recovery, banner "retry now") when a session already existed.
      reconnecting: everConnected,
      hello: null,
      sessionKey: nextSessionKey,
      lastError: null,
      lastErrorCode: null,
    });
    nextClient.start();
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
      stopClientEvents?.();
      stopClientEvents = undefined;
      client?.stop();
      client = null;
      everConnected = false;
      setSnapshot({
        ...snapshot,
        client: null,
        connected: false,
        reconnecting: false,
        hello: null,
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
      syncClientEvents(client);
      return () => {
        if (eventListeners.delete(listener)) {
          syncClientEvents(client);
        }
      };
    },
  };
  return gateway;
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
