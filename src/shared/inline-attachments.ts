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

function validateInlineAttachmentName(name: string): void {
  if (!name) {
    throw new Error("attachments_invalid_name (empty)");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\u0000")) {
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
  if (name === "." || name === ".." || name === ".manifest.json") {
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

    const name = normalizeOptionalString(item.name) ?? "";
    const content = item.content;
    const encoding = item.encoding ?? "utf8";
    const mimeType = normalizeOptionalString(item.mimeType) ?? "";
    validateInlineAttachmentName(name);
    if (seen.has(name)) {
      throw new Error(`attachments_duplicate_name (${name})`);
    }
    seen.add(name);
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
