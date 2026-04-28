/**
 * Media upload API for the QQ Open Platform (small-file direct upload).
 *
 * Key improvements:
 * - Unified `uploadMedia(scope, ...)` replaces `uploadC2CMedia` + `uploadGroupMedia`.
 * - Upload cache integration via composition (passed in constructor).
 * - Uses `withRetry` from the shared retry engine.
 *
 * Chunked upload for files above `LARGE_FILE_THRESHOLD` is tracked by
 * {@link ./media-chunked.ts}; this module currently handles only the
 * one-shot path.
 */

import * as fs from "node:fs";
import {
  MediaFileType,
  type ChatScope,
  type UploadMediaResponse,
  type MessageResponse,
  type EngineLogger,
} from "../types.js";
import { ApiClient } from "./api-client.js";
import { withRetry, UPLOAD_RETRY_POLICY } from "./retry.js";
import { mediaUploadPath, messagePath, getNextMsgSeq } from "./routes.js";
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
   * Upload media via base64, URL, buffer, or local file path to a C2C or Group target.
   *
   * The `localPath` and `buffer` branches are equivalent to `fileData` for the
   * current one-shot implementation — the file is read and base64-encoded
   * synchronously. They exist as first-class inputs so that a future chunked
   * upload implementation can consume them without interface churn.
   *
   * @param scope - `'c2c'` or `'group'`.
   * @param targetId - User openid or group openid.
   * @param fileType - Media file type code.
   * @param creds - Authentication credentials.
   * @param opts - Upload options. Exactly one of `url`/`fileData`/`buffer`/`localPath`
   *   must be supplied.
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
      /**
       * Raw bytes in memory. Currently re-encoded to base64 internally;
       * reserved as a dedicated input for the future chunked uploader.
       */
      buffer?: Buffer;
      /**
       * On-disk path. Currently read + base64-encoded internally; reserved
       * for streaming ingestion by the future chunked uploader.
       */
      localPath?: string;
      srvSendMsg?: boolean;
      fileName?: string;
    },
  ): Promise<UploadMediaResponse> {
    const sources = [opts.url, opts.fileData, opts.buffer, opts.localPath].filter(
      (v) => v !== undefined,
    );
    if (sources.length === 0) {
      throw new Error(`uploadMedia: one of url/fileData/buffer/localPath is required`);
    }
    if (sources.length > 1) {
      throw new Error(
        `uploadMedia: url/fileData/buffer/localPath are mutually exclusive (got ${sources.length})`,
      );
    }

    // One-shot path: materialize buffer/localPath into fileData.
    // Future chunked-upload work will branch here on size and route
    // buffer/localPath through streaming ingestion instead of base64 encoding.
    let fileData = opts.fileData;
    if (opts.buffer) {
      fileData = opts.buffer.toString("base64");
    } else if (opts.localPath) {
      const buf = await fs.promises.readFile(opts.localPath);
      fileData = buf.toString("base64");
    }

    // Check cache for base64 uploads.
    if (fileData && this.cache) {
      const hash = this.cache.computeHash(fileData);
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
    } else if (fileData) {
      body.file_data = fileData;
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
          uploadRequest: true,
        }),
      UPLOAD_RETRY_POLICY,
      undefined,
      this.logger,
    );

    // Cache the result for future dedup.
    if (fileData && result.file_info && result.ttl > 0 && this.cache) {
      const hash = this.cache.computeHash(fileData);
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
    const path = messagePath(scope, targetId);

    return this.client.request<MessageResponse>(token, "POST", path, {
      msg_type: 7,
      media: { file_info: fileInfo },
      msg_seq: msgSeq,
      ...(opts?.content ? { content: opts.content } : {}),
      ...(opts?.msgId ? { msg_id: opts.msgId } : {}),
    });
  }
}
