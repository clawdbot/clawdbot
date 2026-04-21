/**
 * Media upload API for the QQ Open Platform (small-file direct upload).
 *
 * Key improvements:
 * - Unified `uploadMedia(scope, ...)` replaces `uploadC2CMedia` + `uploadGroupMedia`.
 * - Upload cache integration via composition (passed in constructor).
 * - Uses `withRetry` from the shared retry engine.
 */

import {
  MediaFileType,
  type ChatScope,
  type UploadMediaResponse,
  type MessageResponse,
  type EngineLogger,
} from "../types.js";
import { ApiClient } from "./api-client.js";
import { withRetry, UPLOAD_RETRY_POLICY } from "./retry.js";
import { mediaUploadPath, getNextMsgSeq } from "./routes.js";
import { TokenManager } from "./token.js";

/** Upload cache interface — the caller provides the implementation. */
export interface UploadCacheAdapter {
  computeHash: (data: string) => string;
  get: (hash: string, scope: string, targetId: string, fileType: number) => string | null;
  set: (
    hash: string,
    scope: string,
    targetId: string,
    fileType: number,
    fileInfo: string,
    fileUuid: string,
    ttl: number,
  ) => void;
}

/** File name sanitizer — injected to avoid importing platform-specific utils. */
export type SanitizeFileNameFn = (name: string) => string;

export interface MediaApiConfig {
  logger?: EngineLogger;
  /** Upload cache adapter (optional, omit to disable caching). */
  uploadCache?: UploadCacheAdapter;
  /** File name sanitizer. */
  sanitizeFileName?: SanitizeFileNameFn;
}

/**
 * Small-file media upload module.
 *
 * Handles base64 and URL-based uploads with optional caching and retry.
 */
export class MediaApi {
  private readonly client: ApiClient;
  private readonly tokenManager: TokenManager;
  private readonly logger?: EngineLogger;
  private readonly cache?: UploadCacheAdapter;
  private readonly sanitize: SanitizeFileNameFn;

  constructor(client: ApiClient, tokenManager: TokenManager, config: MediaApiConfig = {}) {
    this.client = client;
    this.tokenManager = tokenManager;
    this.logger = config.logger;
    this.cache = config.uploadCache;
    this.sanitize = config.sanitizeFileName ?? ((n) => n);
  }

  /**
   * Upload media via base64 or URL to a C2C or Group target.
   *
   * @param scope - `'c2c'` or `'group'`.
   * @param targetId - User openid or group openid.
   * @param fileType - Media file type code.
   * @param creds - Authentication credentials.
   * @param opts - Upload options.
   * @returns Upload result containing `file_info` for subsequent message sends.
   */
  async uploadMedia(
    scope: ChatScope,
    targetId: string,
    fileType: MediaFileType,
    creds: { appId: string; clientSecret: string },
    opts: {
      url?: string;
      fileData?: string;
      srvSendMsg?: boolean;
      fileName?: string;
    },
  ): Promise<UploadMediaResponse> {
    if (!opts.url && !opts.fileData) {
      throw new Error(`uploadMedia: url or fileData is required`);
    }

    // Check cache for base64 uploads.
    if (opts.fileData && this.cache) {
      const hash = this.cache.computeHash(opts.fileData);
      const cached = this.cache.get(hash, scope, targetId, fileType);
      if (cached) {
        return { file_uuid: "", file_info: cached, ttl: 0 };
      }
    }

    const body: Record<string, unknown> = {
      file_type: fileType,
      srv_send_msg: opts.srvSendMsg ?? false,
    };
    if (opts.url) {
      body.url = opts.url;
    } else if (opts.fileData) {
      body.file_data = opts.fileData;
    }
    if (fileType === MediaFileType.FILE && opts.fileName) {
      body.file_name = this.sanitize(opts.fileName);
    }

    const token = await this.tokenManager.getAccessToken(creds.appId, creds.clientSecret);
    const path = mediaUploadPath(scope, targetId);

    const result = await withRetry(
      () =>
        this.client.request<UploadMediaResponse>(token, "POST", path, body, {
          redactBodyKeys: ["file_data"],
        }),
      UPLOAD_RETRY_POLICY,
      undefined,
      this.logger,
    );

    // Cache the result for future dedup.
    if (opts.fileData && result.file_info && result.ttl > 0 && this.cache) {
      const hash = this.cache.computeHash(opts.fileData);
      this.cache.set(
        hash,
        scope,
        targetId,
        fileType,
        result.file_info,
        result.file_uuid,
        result.ttl,
      );
    }

    return result;
  }

  /**
   * Send a media message (upload result → message) to a C2C or Group target.
   *
   * @param scope - `'c2c'` or `'group'`.
   * @param targetId - User openid or group openid.
   * @param fileInfo - `file_info` from a prior upload.
   * @param creds - Authentication credentials.
   * @param opts - Message options.
   */
  async sendMediaMessage(
    scope: ChatScope,
    targetId: string,
    fileInfo: string,
    creds: { appId: string; clientSecret: string },
    opts?: {
      msgId?: string;
      content?: string;
    },
  ): Promise<MessageResponse> {
    const token = await this.tokenManager.getAccessToken(creds.appId, creds.clientSecret);
    const msgSeq = opts?.msgId ? getNextMsgSeq(opts.msgId) : 1;
    const path =
      scope === "c2c" ? `/v2/users/${targetId}/messages` : `/v2/groups/${targetId}/messages`;

    return this.client.request<MessageResponse>(token, "POST", path, {
      msg_type: 7,
      media: { file_info: fileInfo },
      msg_seq: msgSeq,
      ...(opts?.content ? { content: opts.content } : {}),
      ...(opts?.msgId ? { msg_id: opts.msgId } : {}),
    });
  }
}
