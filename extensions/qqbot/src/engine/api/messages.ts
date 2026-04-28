/**
 * Message sending API for the QQ Open Platform.
 *
 * Key design improvements:
 * - Unified `sendMessage(scope, ...)` replaces `sendC2CMessage` + `sendGroupMessage`.
 * - `onMessageSent` hook is scoped to the instance, not a module-level global.
 * - Markdown support flag is per-instance, not a global Map.
 */

import type {
  ChatScope,
  MessageResponse,
  OutboundMeta,
  EngineLogger,
  InlineKeyboard,
  StreamMessageRequest,
} from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import { ApiClient } from "./api-client.js";
import {
  messagePath,
  channelMessagePath,
  dmMessagePath,
  gatewayPath,
  interactionPath,
  getNextMsgSeq,
  streamMessagePath,
} from "./routes.js";
import { TokenManager } from "./token.js";

export interface MessageApiConfig {
  /** Whether the QQ Bot has markdown permission. */
  markdownSupport: boolean;
  /** Logger for diagnostics. */
  logger?: EngineLogger;
}

type OnMessageSentCallback = (refIdx: string, meta: OutboundMeta) => void;

/**
 * Message sending module.
 *
 * Usage:
 * ```ts
 * const api = new MessageApi(client, tokenMgr, { markdownSupport: true });
 * await api.sendMessage('c2c', openid, 'Hello!', { appId, clientSecret, msgId });
 * ```
 */
export class MessageApi {
  private readonly client: ApiClient;
  private readonly tokenManager: TokenManager;
  private readonly markdownSupport: boolean;
  private readonly logger?: EngineLogger;
  private messageSentHook: OnMessageSentCallback | null = null;

  constructor(client: ApiClient, tokenManager: TokenManager, config: MessageApiConfig) {
    this.client = client;
    this.tokenManager = tokenManager;
    this.markdownSupport = config.markdownSupport;
    this.logger = config.logger;
  }

  /** Register a callback invoked when a sent message returns a ref_idx. */
  onMessageSent(callback: OnMessageSentCallback): void {
    this.messageSentHook = callback;
  }

  /**
   * Notify the registered hook about a sent message.
   * Use this for media sends that bypass `sendAndNotify`.
   */
  notifyMessageSent(refIdx: string, meta: OutboundMeta): void {
    if (this.messageSentHook) {
      try {
        this.messageSentHook(refIdx, meta);
      } catch (err) {
        this.logger?.error?.(
          `[qqbot:messages] onMessageSent hook error: ${formatErrorMessage(err)}`,
        );
      }
    }
  }

  // ---- Unified message sending ----

  /**
   * Send a text message to a C2C or Group target.
   *
   * Automatically constructs the correct path, body format (markdown vs plain),
   * and message sequence number.
   */
  async sendMessage(
    scope: ChatScope,
    targetId: string,
    content: string,
    creds: Credentials,
    opts?: {
      msgId?: string;
      messageReference?: string;
      inlineKeyboard?: InlineKeyboard;
    },
  ): Promise<MessageResponse> {
    const token = await this.tokenManager.getAccessToken(creds.appId, creds.clientSecret);
    const msgSeq = opts?.msgId ? getNextMsgSeq(opts.msgId) : 1;
    const body = this.buildMessageBody(
      content,
      opts?.msgId,
      msgSeq,
      opts?.messageReference,
      opts?.inlineKeyboard,
    );
    const path = messagePath(scope, targetId);
    return this.sendAndNotify(creds.appId, token, "POST", path, body, { text: content });
  }

  /** Send a proactive (no msgId) message to a C2C or Group target. */
  async sendProactiveMessage(
    scope: ChatScope,
    targetId: string,
    content: string,
    creds: Credentials,
  ): Promise<MessageResponse> {
    if (!content?.trim()) {
      throw new Error("Proactive message content must not be empty");
    }
    const token = await this.tokenManager.getAccessToken(creds.appId, creds.clientSecret);
    const body = this.buildProactiveBody(content);
    const path = messagePath(scope, targetId);
    return this.sendAndNotify(creds.appId, token, "POST", path, body, { text: content });
  }

  // ---- Channel / DM ----

  /** Send a channel message. */
  async sendChannelMessage(opts: {
    channelId: string;
    content: string;
    creds: Credentials;
    msgId?: string;
  }): Promise<MessageResponse> {
    const token = await this.tokenManager.getAccessToken(opts.creds.appId, opts.creds.clientSecret);
    return this.client.request<MessageResponse>(token, "POST", channelMessagePath(opts.channelId), {
      content: opts.content,
      ...(opts.msgId ? { msg_id: opts.msgId } : {}),
    });
  }

  /** Send a DM (guild direct message). */
  async sendDmMessage(opts: {
    guildId: string;
    content: string;
    creds: Credentials;
    msgId?: string;
  }): Promise<MessageResponse> {
    const token = await this.tokenManager.getAccessToken(opts.creds.appId, opts.creds.clientSecret);
    return this.client.request<MessageResponse>(token, "POST", dmMessagePath(opts.guildId), {
      content: opts.content,
      ...(opts.msgId ? { msg_id: opts.msgId } : {}),
    });
  }

  // ---- C2C Input Notify ----

  /** Send a typing indicator to a C2C user. */
  async sendInputNotify(opts: {
    openid: string;
    creds: Credentials;
    msgId?: string;
    inputSecond?: number;
  }): Promise<{ refIdx?: string }> {
    const inputSecond = opts.inputSecond ?? 60;
    const token = await this.tokenManager.getAccessToken(opts.creds.appId, opts.creds.clientSecret);
    const msgSeq = opts.msgId ? getNextMsgSeq(opts.msgId) : 1;
    const response = await this.client.request<{ ext_info?: { ref_idx?: string } }>(
      token,
      "POST",
      messagePath("c2c", opts.openid),
      {
        msg_type: 6,
        input_notify: { input_type: 1, input_second: inputSecond },
        msg_seq: msgSeq,
        ...(opts.msgId ? { msg_id: opts.msgId } : {}),
      },
    );
    return { refIdx: response.ext_info?.ref_idx };
  }

  // ---- Interaction ----

  /** Acknowledge an INTERACTION_CREATE event. */
  async acknowledgeInteraction(
    interactionId: string,
    creds: Credentials,
    code: 0 | 1 | 2 | 3 | 4 | 5 = 0,
  ): Promise<void> {
    const token = await this.tokenManager.getAccessToken(creds.appId, creds.clientSecret);
    await this.client.request(token, "PUT", interactionPath(interactionId), { code });
  }

  // ---- Gateway ----

  /** Get the WebSocket gateway URL. */
  async getGatewayUrl(creds: Credentials): Promise<string> {
    const token = await this.tokenManager.getAccessToken(creds.appId, creds.clientSecret);
    const data = await this.client.request<{ url: string }>(token, "GET", gatewayPath());
    return data.url;
  }

  /**
   * Send a C2C stream message chunk (`/v2/users/{openid}/stream_messages`).
   * Only supported for one-to-one chats.
   */
  async sendC2CStreamMessage(
    creds: Credentials,
    openid: string,
    req: StreamMessageRequest,
  ): Promise<MessageResponse> {
    const token = await this.tokenManager.getAccessToken(creds.appId, creds.clientSecret);
    const path = streamMessagePath(openid);
    const body: Record<string, unknown> = {
      input_mode: req.input_mode,
      input_state: req.input_state,
      content_type: req.content_type,
      content_raw: req.content_raw,
      event_id: req.event_id,
      msg_id: req.msg_id,
      msg_seq: req.msg_seq,
      index: req.index,
    };
    if (req.stream_msg_id) {
      body.stream_msg_id = req.stream_msg_id;
    }
    return this.client.request<MessageResponse>(token, "POST", path, body);
  }

  // ---- Internal ----

  private async sendAndNotify(
    appId: string,
    accessToken: string,
    method: string,
    path: string,
    body: unknown,
    meta: OutboundMeta,
  ): Promise<MessageResponse> {
    const result = await this.client.request<MessageResponse>(accessToken, method, path, body);
    if (result.ext_info?.ref_idx && this.messageSentHook) {
      try {
        this.messageSentHook(result.ext_info.ref_idx, meta);
      } catch (err) {
        this.logger?.error?.(
          `[qqbot:messages] onMessageSent hook error: ${formatErrorMessage(err)}`,
        );
      }
    }
    return result;
  }

  private buildMessageBody(
    content: string,
    msgId: string | undefined,
    msgSeq: number,
    messageReference?: string,
    inlineKeyboard?: InlineKeyboard,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = this.markdownSupport
      ? { markdown: { content }, msg_type: 2, msg_seq: msgSeq }
      : { content, msg_type: 0, msg_seq: msgSeq };

    if (msgId) {
      body.msg_id = msgId;
    }
    if (messageReference && !this.markdownSupport) {
      body.message_reference = { message_id: messageReference };
    }
    if (inlineKeyboard) {
      body.keyboard = inlineKeyboard;
    }
    return body;
  }

  private buildProactiveBody(content: string): Record<string, unknown> {
    return this.markdownSupport ? { markdown: { content }, msg_type: 2 } : { content, msg_type: 0 };
  }
}

// ---- Shared helpers ----

/** Credentials needed to authenticate API requests. */
export interface Credentials {
  appId: string;
  clientSecret: string;
}

// Re-export getNextMsgSeq for consumers that import from messages.ts.
export { getNextMsgSeq } from "./routes.js";
