import { GatewayClient, type GatewayClientOptions } from "@openclaw/gateway-client";
import { EventHub } from "./event-hub.js";
import type {
  ConnectableOpenClawTransport,
  GatewayEvent,
  GatewayRequestOptions,
  OpenClawTransport,
} from "./types.js";

// Gateway transport adapter that converts the lower-level GatewayClient into the
// SDK transport interface and replays raw events for late subscribers.
type GatewayClientLike = Pick<GatewayClient, "request" | "stopAndWait">;

const RAW_EVENT_REPLAY_LIMIT = 1000;

/** Explicit SDK projection with its broader identity and callback contracts preserved. */
type GatewayClientTransportOptions = Pick<
  GatewayClientOptions,
  | "url"
  | "connectChallengeTimeoutMs"
  | "preauthHandshakeTimeoutMs"
  | "tickWatchMinIntervalMs"
  | "requestTimeoutMs"
  | "token"
  | "bootstrapToken"
  | "deviceToken"
  | "password"
  | "instanceId"
  | "clientDisplayName"
  | "clientVersion"
  | "platform"
  | "deviceFamily"
  | "role"
  | "scopes"
  | "caps"
  | "commands"
  | "permissions"
  | "pathEnv"
  | "minProtocol"
  | "maxProtocol"
  | "tlsFingerprint"
  | "onConnectError"
  | "onGap"
> & {
  clientName?: string;
  mode?: string;
  deviceIdentity?: unknown;
  onEvent?: (evt: GatewayEvent) => void;
  onHelloOk?: (hello: unknown) => void;
  onReconnectPaused?: (info: unknown) => void;
  onClose?: (code: number, reason: string) => void;
};

function toGatewayEvent(event: unknown): GatewayEvent {
  const record =
    typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};
  const eventName = typeof record.event === "string" ? record.event : "unknown";
  return {
    event: eventName,
    payload: record.payload,
    ...(typeof record.seq === "number" ? { seq: record.seq } : {}),
    ...(record.stateVersion ? { stateVersion: record.stateVersion } : {}),
  };
}

/** Connectable SDK transport backed by @openclaw/gateway-client. */
export class GatewayClientTransport implements ConnectableOpenClawTransport {
  private readonly eventsHub = new EventHub<GatewayEvent>({
    replayLimit: RAW_EVENT_REPLAY_LIMIT,
  });
  private readonly options: GatewayClientTransportOptions;
  private client: GatewayClientLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private rejectPendingConnect: ((error: Error) => void) | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: GatewayClientTransportOptions = {}) {
    this.options = options;
  }

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("gateway transport is closed"));
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.rejectPendingConnect = reject;
      const client = new GatewayClient({
        ...this.options,
        onEvent: (event: unknown) => {
          const normalized = toGatewayEvent(event);
          this.eventsHub.publish(normalized);
          this.options.onEvent?.(normalized);
        },
        onHelloOk: (_hello: unknown) => {
          try {
            this.options.onHelloOk?.(_hello);
          } finally {
            // A retired client's late hello must not settle its replacement's connection.
            if (this.client === client && this.rejectPendingConnect === reject) {
              this.rejectPendingConnect = null;
              resolve();
            }
          }
        },
        onConnectError: (error: Error) => {
          try {
            this.options.onConnectError?.(error);
          } finally {
            // Established reconnects belong to the GatewayClient; only initial failure retires it.
            if (this.client === client && this.rejectPendingConnect === reject) {
              this.client = null;
              this.connectPromise = null;
              this.rejectPendingConnect = null;
              void client.stopAndWait().catch(() => {});
              reject(error);
            }
          }
        },
        onReconnectPaused: (info: unknown) => {
          try {
            this.options.onReconnectPaused?.(info);
          } finally {
            // A terminal reconnect has no retry owner, so future connects need a fresh client.
            if (this.client === client && this.rejectPendingConnect === null) {
              this.client = null;
              this.connectPromise = null;
              void client.stopAndWait().catch(() => {});
            }
          }
        },
        onClose: this.options.onClose,
        onGap: this.options.onGap,
      } as never);

      this.client = client;
      client.start();
    });
    return this.connectPromise;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    await this.connect();
    if (!this.client) {
      throw new Error("gateway transport is not connected");
    }
    return await this.client.request<T>(method, params, options);
  }

  events(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent> {
    return this.eventsHub.stream(filter, { replay: true });
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.eventsHub.close();
    const client = this.client;
    this.client = null;
    const rejectPendingConnect = this.rejectPendingConnect;
    this.rejectPendingConnect = null;
    rejectPendingConnect?.(new Error("gateway transport closed before connect completed"));
    this.connectPromise = null;
    this.closePromise = client?.stopAndWait() ?? Promise.resolve();
    await this.closePromise;
    this.closePromise = null;
  }
}

/** Narrow an SDK transport to one that supports explicit connect. */
export function isConnectableTransport(
  transport: OpenClawTransport,
): transport is ConnectableOpenClawTransport {
  return typeof (transport as { connect?: unknown }).connect === "function";
}
