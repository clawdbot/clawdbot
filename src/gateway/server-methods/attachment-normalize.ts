// Attachment normalization accepts permissive RPC attachment payloads and turns
// them into the bounded chat attachment shape used by gateway chat methods.
import type { ChatAttachment } from "../chat-attachments.js";

/** RPC attachment payload shape accepted by chat-like gateway methods. */
export type RpcAttachmentInput = {
  type?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
  content?: unknown;
  sizeBytes?: unknown;
  durationMs?: unknown;
  width?: unknown;
  height?: unknown;
  source?: unknown;
};

function normalizeAttachmentContent(content: unknown): string | undefined {
  // RPC callers may send browser ArrayBuffers, typed-array slices, or base64
  // strings. Normalize all accepted forms to the chat attachment wire shape.
  if (typeof content === "string") {
    return content;
  }
  if (ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("base64");
  }
  if (content instanceof ArrayBuffer) {
    return Buffer.from(content).toString("base64");
  }
  return undefined;
}

function normalizeAttachmentNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Convert permissive RPC attachment payloads into the bounded chat attachment shape. */
export function normalizeRpcAttachmentsToChatAttachments(
  attachments: RpcAttachmentInput[] | undefined,
): ChatAttachment[] {
  // Accept both the OpenClaw attachment fields and Anthropic-style
  // source:{type:"base64",media_type,data} payloads used by some clients.
  return (
    attachments
      ?.map((a) => {
        const source = a?.source && typeof a.source === "object" ? a.source : undefined;
        const sourceRecord = source as
          | { type?: unknown; media_type?: unknown; data?: unknown }
          | undefined;
        const sourceType = typeof sourceRecord?.type === "string" ? sourceRecord.type : undefined;
        const sourceMimeType =
          typeof sourceRecord?.media_type === "string" ? sourceRecord.media_type : undefined;
        const sourceContent =
          sourceType === "base64" ? normalizeAttachmentContent(sourceRecord?.data) : undefined;
        const sizeBytes = normalizeAttachmentNumber(a?.sizeBytes);
        const durationMs = normalizeAttachmentNumber(a?.durationMs);
        const width = normalizeAttachmentNumber(a?.width);
        const height = normalizeAttachmentNumber(a?.height);

        return {
          type: typeof a?.type === "string" ? a.type : undefined,
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : sourceMimeType,
          fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
          content: normalizeAttachmentContent(a?.content) ?? sourceContent,
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        };
      })
      .filter((a) => a.content) ?? []
  );
}
