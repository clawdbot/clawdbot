import { GatewayClient } from "../../../src/gateway/client.js";
import { EventHub } from "./event-hub.js";
import type {
  ConnectableOpenClawTransport,
  GatewayEvent,
  GatewayRequestOptions,
  OpenClawTransport,
} from "./types.js";

type GatewayClientLike = {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T>;
  stopAndWait(): Promise<void>;
};

const RAW_EVENT_REPLAY_LIMIT = 1000;

export type GatewayClientTransportOptions = {
  url?: string;
  connectChallengeTimeoutMs?: number;
  connectDelayMs?: number;
  preauthHandshakeTimeoutMs?: number;
  tickWatchMinIntervalMs?: number;
  requestTimeoutMs?: number;
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
  instanceId?: string;
  clientName?: string;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  deviceFamily?: string;
  mode?: string;
  role?: string;
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  deviceIdentity?: unknown;
  minProtocol?: number;
  maxProtocol?: number;
  tlsFingerprint?: string;
  onEvent?: (evt: GatewayEvent) => void;
  onHelloOk?: (hello: unknown) => void;
  onConnectError?: (err: Error) => void;
  onReconnectPaused?: (info: unknown) => void;
  onClose?: (code: number, reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;
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

export class GatewayClientTransport implements ConnectableOpenClawTransport {
  private readonly eventsHub = new EventHub<GatewayEvent>({
    replayLimit: RAW_EVENT_REPLAY_LIMIT,
  });
  private readonly options: GatewayClientTransportOptions;
  private client: GatewayClientLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: GatewayClientTransportOptions = {}) {
    this.options = options;
  }

  connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const client = new GatewayClient({
        ...this.options,
        onEvent: (event: unknown) => {
          const normalized = toGatewayEvent(event);
          this.eventsHub.publish(normalized);
          this.options.onEvent?.(normalized);
        },
        onHelloOk: (_hello: unknown) => {
          this.options.onHelloOk?.(_hello);
          resolve();
        },
        onConnectError: (error: Error) => {
          this.options.onConnectError?.(error);
          if (this.client === client) {
            this.client = null;
          }
          if (this.connectPromise) {
            this.connectPromise = null;
          }
          void client.stopAndWait().catch(() => {});
          reject(error);
        },
        onReconnectPaused: this.options.onReconnectPaused,
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
    this.eventsHub.close();
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    this.closePromise = client?.stopAndWait() ?? Promise.resolve();
    await this.closePromise;
    this.closePromise = null;
  }
}

export function isConnectableTransport(
  transport: OpenClawTransport,
): transport is ConnectableOpenClawTransport {
  return typeof (transport as { connect?: unknown }).connect === "function";
}
