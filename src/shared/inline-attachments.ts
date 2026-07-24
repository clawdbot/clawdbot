import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type InlineAttachment = {
  name: string;
  content: string;
  encoding?: "utf8" | "base64";
  mimeType?: string;
};

export type InlineAttachmentMount = {
  mountPath?: string;
};

export type InlineAttachmentMountPathResult =
  | { status: "absent" }
  | { status: "valid"; mountPath: string }
  | { status: "invalid" };

export function parseInlineAttachmentMountPath(value: unknown): InlineAttachmentMountPathResult {
  if (value === undefined || value === null) {
    return { status: "absent" };
  }
  if (typeof value !== "string") {
    return { status: "invalid" };
  }
  const mountPath = value.trim();
  if (!mountPath) {
    return { status: "absent" };
  }
  if (!/^[A-Za-z0-9._\-/:]+$/.test(mountPath)) {
    return { status: "invalid" };
  }
  return { status: "valid", mountPath };
}

/** Stable byte ceilings for durable inline snapshots. Runtime policy may tighten these. */
export const DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS = {
  maxTotalBytes: 5 * 1024 * 1024,
  maxFiles: 50,
  maxFileBytes: 1 * 1024 * 1024,
} as const;

/** Portable basename ceiling shared by supported local filesystems. */
export const MAX_INLINE_ATTACHMENT_BASENAME_BYTES = 255;

const PORTABLE_ATTACHMENT_NAME_FORBIDDEN = new Set([
  "<",
  ">",
  ":",
  '"',
  "/",
  "\\",
  "|",
  "?",
  "*",
  "%",
  "!",
]);
const WINDOWS_RESERVED_ATTACHMENT_BASENAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/u;

export type InlineAttachmentSnapshotLimits = {
  maxTotalBytes: number;
  maxFiles: number;
  maxFileBytes: number;
};

export type PreparedInlineAttachmentSnapshot = {
  name: string;
  mimeType: string;
  buf: Buffer;
  bytes: number;
};

function decodeStrictBase64(value: string, maxDecodedBytes: number): Buffer | null {
  const maxEncodedBytes = Math.ceil(maxDecodedBytes / 3) * 4;
  if (value.length > maxEncodedBytes * 2) {
    return null;
  }
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }
  if (normalized.length > maxEncodedBytes) {
    return null;
  }
  const decoded = Buffer.from(normalized, "base64");
  return decoded.byteLength <= maxDecodedBytes ? decoded : null;
}

function isWellFormedAttachmentName(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateInlineAttachmentName(name: string): void {
  if (!name) {
    throw new Error("attachments_invalid_name (empty)");
  }
  if (!isWellFormedAttachmentName(name) || name.includes("\uFFFD")) {
    throw new Error("attachments_invalid_name (invalid Unicode)");
  }
  if (
    name.includes("\u0000") ||
    Array.from(name).some((char) => PORTABLE_ATTACHMENT_NAME_FORBIDDEN.has(char))
  ) {
    throw new Error(`attachments_invalid_name (${name})`);
  }
  if (
    Array.from(name).some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new Error(`attachments_invalid_name (${name})`);
  }
  if (Buffer.byteLength(name, "utf8") > MAX_INLINE_ATTACHMENT_BASENAME_BYTES) {
    throw new Error(
      `attachments_invalid_name (too long: ${MAX_INLINE_ATTACHMENT_BASENAME_BYTES} bytes)`,
    );
  }
  if (/[. ]$/u.test(name)) {
    throw new Error(`attachments_invalid_name (${name})`);
  }
  const filesystemKey = name.toUpperCase();
  if (
    name === "." ||
    name === ".." ||
    filesystemKey === ".MANIFEST.JSON" ||
    WINDOWS_RESERVED_ATTACHMENT_BASENAME.test(filesystemKey)
  ) {
    throw new Error(`attachments_invalid_name (${name})`);
  }
}

/**
 * Decode and validate inline snapshot bytes without consulting mutable runtime
 * policy. Callers supply their admission limits; durable stores use the stable
 * defaults, while the child-spawn boundary supplies the active config limits.
 */
export function prepareInlineAttachmentSnapshots(params: {
  attachments: InlineAttachment[];
  limits: InlineAttachmentSnapshotLimits;
  requireImageMime?: boolean;
}): { attachments: PreparedInlineAttachmentSnapshot[]; totalBytes: number } {
  if (params.attachments.length > params.limits.maxFiles) {
    throw new Error(`attachments_file_count_exceeded (maxFiles=${params.limits.maxFiles})`);
  }

  const seen = new Set<string>();
  const attachments: PreparedInlineAttachmentSnapshot[] = [];
  let totalBytes = 0;
  for (const raw of params.attachments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("attachments_invalid_member (expected object)");
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.content !== "string") {
      throw new Error("attachments_invalid_member (name and content must be strings)");
    }
    if (item.encoding !== undefined && item.encoding !== "utf8" && item.encoding !== "base64") {
      throw new Error("attachments_invalid_member (encoding must be utf8 or base64)");
    }
    if (item.mimeType !== undefined && typeof item.mimeType !== "string") {
      throw new Error("attachments_invalid_member (mimeType must be a string)");
    }

    const rawName = item.name;
    if (!isWellFormedAttachmentName(rawName) || rawName.includes("\uFFFD")) {
      throw new Error("attachments_invalid_name (invalid Unicode)");
    }
    const name = rawName.normalize("NFC");
    const content = item.content;
    const encoding = item.encoding ?? "utf8";
    const mimeType = normalizeOptionalString(item.mimeType) ?? "";
    validateInlineAttachmentName(name);
    const canonicalNameKey = name.toUpperCase();
    if (seen.has(canonicalNameKey)) {
      throw new Error(`attachments_duplicate_name (${name})`);
    }
    seen.add(canonicalNameKey);
    if (params.requireImageMime && !mimeType.startsWith("image/")) {
      throw new Error(
        `attachments_unsupported_for_acp (name=${name} mimeType=${mimeType || "unknown"})`,
      );
    }

    const buf =
      encoding === "base64"
        ? decodeStrictBase64(content, params.limits.maxFileBytes)
        : Buffer.from(content, "utf8");
    if (!buf) {
      throw new Error("attachments_invalid_base64_or_too_large");
    }
    const bytes = buf.byteLength;
    if (bytes > params.limits.maxFileBytes) {
      throw new Error(
        `attachments_file_bytes_exceeded (name=${name} bytes=${bytes} maxFileBytes=${params.limits.maxFileBytes})`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > params.limits.maxTotalBytes) {
      throw new Error(
        `attachments_total_bytes_exceeded (totalBytes=${totalBytes} maxTotalBytes=${params.limits.maxTotalBytes})`,
      );
    }
    attachments.push({ name, mimeType, buf, bytes });
  }
  return { attachments, totalBytes };
}

export function validateInlineAttachmentSnapshots(params: {
  attachments?: InlineAttachment[];
  limits?: InlineAttachmentSnapshotLimits;
}): string | undefined {
  if (!params.attachments || params.attachments.length === 0) {
    return undefined;
  }
  try {
    prepareInlineAttachmentSnapshots({
      attachments: params.attachments,
      limits: params.limits ?? DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
    });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : "attachments_validation_failed";
  }
}
