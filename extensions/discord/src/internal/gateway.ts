import { EventEmitter } from "node:events";
import {
  GatewayCloseCodes,
  GatewayDispatchEvents,
  GatewayIntentBits,
  GatewayOpcodes,
  type APIGatewayBotInfo,
  type GatewayDispatchPayload,
  type GatewayHeartbeat,
  type GatewayIdentify,
  type GatewayPresenceUpdateData,
  type GatewayReceivePayload,
  type GatewaySendPayload,
  type GatewayVoiceStateUpdateData,
} from "discord-api-types/v10";
import * as ws from "ws";
import { Plugin, type Client } from "./client.js";
import { canResumeAfterGatewayClose, isFatalGatewayCloseCode } from "./gateway-close-codes.js";
import { dispatchVoiceGatewayEvent, mapGatewayDispatchData } from "./gateway-dispatch.js";
import { sharedGatewayIdentifyLimiter } from "./gateway-identify-limiter.js";
import { GatewayHeartbeatTimers, GatewayReconnectTimer } from "./gateway-lifecycle.js";
import { GatewaySendLimiter } from "./gateway-rate-limit.js";

export { GatewayCloseCodes };
export const GatewayIntents = GatewayIntentBits;
export type Activity = NonNullable<GatewayPresenceUpdateData["activities"]>[number];
export type UpdatePresenceData = Omit<GatewayPresenceUpdateData, "status"> & {
  status: "online" | "idle" | "dnd" | "invisible" | "offline";
};
export type UpdateVoiceStateData = GatewayVoiceStateUpdateData;
export type RequestGuildMembersData = {
  guild_id: string;
  query?: string;
  limit: number;
  presences?: boolean;
  user_ids?: string | string[];
  nonce?: string;
};
export type GatewayWebSocketLike = ws.WebSocket;

type GatewayPluginOptions = {
  reconnect?: { maxAttempts?: number };
  intents?: number;
  autoInteractions?: boolean;
  shard?: [number, number];
  url?: string;
};

const READY_STATE_OPEN = 1;
const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/";

function ensureGatewayParams(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("v", parsed.searchParams.get("v") ?? "10");
  parsed.searchParams.set("encoding", parsed.searchParams.get("encoding") ?? "json");
  return parsed.toString();
}

function decodeGatewayMessage(incoming: unknown): GatewayReceivePayload | null {
  const text = Buffer.isBuffer(incoming)
    ? incoming.toString("utf8")
    : incoming instanceof ArrayBuffer
      ? Buffer.from(incoming).toString("utf8")
      : Array.isArray(incoming)
        ? Buffer.concat(incoming.map((entry) => Buffer.from(entry))).toString("utf8")
        : String(incoming);
  try {
    return JSON.parse(text) as GatewayReceivePayload;
  } catch {
    return null;
  }
}

export class GatewayPlugin extends Plugin {
  readonly id = "gateway";
  protected client?: Client;
  readonly options: Required<Pick<GatewayPluginOptions, "autoInteractions">> & GatewayPluginOptions;
  public ws: ws.WebSocket | null = null;
  public sequence: number | null = null;
  public lastHeartbeatAck = true;
  public emitter = new EventEmitter();
  public shardId?: number;
  public totalShards?: number;
  protected gatewayInfo?: APIGatewayBotInfo;
  public isConnected = false;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = false;
  private isConnecting = false;
  private readonly heartbeatTimers = new GatewayHeartbeatTimers();
  private readonly reconnectTimer = new GatewayReconnectTimer();
  private outboundLimiter = new GatewaySendLimiter(
    (payload) => this.sendSerializedGatewayEvent(payload),
    (error) => this.emitter.emit("error", error),
  );

  constructor(options: GatewayPluginOptions, gatewayInfo?: APIGatewayBotInfo) {
    super();
    this.options = {
      ...options,
      reconnect: { maxAttempts: 50, ...options.reconnect },
      autoInteractions: options.autoInteractions ?? true,
      intents: options.intents ?? 0,
    };
    this.gatewayInfo = gatewayInfo;
  }

  get ping(): number | null {
    return null;
  }

  get heartbeatInterval(): NodeJS.Timeout | undefined {
    return this.heartbeatTimers.heartbeatInterval;
  }

  set heartbeatInterval(timer: NodeJS.Timeout | undefined) {
    this.heartbeatTimers.heartbeatInterval = timer;
  }

  get firstHeartbeatTimeout(): NodeJS.Timeout | undefined {
    return this.heartbeatTimers.firstHeartbeatTimeout;
  }

  set firstHeartbeatTimeout(timer: NodeJS.Timeout | undefined) {
    this.heartbeatTimers.firstHeartbeatTimeout = timer;
  }

  async registerClient(client: Client): Promise<void> {
    this.client = client;
    if (this.options.shard) {
      client.shardId = this.options.shard[0];
      client.totalShards = this.options.shard[1];
      this.shardId = this.options.shard[0];
      this.totalShards = this.options.shard[1];
    }
    this.shouldReconnect = true;
    this.connect(false);
  }

  connect(resume = false): void {
    this.stopReconnectTimer();
    this.stopHeartbeat();
    if (this.isConnecting) {
      return;
    }
    this.shouldReconnect = true;
    this.lastHeartbeatAck = true;
    this.ws?.close(1000, "Reconnecting");
    const baseUrl =
      resume && this.resumeGatewayUrl
        ? this.resumeGatewayUrl
        : (this.gatewayInfo?.url ?? this.options.url ?? DEFAULT_GATEWAY_URL);
    this.ws = this.createWebSocket(ensureGatewayParams(baseUrl));
    this.isConnecting = true;
    this.isConnected = false;
    this.setupWebSocket(resume);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopReconnectTimer();
    this.stopHeartbeat();
    this.outboundLimiter.clear();
    this.ws?.close(1000, "Client disconnect");
    this.ws = null;
    this.isConnecting = false;
    this.isConnected = false;
    this.reconnectAttempts = 0;
  }

  protected createWebSocket(url: string): ws.WebSocket {
    return new ws.WebSocket(url);
  }

  private setupWebSocket(resume: boolean): void {
    const socket = this.ws;
    if (!socket) {
      return;
    }
    socket.on("open", () => {
      if (socket !== this.ws) {
        return;
      }
      this.isConnecting = false;
      this.emitter.emit("debug", "Gateway websocket opened");
    });
    socket.on("message", (incoming) => {
      if (socket !== this.ws) {
        return;
      }
      const payload = decodeGatewayMessage(incoming);
      if (!payload) {
        this.emitter.emit("error", new Error("Invalid gateway payload"));
        return;
      }
      this.handlePayload(payload, resume);
    });
    socket.on("close", (code) => {
      if (socket !== this.ws) {
        return;
      }
      const closeCode = code as GatewayCloseCodes;
      this.stopHeartbeat();
      this.outboundLimiter.clear();
      this.isConnecting = false;
      this.isConnected = false;
      this.emitter.emit("debug", `Gateway websocket closed: ${code}`);
      if (!this.shouldReconnect) {
        return;
      }
      if (isFatalGatewayCloseCode(closeCode)) {
        this.shouldReconnect = false;
        this.emitter.emit("error", new Error(`Fatal gateway close code: ${code}`));
        return;
      }
      const canResume = canResumeAfterGatewayClose(closeCode);
      if (!canResume) {
        this.resetSessionState();
      }
      this.scheduleReconnect(canResume, closeCode);
    });
    socket.on("error", (error) => {
      if (socket !== this.ws) {
        return;
      }
      this.emitter.emit("error", error);
    });
  }

  private handlePayload(payload: GatewayReceivePayload, resume: boolean): void {
    if (payload.s !== null && payload.s !== undefined) {
      this.sequence = payload.s;
    }
    switch (payload.op) {
      case GatewayOpcodes.Hello:
        this.startHeartbeat(
          (payload.d as { heartbeat_interval?: number }).heartbeat_interval ?? 45_000,
        );
        if (resume && this.sessionId) {
          this.send(
            {
              op: GatewayOpcodes.Resume,
              d: {
                token: this.client?.options.token ?? "",
                session_id: this.sessionId,
                seq: this.sequence ?? 0,
              },
            } as GatewaySendPayload,
            true,
          );
        } else {
          void this.identifyWithConcurrency();
        }
        break;
      case GatewayOpcodes.HeartbeatAck:
        this.lastHeartbeatAck = true;
        break;
      case GatewayOpcodes.Heartbeat:
        this.sendHeartbeat();
        break;
      case GatewayOpcodes.Dispatch:
        void this.handleDispatch(payload).catch((error: unknown) => {
          this.emitter.emit(
            "error",
            error instanceof Error ? error : new Error(String(error), { cause: error }),
          );
        });
        break;
      case GatewayOpcodes.InvalidSession:
        if (!payload.d) {
          this.resetSessionState();
        }
        this.scheduleReconnect(payload.d);
        break;
      case GatewayOpcodes.Reconnect:
        this.scheduleReconnect(true);
        break;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimers.start({
      intervalMs,
      isAcked: () => this.lastHeartbeatAck,
      onHeartbeat: () => this.sendHeartbeat(),
      onAckTimeout: () => {
        this.emitter.emit("error", new Error("Gateway heartbeat ACK timeout"));
        this.scheduleReconnect(true);
      },
    });
  }

  private stopHeartbeat(): void {
    this.heartbeatTimers.stop();
  }

  private stopReconnectTimer(): void {
    this.reconnectTimer.stop();
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) {
      return;
    }
    this.lastHeartbeatAck = false;
    this.send({ op: GatewayOpcodes.Heartbeat, d: this.sequence } as GatewayHeartbeat, true);
  }

  private identify(): void {
    this.send(
      {
        op: GatewayOpcodes.Identify,
        d: {
          token: this.client?.options.token ?? "",
          intents: this.options.intents ?? 0,
          properties: { os: process.platform, browser: "openclaw", device: "openclaw" },
          shard: this.options.shard,
        },
      } as GatewayIdentify,
      true,
    );
  }

  private async identifyWithConcurrency(): Promise<void> {
    await sharedGatewayIdentifyLimiter.wait({
      shardId: this.shardId,
      maxConcurrency: this.gatewayInfo?.session_start_limit.max_concurrency,
    });
    if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) {
      return;
    }
    this.identify();
  }

  send(payload: GatewaySendPayload | GatewayReceivePayload, skipRateLimit = false): void {
    if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) {
      throw new Error("Discord gateway socket is not open");
    }
    const serialized = JSON.stringify(payload);
    this.outboundLimiter.send(serialized, { critical: skipRateLimit });
  }

  private sendSerializedGatewayEvent(serialized: string): void {
    if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) {
      throw new Error("Discord gateway socket is not open");
    }
    this.ws.send(serialized);
  }

  private async handleDispatch(payload: GatewayDispatchPayload): Promise<void> {
    if (!this.client || !payload.t) {
      return;
    }
    if (payload.t === GatewayDispatchEvents.Ready) {
      const ready = payload.d as { session_id?: string; resume_gateway_url?: string };
      this.sessionId = ready.session_id ?? null;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? null;
      this.reconnectAttempts = 0;
      this.isConnected = true;
    }
    if (payload.t === GatewayDispatchEvents.Resumed) {
      this.reconnectAttempts = 0;
      this.isConnected = true;
    }
    dispatchVoiceGatewayEvent(this.client, payload.t, payload.d);
    const data = mapGatewayDispatchData(this.client, payload.t, payload.d);
    await this.client.dispatchGatewayEvent(payload.t, data);
    if (payload.t === GatewayDispatchEvents.InteractionCreate && this.options.autoInteractions) {
      await this.client.handleInteraction(payload.d);
    }
  }

  private resetSessionState(): void {
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.sequence = null;
  }

  private scheduleReconnect(resume: boolean, closeCode?: number): void {
    if (!this.shouldReconnect) {
      return;
    }
    this.stopHeartbeat();
    this.stopReconnectTimer();
    this.ws?.close();
    this.ws = null;
    this.isConnecting = false;
    this.isConnected = false;
    this.outboundLimiter.clear();
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > (this.options.reconnect?.maxAttempts ?? 50)) {
      const maxAttempts = this.options.reconnect?.maxAttempts ?? 50;
      this.emitter.emit(
        "error",
        new Error(
          `Max reconnect attempts (${maxAttempts}) reached${closeCode !== undefined ? ` after close code ${closeCode}` : ""}`,
        ),
      );
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectTimer.schedule(delay, () => {
      this.connect(resume);
    });
  }

  updatePresence(data: UpdatePresenceData): void {
    this.send({ op: GatewayOpcodes.PresenceUpdate, d: data } as GatewaySendPayload);
  }

  updateVoiceState(data: UpdateVoiceStateData): void {
    this.send({ op: GatewayOpcodes.VoiceStateUpdate, d: data } as GatewaySendPayload, true);
  }

  requestGuildMembers(data: RequestGuildMembersData): void {
    this.send({ op: GatewayOpcodes.RequestGuildMembers, d: data } as GatewaySendPayload);
  }

  getRateLimitStatus() {
    return this.outboundLimiter.getStatus();
  }

  getIntentsInfo() {
    const intents = this.options.intents ?? 0;
    return {
      intents,
      hasGuilds: this.hasIntent(GatewayIntentBits.Guilds),
      hasGuildMembers: this.hasIntent(GatewayIntentBits.GuildMembers),
      hasGuildPresences: this.hasIntent(GatewayIntentBits.GuildPresences),
      hasGuildMessages: this.hasIntent(GatewayIntentBits.GuildMessages),
      hasMessageContent: this.hasIntent(GatewayIntentBits.MessageContent),
    };
  }

  hasIntent(intent: number): boolean {
    return Boolean((this.options.intents ?? 0) & intent);
  }
}
