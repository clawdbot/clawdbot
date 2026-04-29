import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { VERSION } from "../version.js";
import type {
  ApprovalDecision,
  ApprovalKind,
  ChatHistoryResult,
  ClaudeChannelMode,
  ClaudePermissionRequest,
  ConversationDescriptor,
  PendingApproval,
  QueueEvent,
  SessionListResult,
  SessionMessagePayload,
  WaitFilter,
} from "./channel-shared.js";
import { matchEventFilter, normalizeApprovalId, toConversation, toText } from "./channel-shared.js";

type PendingWaiter = {
  filter: WaitFilter;
  resolve: (value: QueueEvent | null) => void;
  timeout: NodeJS.Timeout | null;
};

type ServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

const CLAUDE_PERMISSION_REPLY_RE = /^(yes|no)\s+([a-km-z]{5})$/i;
const QUEUE_LIMIT = 1_000;

export class OpenClawChannelBridge {
  private gateway: GatewayClient | null = null;
  private readonly verbose: boolean;
  private readonly claudeChannelMode: ClaudeChannelMode;
  private readonly queue: QueueEvent[] = [];
  private readonly pendingWaiters = new Set<PendingWaiter>();
  private readonly pendingClaudePermissions = new Map<string, ClaudePermissionRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private server: McpServer | null = null;
  private cursor = 0;
  private closed = false;
  private ready = false;
  private started = false;
  private retryingInitialConnect = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;

  constructor(
    private readonly cfg: OpenClawConfig,
    private readonly params: {
      gatewayUrl?: string;
      gatewayToken?: string;
      gatewayPassword?: string;
      claudeChannelMode: ClaudeChannelMode;
      verbose: boolean;
    },
  ) {
    this.verbose = params.verbose;
    this.claudeChannelMode = params.claudeChannelMode;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  setServer(server: McpServer): void {
    this.server = server;
  }

  async start(): Promise<void> {
    if (this.started) {
      await this.readyPromise;
      return;
    }
    this.started = true;
    const [
      { resolveGatewayClientBootstrap },
      { GatewayClient: GatewayClientCtor },
      { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE },
      { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES },
    ] = await Promise.all([
      import("../gateway/client-bootstrap.js"),
      import("../gateway/client.js"),
      import("../gateway/method-scopes.js"),
      import("../gateway/protocol/client-info.js"),
    ]);
    const bootstrap = await resolveGatewayClientBootstrap({
      config: this.cfg,
      gatewayUrl: this.params.gatewayUrl,
      explicitAuth: {
        token: this.params.gatewayToken,
        password: this.params.gatewayPassword,
      },
      env: process.env,
    });
    if (this.closed) {
      this.resolveReadyOnce();
      return;
    }

    this.gateway = new GatewayClientCtor({
      url: bootstrap.url,
      token: bootstrap.auth.token,
      password: bootstrap.auth.password,
      preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: "OpenClaw MCP",
      clientVersion: VERSION,
      mode: GATEWAY_CLIENT_MODES.CLI,
      scopes: [READ_SCOPE, WRITE_SCOPE, APPROVALS_SCOPE],
      requestTimeoutMs: 180_000,
      onEvent: (event) => {
        void this.handleGatewayEvent(event);
      },
      onHelloOk: () => {
        this.retryingInitialConnect = false;
        void this.handleHelloOk();
      },
      onConnectError: (error) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        if (shouldRetryInitialMcpGatewayConnect(normalizedError)) {
          this.retryingInitialConnect = true;
          return;
        }
        this.rejectReadyOnce(normalizedError);
      },
      onClose: (code, reason) => {
        if (!this.ready && !this.closed && !this.retryingInitialConnect) {
          this.rejectReadyOnce(new Error(`gateway closed before ready (${code}): ${reason}`));
        }
        this.retryingInitialConnect = false;
      },
    });
    this.gateway.start();
    await this.readyPromise;
  }

  async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolveReadyOnce();
    for (const waiter of this.pendingWaiters) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(null);
    }
    this.pendingWaiters.clear();
    const gateway = this.gateway;
    this.gateway = null;
    await gateway?.stopAndWait().catch(() => undefined);
  }

  async listConversations(params?: {
    limit?: number;
    search?: string;
    channel?: string;
    includeDerivedTitles?: boolean;
    includeLastMessage?: boolean;
  }): Promise<ConversationDescriptor[]> {
    await this.waitUntilReady();
    const response: SessionListResult = await this.requestGateway("sessions.list", {
      limit: params?.limit ?? 50,
      search: params?.search,
      includeDerivedTitles: params?.includeDerivedTitles ?? true,
      includeLastMessage: params?.includeLastMessage ?? true,
    });
    const requestedChannel = normalizeOptionalLowercaseString(params?.channel);
    return (response.sessions ?? [])
      .map(toConversation)
      .filter((conversation): conversation is ConversationDescriptor => Boolean(conversation))
      .filter((conversation) =>
        requestedChannel
          ? normalizeLowercaseStringOrEmpty(conversation.channel) === requestedChannel
          : true,
      );
  }

  async getConversation(sessionKey: string): Promise<ConversationDescriptor | null> {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) {
      return null;
    }
    const conversations = await this.listConversations({ limit: 500, includeLastMessage: true });
    return (
      conversations.find((conversation) => conversation.sessionKey === normalizedSessionKey) ?? null
    );
  }

  async readMessages(
    sessionKey: string,
    limit = 20,
  ): Promise<NonNullable<ChatHistoryResult["messages"]>> {
    await this.waitUntilReady();
    const response: ChatHistoryResult = await this.requestGateway("sessions.get", {
      key: sessionKey,
      limit,
    });
    return response.messages ?? [];
  }

  async sendMessage(params: {
    sessionKey: string;
    text: string;
  }): Promise<Record<string, unknown>> {
    const conversation = await this.getConversation(params.sessionKey);
    if (!conversation) {
      throw new Error(`Conversation not found for session ${params.sessionKey}`);
    }
    return await this.requestGateway("send", {
      to: conversation.to,
      channel: conversation.channel,
      accountId: conversation.accountId,
      threadId: conversation.threadId == null ? undefined : String(conversation.threadId),
      message: params.text,
      sessionKey: conversation.sessionKey,
      idempotencyKey: randomUUID(),
    });
  }

  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()].toSorted((a, b) => {
      return (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
    });
  }

  async respondToApproval(params: {
    kind: ApprovalKind;
    id: string;
    decision: ApprovalDecision;
  }): Promise<Record<string, unknown>> {
    if (params.kind === "exec") {
      return await this.requestGateway("exec.approval.resolve", {
        id: params.id,
        decision: params.decision,
      });
    }
    return await this.requestGateway("plugin.approval.resolve", {
      id: params.id,
      decision: params.decision,
    });
  }

  pollEvents(filter: WaitFilter, limit = 20): { events: QueueEvent[]; nextCursor: number } {
    const events = this.queue.filter((event) => matchEventFilter(event, filter)).slice(0, limit);
    const nextCursor = events.at(-1)?.cursor ?? filter.afterCursor;
    return { events, nextCursor };
  }

  async waitForEvent(filter: WaitFilter, timeoutMs = 30_000): Promise<QueueEvent | null> {
    const existing = this.queue.find((event) => matchEventFilter(event, filter));
    if (existing) {
      return existing;
    }
    return await new Promise<QueueEvent | null>((resolve) => {
      const waiter: PendingWaiter = {
        filter,
        resolve: (value) => {
          this.pendingWaiters.delete(waiter);
          resolve(value);
        },
        timeout: null,
      };
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          waiter.resolve(null);
        }, timeoutMs);
      }
      this.pendingWaiters.add(waiter);
    });
  }

  async handleClaudePermissionRequest(params: {
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
  }): Promise<void> {
    this.pendingClaudePermissions.set(params.requestId, {
      toolName: params.toolName,
      description: params.description,
      inputPreview: params.inputPreview,
    });
    this.enqueue({
      cursor: this.nextCursor(),
      type: "claude_permission_request",
      requestId: params.requestId,
      toolName: params.toolName,
      description: params.description,
      inputPreview: params.inputPreview,
    });
    if (this.verbose) {
      process.stderr.write(`openclaw mcp: pending Claude permission ${params.requestId}\n`);
    }
  }

  private async requestGateway<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!this.gateway) {
      throw new Error("Gateway client is not ready");
    }
    return await this.gateway.request<T>(method, params);
  }

  private async sendNotification(notification: ServerNotification): Promise<void> {
    if (!this.server || this.closed) {
      return;
    }
    try {
      await this.server.server.notification(notification);
    } catch (error) {
      if (this.verbose && !this.closed) {
        process.stderr.write(
          `openclaw mcp: notification ${notification.method} failed: ${String(error)}\n`,
        );
      }
    }
  }

  private async handleHelloOk(): Promise<void> {
    try {
      await this.requestGateway("sessions.subscribe", {});
      this.ready = true;
      this.resolveReadyOnce();
    } catch (error) {
      this.rejectReadyOnce(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private resolveReadyOnce(): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.resolveReady();
  }

  private rejectReadyOnce(error: Error): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.rejectReady(error);
  }

  private nextCursor(): number {
    this.cursor += 1;
    return this.cursor;
  }

  private enqueue(event: QueueEvent): void {
    this.queue.push(event);
    while (this.queue.length > QUEUE_LIMIT) {
      this.queue.shift();
    }
    for (const waiter of this.pendingWaiters) {
      if (!matchEventFilter(event, waiter.filter)) {
        continue;
      }
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(event);
    }
  }

  private trackApproval(kind: ApprovalKind, payload: Record<string, unknown>): void {
    const id = normalizeApprovalId(payload.id);
    if (!id) {
      return;
    }
    this.pendingApprovals.set(id, {
      kind,
      id,
      request:
        payload.request && typeof payload.request === "object"
          ? (payload.request as Record<string, unknown>)
          : undefined,
      createdAtMs: typeof payload.createdAtMs === "number" ? payload.createdAtMs : undefined,
      expiresAtMs: typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : undefined,
    });
  }

  private resolveTrackedApproval(payload: Record<string, unknown>): void {
    const id = normalizeApprovalId(payload.id);
    if (id) {
      this.pendingApprovals.delete(id);
    }
  }

  private async handleGatewayEvent(event: EventFrame): Promise<void> {
    switch (event.event) {
      case "session.message":
        await this.handleSessionMessageEvent(event.payload as SessionMessagePayload);
        return;
      case "exec.approval.requested": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.trackApproval("exec", raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "exec_approval_requested",
          raw,
        });
        return;
      }
      case "exec.approval.resolved": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.resolveTrackedApproval(raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "exec_approval_resolved",
          raw,
        });
        return;
      }
      case "plugin.approval.requested": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.trackApproval("plugin", raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "plugin_approval_requested",
          raw,
        });
        return;
      }
      case "plugin.approval.resolved": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.resolveTrackedApproval(raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "plugin_approval_resolved",
          raw,
        });
      }
    }
  }

  private async handleSessionMessageEvent(payload: SessionMessagePayload): Promise<void> {
    const sessionKey = toText(payload.sessionKey);
    if (!sessionKey) {
      return;
    }
    const conversation =
      toConversation({
        key: sessionKey,
        lastChannel: toText(payload.lastChannel),
        lastTo: toText(payload.lastTo),
        lastAccountId: toText(payload.lastAccountId),
        lastThreadId: payload.lastThreadId,
      }) ?? undefined;
    const role = toText(payload.message?.role);
    const text = extractFirstTextBlock(payload.message);
    const permissionMatch = text ? CLAUDE_PERMISSION_REPLY_RE.exec(text) : null;
    if (permissionMatch) {
      const requestId = normalizeOptionalLowercaseString(permissionMatch[2]);
      if (requestId && this.pendingClaudePermissions.has(requestId)) {
        this.pendingClaudePermissions.delete(requestId);
        await this.sendNotification({
          method: "notifications/claude/channel/permission",
          params: {
            request_id: requestId,
            behavior: normalizeLowercaseStringOrEmpty(permissionMatch[1]).startsWith("y")
              ? "allow"
              : "deny",
          },
        });
        return;
      }
    }

    this.enqueue({
      cursor: this.nextCursor(),
      type: "message",
      sessionKey,
      conversation,
      messageId: toText(payload.messageId),
      messageSeq: typeof payload.messageSeq === "number" ? payload.messageSeq : undefined,
      role,
      text,
      raw: payload,
    });

    if (!this.shouldEmitClaudeChannel(role, conversation)) {
      return;
    }
    await this.sendNotification({
      method: "notifications/claude/channel",
      params: {
        content: text ?? "[non-text message]",
        meta: {
          session_key: sessionKey,
          channel: conversation?.channel ?? "",
          to: conversation?.to ?? "",
          account_id: conversation?.accountId ?? "",
          thread_id: conversation?.threadId == null ? "" : String(conversation.threadId),
          message_id: toText(payload.messageId) ?? "",
        },
      },
    });
  }

  private shouldEmitClaudeChannel(
    role: string | undefined,
    conversation: ConversationDescriptor | undefined,
  ): boolean {
    if (this.claudeChannelMode === "off") {
      return false;
    }
    if (role !== "user") {
      return false;
    }
    return Boolean(conversation);
  }
}

export function shouldRetryInitialMcpGatewayConnect(error: Error): boolean {
  if (
    error.name === "GatewayClientRequestError" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return error.retryable;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("gateway request timeout for connect") ||
    message.includes("gateway connect challenge timeout")
  );
}
