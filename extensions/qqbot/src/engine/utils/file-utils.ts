import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import {
  openLocalFileSafely,
  readRegularFile,
  statRegularFileSync,
} from "openclaw/plugin-sdk/security-runtime";
import { getPlatformAdapter } from "../adapter/index.js";
import type { SsrfPolicyConfig } from "../adapter/types.js";
import { MediaFileType } from "../types.js";
import { formatErrorMessage } from "./format.js";
import { normalizeOptionalString } from "./string-normalize.js";

/** Maximum file size accepted by the QQ Bot one-shot upload API (base64 direct). */
export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;

/** Absolute upper bound enforced on the chunked upload path (matches server policy). */
const CHUNKED_UPLOAD_MAX_SIZE = 100 * 1024 * 1024;

/** Threshold used to treat an upload as a large file (dispatch to chunked path). */
export const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;

/**
 * Per-{@link MediaFileType} upload metadata: the QQ Open Platform size
 * ceiling and the Chinese display name used in user-facing error messages.
 *
 * Keyed by the enum value so call sites read as
 * `MEDIA_FILE_TYPE_INFO[MediaFileType.IMAGE].maxSize`, and adding a new
 * type forces both fields to be supplied in a single place.
 */
const MEDIA_FILE_TYPE_INFO: Record<MediaFileType, { maxSize: number; name: string }> = {
  [MediaFileType.IMAGE]: { maxSize: 30 * 1024 * 1024, name: "图片" },
  [MediaFileType.VIDEO]: { maxSize: 100 * 1024 * 1024, name: "视频" },
  [MediaFileType.VOICE]: { maxSize: 20 * 1024 * 1024, name: "语音" },
  [MediaFileType.FILE]: { maxSize: 100 * 1024 * 1024, name: "文件" },
};

/** Return the Chinese display name for a media file type code. Defaults to "文件". */
export function getFileTypeName(fileType: number): string {
  return MEDIA_FILE_TYPE_INFO[fileType as MediaFileType]?.name ?? "文件";
}

/** Return the upload ceiling for a given media file type. Defaults to 100MB. */
export function getMaxUploadSize(fileType: number): number {
  return MEDIA_FILE_TYPE_INFO[fileType as MediaFileType]?.maxSize ?? CHUNKED_UPLOAD_MAX_SIZE;
}

const QQBOT_MEDIA_HOSTNAME_ALLOWLIST = [
  // QQ rich media
  "*.qpic.cn",
  "*.qq.com",
  "*.weiyun.com",
  "*.qq.com.cn",

  // QQ Bot
  "*.ugcimg.cn",

  // Tencent Cloud COS
  "*.myqcloud.com",
  "*.tencentcos.cn",
  "*.tencentcos.com",
];

export const QQBOT_MEDIA_SSRF_POLICY: SsrfPolicyConfig = {
  hostnameAllowlist: QQBOT_MEDIA_HOSTNAME_ALLOWLIST,
  allowRfc2544BenchmarkRange: true,
};

/** Result of local file-size validation. */
interface FileSizeCheckResult {
  ok: boolean;
  size: number;
  error?: string;
}

/** Validate that a file is within the allowed upload size. */
export function checkFileSize(filePath: string, maxSize = MAX_UPLOAD_SIZE): FileSizeCheckResult {
  try {
    const result = statRegularFileSync(filePath);
    if (result.missing) {
      throw Object.assign(new Error(`File not found: ${filePath}`), { code: "ENOENT" });
    }
    if (result.stat.size > maxSize) {
      const sizeMB = (result.stat.size / (1024 * 1024)).toFixed(1);
      const limitMB = (maxSize / (1024 * 1024)).toFixed(0);
      return {
        ok: false,
        size: result.stat.size,
        error: `File is too large (${sizeMB}MB); QQ Bot API limit is ${limitMB}MB`,
      };
    }
    return { ok: true, size: result.stat.size };
  } catch (err) {
    return {
      ok: false,
      size: 0,
      error: `Failed to read file metadata: ${formatErrorMessage(err)}`,
    };
  }
}

/** Read file contents asynchronously. */
export async function readFileAsync(filePath: string): Promise<Buffer> {
  return (await readRegularFile({ filePath })).buffer;
}

/** Check file readability asynchronously. */
export async function fileExistsAsync(filePath: string): Promise<boolean> {
  const opened = await openLocalFileSafely({ filePath }).catch(() => null);
  if (!opened) {
    return false;
  }
  try {
    return true;
  } catch {
    return false;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Format a byte count into a human-readable size string. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Infer a MIME type from the file extension. */
export function getMimeType(filePath: string): string {
  return mimeTypeFromFilePath(filePath) ?? "application/octet-stream";
}

/** Extensions accepted as image uploads by the QQ Bot media pipeline. */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

/**
 * Return the image MIME type for a local file path, or `null` if the
 * extension is not in the supported image whitelist.
 *
 * Use this instead of `getMimeType` when the caller must enforce
 * "image formats only" as a business rule (e.g. constructing a
 * `data:image/...;base64,` URL).
 */
export function getImageMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return null;
  }
  const mime = mimeTypeFromFilePath(filePath);
  return mime?.startsWith("image/") ? mime : null;
}

/** Download a remote file into a local directory. */
export async function downloadFile(
  url: string,
  destDir: string,
  originalFilename?: string,
): Promise<string | null> {
  try {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return null;
    }
    if (parsedUrl.protocol !== "https:") {
      return null;
    }

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const fetched = await getPlatformAdapter().fetchMedia({
      url: parsedUrl.toString(),
      filePathHint: originalFilename,
      ssrfPolicy: QQBOT_MEDIA_SSRF_POLICY,
    });

    let filename = normalizeOptionalString(originalFilename) ?? "";
    if (!filename) {
      filename =
        (normalizeOptionalString(fetched.fileName) ?? path.basename(parsedUrl.pathname)) ||
        "download";
    }

    const ts = Date.now();
    const ext = path.extname(filename);
    const base = path.basename(filename, ext) || "file";
    const rand = crypto.randomBytes(3).toString("hex");
    const safeFilename = `${base}_${ts}_${rand}${ext}`;

    const destPath = path.join(destDir, safeFilename);
    await fs.promises.writeFile(destPath, fetched.buffer);
    return destPath;
  } catch (err) {
    console.error(
      `[qqbot:downloadFile] FAILED url=${url.slice(0, 120)} error=${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      console.error(`[qqbot:downloadFile] stack=${err.stack.split("\n").slice(0, 3).join(" | ")}`);
    }
    if (err instanceof Error && err.cause) {
      console.error(`[qqbot:downloadFile] cause=${formatErrorMessage(err.cause)}`);
    }
    return null;
  }
}
