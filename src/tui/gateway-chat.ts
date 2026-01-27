import { randomUUID } from "node:crypto";
import { loadConfig, resolveGatewayPort } from "../config/config.js";
import { GatewayClient } from "../gateway/client.js";
import {
  type HelloOk,
  PROTOCOL_VERSION,
  type SessionsListParams,
  type SessionsPatchParams,
} from "../gateway/protocol/index.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { VERSION } from "../version.js";

export type GatewayConnectionOptions = {
  url?: string;
  token?: string;
  password?: string;
};

export type ChatSendOptions = {
  sessionKey: string;
  message: string;
  thinking?: string;
  deliver?: boolean;
  timeoutMs?: number;
};

export type GatewayEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
};

export type GatewaySessionList = {
  ts: number;
  path: string;
  count: number;
  defaults?: {
    model?: string | null;
    modelProvider?: string | null;
    contextTokens?: number | null;
  };
  sessions: Array<{
    key: string;
    sessionId?: string;
    updatedAt?: number | null;
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    sendPolicy?: string;
    model?: string;
    contextTokens?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    responseUsage?: "on" | "off" | "tokens" | "full";
    modelProvider?: string;
    label?: string;
    displayName?: string;
    provider?: string;
    groupChannel?: string;
    space?: string;
    subject?: string;
    chatType?: string;
    lastProvider?: string;
    lastTo?: string;
    lastAccountId?: string;
    derivedTitle?: string;
    lastMessagePreview?: string;
  }>;
};

export type GatewayAgentsList = {
  defaultId: string;
  mainKey: string;
  scope: "per-sender" | "global";
  agents: Array<{
    id: string;
    name?: string;
  }>;
};

export type GatewayModelChoice = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export class GatewayChatClient {
  private client: GatewayClient;
  private readyPromise: Promise<void>;
  private resolveReady?: () => void;
  readonly connection: { url: string; token?: string; password?: string };
  hello?: HelloOk;

  onEvent?: (evt: GatewayEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  constructor(opts: GatewayConnectionOptions) {
    const resolved = resolveGatewayConnection(opts);
    this.connection = resolved;

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.client = new GatewayClient({
      url: resolved.url,
      token: resolved.token,
      password: resolved.password,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "moltbot-tui",
      clientVersion: VERSION,
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.UI,
      instanceId: randomUUID(),
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onHelloOk: (hello) => {
        this.hello = hello;
        this.resolveReady?.();
        this.onConnected?.();
      },
      onEvent: (evt) => {
        this.onEvent?.({
          event: evt.event,
          payload: evt.payload,
          seq: evt.seq,
        });
      },
      onClose: (_code, reason) => {
        this.onDisconnected?.(reason);
      },
      onGap: (info) => {
        this.onGap?.(info);
      },
    });
  }

  start() {
    this.client.start();
  }

  stop() {
    this.client.stop();
  }

  async waitForReady() {
    await this.readyPromise;
  }

  async sendChat(opts: ChatSendOptions): Promise<{ runId: string }> {
    const runId = randomUUID();
    await this.client.request("chat.send", {
      sessionKey: opts.sessionKey,
      message: opts.message,
      thinking: opts.thinking,
      deliver: opts.deliver,
      timeoutMs: opts.timeoutMs,
      idempotencyKey: runId,
    });
    return { runId };
  }

  async abortChat(opts: { sessionKey: string; runId: string }) {
    return await this.client.request<{ ok: boolean; aborted: boolean }>("chat.abort", {
      sessionKey: opts.sessionKey,
      runId: opts.runId,
    });
  }

  async loadHistory(opts: { sessionKey: string; limit?: number }) {
    return await this.client.request("chat.history", {
      sessionKey: opts.sessionKey,
      limit: opts.limit,
    });
  }

  async listSessions(opts?: SessionsListParams) {
    return await this.client.request<GatewaySessionList>("sessions.list", {
      limit: opts?.limit,
      activeMinutes: opts?.activeMinutes,
      includeGlobal: opts?.includeGlobal,
      includeUnknown: opts?.includeUnknown,
      includeDerivedTitles: opts?.includeDerivedTitles,
      includeLastMessage: opts?.includeLastMessage,
      agentId: opts?.agentId,
    });
  }

  async listAgents() {
    return await this.client.request<GatewayAgentsList>("agents.list", {});
  }

  async patchSession(opts: SessionsPatchParams) {
    return await this.client.request("sessions.patch", opts);
  }

  async resetSession(key: string) {
    return await this.client.request("sessions.reset", { key });
  }

  async getStatus() {
    return await this.client.request("status");
  }

  async listModels(): Promise<GatewayModelChoice[]> {
    const res = await this.client.request<{ models?: GatewayModelChoice[] }>("models.list");
    return Array.isArray(res?.models) ? res.models : [];
  }
}

export function resolveGatewayConnection(opts: GatewayConnectionOptions) {
  const config = loadConfig();
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const authToken = config.gateway?.auth?.token;

  const localPort = resolveGatewayPort(config);
  const url =
    (typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : undefined) ||
    (typeof remote?.url === "string" && remote.url.trim().length > 0
      ? remote.url.trim()
      : undefined) ||
    `ws://127.0.0.1:${localPort}`;

  const token =
    (typeof opts.token === "string" && opts.token.trim().length > 0
      ? opts.token.trim()
      : undefined) ||
    (isRemoteMode
      ? typeof remote?.token === "string" && remote.token.trim().length > 0
        ? remote.token.trim()
        : undefined
      : process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
        (typeof authToken === "string" && authToken.trim().length > 0
          ? authToken.trim()
          : undefined));

  const password =
    (typeof opts.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined) ||
    process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
    (typeof remote?.password === "string" && remote.password.trim().length > 0
      ? remote.password.trim()
      : undefined);

  return { url, token, password };
}
