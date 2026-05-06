import type { MessageReceipt } from "openclaw/plugin-sdk/channel-message";
import type { GatewayAccount } from "../types.js";

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: GatewayAccount;
}

export interface MediaOutboundContext extends OutboundContext {
  mediaUrl: string;
  mimeType?: string;
}

/**
 * Stable error codes for outbound media send results.
 */
export const OUTBOUND_ERROR_CODES = {
  FILE_TOO_LARGE: "file_too_large",
  UPLOAD_DAILY_LIMIT_EXCEEDED: "upload_daily_limit_exceeded",
} as const;

export type OutboundErrorCode = (typeof OUTBOUND_ERROR_CODES)[keyof typeof OUTBOUND_ERROR_CODES];

export const DEFAULT_MEDIA_SEND_ERROR = "发送失败，请稍后重试。";

export interface OutboundResult {
  channel: string;
  messageId?: string;
  receipt?: MessageReceipt;
  timestamp?: string | number;
  error?: string;
  errorCode?: OutboundErrorCode;
  qqBizCode?: number;
  refIdx?: string;
}

/** Normalized target information for media sends. */
export interface MediaTargetContext {
  targetType: "c2c" | "group" | "channel" | "dm";
  targetId: string;
  account: GatewayAccount;
  replyToId?: string;
  logPrefix?: string;
}
