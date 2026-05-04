import type { SlackChannelResolution } from "../resolve-channels.js";
import type { SlackUserResolution } from "../resolve-users.js";
import { formatUnknownError, waitForSlackSocketDisconnect } from "./reconnect-policy.js";

type SlackAppConstructor = typeof import("@slack/bolt").App;
type SlackHttpReceiverConstructor = typeof import("@slack/bolt").HTTPReceiver;
type SlackSocketModeReceiverConstructor = typeof import("@slack/bolt").SocketModeReceiver;
type SlackSocketModeReceiverOptions = ConstructorParameters<SlackSocketModeReceiverConstructor>[0];
type SlackSocketModeConfig = Pick<
  SlackSocketModeReceiverOptions,
  "clientPingTimeout" | "serverPingTimeout" | "pingPongLoggingEnabled"
>;
type SlackSdkLogger = NonNullable<SlackSocketModeReceiverOptions["logger"]>;
type SlackSdkLogLevel = ReturnType<SlackSdkLogger["getLevel"]>;

const OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS = 15_000;
const SLACK_SOCKET_PONG_TIMEOUT_WARNING_PREFIX = "A pong wasn't received from the server";
const SLACK_SOCKET_LOG_LEVEL_IGNORED_WARNING_RE =
  /^The logLevel given to .+ was ignored as you also gave logger$/;

export type SlackBoltResolvedExports = {
  App: SlackAppConstructor;
  HTTPReceiver: SlackHttpReceiverConstructor;
  SocketModeReceiver: SlackSocketModeReceiverConstructor;
};

type SlackSocketShutdownClient = {
  shuttingDown?: boolean;
};
type Constructor = abstract new (...args: never[]) => unknown;
type SlackSelfFilterArgs = {
  context?: {
    botId?: string;
    botUserId?: string;
  };
  event?: unknown;
  message?: unknown;
};

function isConstructorFunction<
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Constructor guard preserves the requested concrete Slack constructor type.
  T extends Constructor,
>(value: unknown): value is T {
  return typeof value === "function";
}

function resolveSlackBoltModule(value: unknown): SlackBoltResolvedExports | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const app = Reflect.get(value, "App");
  const httpReceiver = Reflect.get(value, "HTTPReceiver");
  const socketModeReceiver = Reflect.get(value, "SocketModeReceiver");
  if (
    !isConstructorFunction<SlackAppConstructor>(app) ||
    !isConstructorFunction<SlackHttpReceiverConstructor>(httpReceiver) ||
    !isConstructorFunction<SlackSocketModeReceiverConstructor>(socketModeReceiver)
  ) {
    return null;
  }
  return {
    App: app,
    HTTPReceiver: httpReceiver,
    SocketModeReceiver: socketModeReceiver,
  };
}

export function resolveSlackBoltInterop(params: {
  defaultImport: unknown;
  namespaceImport: unknown;
}): SlackBoltResolvedExports {
  const { defaultImport, namespaceImport } = params;
  const nestedDefault =
    defaultImport && typeof defaultImport === "object"
      ? Reflect.get(defaultImport, "default")
      : undefined;
  const namespaceDefault =
    namespaceImport && typeof namespaceImport === "object"
      ? Reflect.get(namespaceImport, "default")
      : undefined;
  const namespaceReceiver =
    namespaceImport && typeof namespaceImport === "object"
      ? Reflect.get(namespaceImport, "HTTPReceiver")
      : undefined;
  const namespaceSocketModeReceiver =
    namespaceImport && typeof namespaceImport === "object"
      ? Reflect.get(namespaceImport, "SocketModeReceiver")
      : undefined;
  const directModule =
    resolveSlackBoltModule(defaultImport) ??
    resolveSlackBoltModule(nestedDefault) ??
    resolveSlackBoltModule(namespaceDefault) ??
    resolveSlackBoltModule(namespaceImport);
  if (directModule) {
    return directModule;
  }
  if (
    isConstructorFunction<SlackAppConstructor>(defaultImport) &&
    isConstructorFunction<SlackHttpReceiverConstructor>(namespaceReceiver) &&
    isConstructorFunction<SlackSocketModeReceiverConstructor>(namespaceSocketModeReceiver)
  ) {
    return {
      App: defaultImport,
      HTTPReceiver: namespaceReceiver,
      SocketModeReceiver: namespaceSocketModeReceiver,
    };
  }
  throw new TypeError("Unable to resolve @slack/bolt App/HTTPReceiver exports");
}

export function publishSlackConnectedStatus(setStatus?: (next: Record<string, unknown>) => void) {
  if (!setStatus) {
    return;
  }
  const now = Date.now();
  setStatus({
    connected: true,
    lastConnectedAt: now,
    healthState: "healthy",
    lastError: null,
  });
}

export function publishSlackDisconnectedStatus(
  setStatus?: (next: Record<string, unknown>) => void,
  error?: unknown,
) {
  if (!setStatus) {
    return;
  }
  const at = Date.now();
  const message = error ? formatUnknownError(error) : undefined;
  setStatus({
    connected: false,
    healthState: "disconnected",
    lastDisconnect: message ? { at, error: message } : { at },
    lastError: message ?? null,
  });
}

function isSlackSocketPongTimeoutWarning(args: readonly unknown[]) {
  return (
    typeof args[0] === "string" && args[0].startsWith(SLACK_SOCKET_PONG_TIMEOUT_WARNING_PREFIX)
  );
}

function isSlackSocketSelfInflictedLoggerWarning(args: readonly unknown[]) {
  return typeof args[0] === "string" && SLACK_SOCKET_LOG_LEVEL_IGNORED_WARNING_RE.test(args[0]);
}

export function createSlackSocketModeLogger(
  sink: Pick<typeof console, "debug" | "info" | "warn" | "error"> = console,
): SlackSdkLogger {
  let level = "info" as SlackSdkLogLevel;
  let name = "socket-mode";
  const prefix = () => `socket-mode:${name}`;
  return {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      if (isSlackSocketPongTimeoutWarning(args) || isSlackSocketSelfInflictedLoggerWarning(args)) {
        return;
      }
      sink.warn(prefix(), ...args);
    },
    error: (...args: unknown[]) => sink.error(prefix(), ...args),
    setLevel: (nextLevel) => {
      level = nextLevel;
    },
    getLevel: () => level,
    setName: (nextName) => {
      name = nextName;
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function shouldSkipOpenClawSlackSelfEvent(args: SlackSelfFilterArgs): boolean {
  const botId = args.context?.botId;
  const botUserId = args.context?.botUserId;
  const message = asRecord(args.message);
  if (message?.subtype === "bot_message" && botId && message.bot_id === botId) {
    return true;
  }

  const event = asRecord(args.event);
  if (
    event?.type === "message" &&
    event.subtype === "message_changed" &&
    event.user === botUserId
  ) {
    return false;
  }

  const eventsWhichShouldBeKept = new Set(["member_joined_channel", "member_left_channel"]);
  return Boolean(
    botUserId &&
    event &&
    event.user === botUserId &&
    typeof event.type === "string" &&
    !eventsWhichShouldBeKept.has(event.type),
  );
}

export function createSlackBoltApp(params: {
  interop: SlackBoltResolvedExports;
  slackMode: "socket" | "http";
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  slackWebhookPath: string;
  clientOptions: Record<string, unknown>;
  socketMode?: SlackSocketModeConfig;
}) {
  const socketModeReceiverOptions: SlackSocketModeReceiverOptions = {
    appToken: params.appToken ?? "",
    autoReconnectEnabled: false,
    clientPingTimeout:
      params.socketMode?.clientPingTimeout ?? OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS,
    logger: createSlackSocketModeLogger(),
    installerOptions: {
      clientOptions: params.clientOptions,
    },
  };
  if (params.socketMode?.serverPingTimeout !== undefined) {
    socketModeReceiverOptions.serverPingTimeout = params.socketMode.serverPingTimeout;
  }
  if (params.socketMode?.pingPongLoggingEnabled !== undefined) {
    socketModeReceiverOptions.pingPongLoggingEnabled = params.socketMode.pingPongLoggingEnabled;
  }

  const receiver =
    params.slackMode === "socket"
      ? new params.interop.SocketModeReceiver(socketModeReceiverOptions)
      : new params.interop.HTTPReceiver({
          signingSecret: params.signingSecret ?? "",
          endpoints: params.slackWebhookPath,
        });
  const app = new params.interop.App({
    token: params.botToken,
    receiver,
    clientOptions: params.clientOptions,
    ignoreSelf: false,
    // Bolt eagerly starts an auth.test promise in the constructor when token
    // verification is enabled. Invalid tokens can reject before any listener
    // consumes that promise, tripping OpenClaw's fatal unhandled-rejection path.
    tokenVerificationEnabled: false,
  });
  app.use(async (args) => {
    if (shouldSkipOpenClawSlackSelfEvent(args)) {
      return;
    }
    await args.next();
  });
  return { app, receiver };
}

export function createSlackSocketDisconnectWaiter(app: unknown, abortSignal?: AbortSignal) {
  const waiterAbortController = new AbortController();
  const relayAbort = () => waiterAbortController.abort();
  abortSignal?.addEventListener("abort", relayAbort, { once: true });
  return {
    promise: waitForSlackSocketDisconnect(app, waiterAbortController.signal),
    cancel: () => {
      waiterAbortController.abort();
      abortSignal?.removeEventListener("abort", relayAbort);
    },
    complete: () => {
      abortSignal?.removeEventListener("abort", relayAbort);
    },
  };
}

export async function startSlackSocketAndWaitForDisconnect(params: {
  app: { start: () => unknown };
  abortSignal?: AbortSignal;
  onStarted?: () => void;
}) {
  const disconnectWaiter = createSlackSocketDisconnectWaiter(params.app, params.abortSignal);
  try {
    await Promise.resolve(params.app.start());
    if (params.abortSignal?.aborted) {
      disconnectWaiter.cancel();
      return null;
    }
    params.onStarted?.();
    const disconnect = await disconnectWaiter.promise;
    disconnectWaiter.complete();
    return disconnect;
  } catch (err) {
    disconnectWaiter.cancel();
    throw err;
  }
}

export function resolveSlackSocketShutdownClient(
  app: unknown,
): SlackSocketShutdownClient | undefined {
  if (!app || typeof app !== "object") {
    return undefined;
  }
  const receiver = Reflect.get(app, "receiver");
  if (!receiver || typeof receiver !== "object") {
    return undefined;
  }
  const client = Reflect.get(receiver, "client");
  if (!client || typeof client !== "object") {
    return undefined;
  }
  return client as SlackSocketShutdownClient;
}

export async function gracefulStopSlackApp(app: { stop: () => unknown }) {
  const socketClient = resolveSlackSocketShutdownClient(app);
  if (socketClient) {
    socketClient.shuttingDown = true;
  }
  await Promise.resolve(app.stop()).catch(() => undefined);
}

function formatSlackResolvedLabel(params: {
  input: string;
  id: string;
  name?: string;
  extra?: string[];
}): string {
  const extras = params.extra?.filter(Boolean) ?? [];
  const suffix =
    extras.length > 0 ? ` (id:${params.id}, ${extras.join(", ")})` : ` (id:${params.id})`;
  return `${params.input}→${params.name ?? params.id}${suffix}`;
}

export function formatSlackChannelResolved(entry: SlackChannelResolution): string {
  const id = entry.id ?? entry.input;
  return formatSlackResolvedLabel({
    input: entry.input,
    id,
    name: entry.name,
    extra: entry.archived ? ["archived"] : [],
  });
}

export function formatSlackUserResolved(entry: SlackUserResolution): string {
  const id = entry.id ?? entry.input;
  return formatSlackResolvedLabel({
    input: entry.input,
    id,
    name: entry.name,
    extra: entry.note ? [entry.note] : [],
  });
}
