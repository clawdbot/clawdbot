/**
 * Core API layer public types.
 *
 * These types are independent of the root `src/types.ts` and only define
 * what the `core/api/` modules need.  The old `src/types.ts` remains
 * untouched for backward compatibility.
 */

// ============ Structured API Error ============

/**
 * Structured API error with HTTP status, path, and optional business error code.
 *
 * Compared to the old `api.ts` which throws plain `Error`, this carries
 * machine-readable fields for downstream retry/fallback decisions.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    message: string,
    /** HTTP status code returned by the QQ Open Platform. */
    public readonly httpStatus: number,
    /** API path that produced the error (e.g. `/v2/users/{id}/messages`). */
    public readonly path: string,
    /** Business error code from the response body (`code` or `err_code`). */
    public readonly bizCode?: number,
    /** Original error message from the response body. */
    public readonly bizMessage?: string,
  ) {
    super(message);
  }
}

// ============ Logger ============

/**
 * Unified logger interface used across all engine/ modules.
 *
 * Replaces the previously fragmented ApiLogger, GatewayLogger, ReconnectLogger,
 * MessageRefLogger, PathLogger, and SenderLogger interfaces.
 *
 * `info` and `error` are required; `warn` and `debug` are optional because
 * some callers (e.g. the framework-injected `ctx.log`) may not provide them.
 */
export interface EngineLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

// ============ Chat Scope ============

/** Chat scope used to unify C2C/Group path construction. */
export type ChatScope = "c2c" | "group";

// ============ Message Response ============

/** Standard message send response from the QQ Open Platform. */
export interface MessageResponse {
  id: string;
  timestamp: number | string;
  /** Reference index for future quoting. */
  ext_info?: {
    ref_idx?: string;
  };
}

// ============ Media Types ============

/** QQ Open Platform media file type codes. */
export enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

/** Media upload response from the QQ Open Platform. */
export interface UploadMediaResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
  id?: string;
}

/** Structured metadata recorded for outbound messages. */
export interface OutboundMeta {
  /** Message text content. */
  text?: string;
  /** Media type tag. */
  mediaType?: "image" | "voice" | "video" | "file";
  /** Remote URL of the media source. */
  mediaUrl?: string;
  /** Local file path of the media source. */
  mediaLocalPath?: string;
  /** Original TTS text (voice messages only). */
  ttsText?: string;
}

// ============ API Client Config ============

/** Configuration for the core HTTP client. */
export interface ApiClientConfig {
  /** Base URL for the QQ Open Platform REST API. */
  baseUrl?: string;
  /** Default request timeout in milliseconds. */
  defaultTimeoutMs?: number;
  /** File upload request timeout in milliseconds. */
  fileUploadTimeoutMs?: number;
  /** Logger instance. */
  logger?: EngineLogger;
  /** User-Agent header value, or a getter function for dynamic resolution. */
  userAgent?: string | (() => string);
}

// ============ Chunked Upload Types ============

/** Individual upload part metadata. */
export interface UploadPart {
  /** Part index (1-based). */
  index: number;
  /** Pre-signed upload URL. */
  presigned_url: string;
}

/** Response from the upload_prepare endpoint. */
export interface UploadPrepareResponse {
  /** Upload task identifier. */
  upload_id: string;
  /** Block size in bytes. */
  block_size: number;
  /** Pre-signed upload parts. */
  parts: UploadPart[];
  /** Server-suggested upload concurrency. */
  concurrency?: number;
  /** Server-suggested retry timeout for upload_part_finish (seconds). */
  retry_timeout?: number;
}

/** Complete upload response. */
export interface MediaUploadResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
}

/** File hash information for upload_prepare. */
export interface UploadPrepareHashes {
  /** Whole-file MD5 (hex). */
  md5: string;
  /** Whole-file SHA1 (hex). */
  sha1: string;
  /** MD5 of the first 10,002,432 bytes (hex). */
  md5_10m: string;
}

// ============ Stream Message Types ============

/** Stream message input state. */
export enum StreamInputState {
  GENERATING = "1",
  DONE = "10",
}

/** Stream message request body. */
export interface StreamMessageRequest {
  input_mode: string;
  input_state: string;
  content_type: string;
  content_raw: string;
  event_id?: string;
  msg_id?: string;
  msg_seq?: number;
  index?: number;
  stream_msg_id?: string;
}

// ============ Inline Keyboard Types ============

/** Inline keyboard button for approval/interaction flows. */
export interface KeyboardButton {
  id: string;
  render_data: {
    label: string;
    visited_label: string;
    style: number;
  };
  action: {
    type: number;
    permission: { type: number };
    data: string;
    click_limit?: number;
  };
  group_id?: string;
}

/**
 * Inline keyboard structure attached to messages.
 * Sent as the `keyboard` field in the message body:
 * `{ "keyboard": { "content": { "rows": [...] } } }`
 */
export interface InlineKeyboard {
  content: {
    rows: Array<{ buttons: KeyboardButton[] }>;
  };
}

// ============ Interaction Event Types ============

/** Button interaction event (INTERACTION_CREATE). */
export interface InteractionEvent {
  /** Event ID — used to acknowledge the interaction (PUT /interactions/{id}). */
  id: string;
  /** Event sub-type: 11=message button, 12=c2c quick menu. */
  type: number;
  /** Scene identifier: c2c / group / guild. */
  scene?: string;
  /** Chat type: 0=guild, 1=group, 2=c2c. */
  chat_type?: number;
  timestamp?: string;
  guild_id?: string;
  channel_id?: string;
  /** C2C user openid (c2c scene only). */
  user_openid?: string;
  /** Group openid (group scene only). */
  group_openid?: string;
  /** Group member openid (group scene only). */
  group_member_openid?: string;
  version: number;
  data: {
    type: number;
    resolved: {
      button_data?: string;
      button_id?: string;
      user_id?: string;
      feature_id?: string;
      message_id?: string;
    };
  };
}

// ============ Gateway Account ============

/**
 * Resolved account configuration — shared across gateway/ and messaging/ layers.
 *
 * Lifted here from gateway/types.ts to eliminate the circular type dependency
 * where messaging/ had to import from gateway/.
 */
export interface GatewayAccount {
  accountId: string;
  appId: string;
  clientSecret: string;
  markdownSupport: boolean;
  systemPrompt?: string;
  config: Record<string, unknown> & {
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    dmPolicy?: "open" | "allowlist" | "disabled";
    groupPolicy?: "open" | "allowlist" | "disabled";
    streaming?: { mode?: string };
    audioFormatPolicy?: {
      uploadDirectFormats?: string[];
      transcodeEnabled?: boolean;
    };
    voiceDirectUploadFormats?: string[];
  };
}
