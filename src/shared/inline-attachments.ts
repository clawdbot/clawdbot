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
