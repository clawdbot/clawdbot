import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { boundedJsonUtf8Bytes, jsonUtf8BytesOrInfinity } from "../infra/json-utf8-bytes.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

const MCP_TEXT_CONTENT_MAX_BYTES = 1024 * 1024;
const MCP_TEXT_TRUNCATION_MARKER = "\n[truncated: MCP text content exceeded 1 MB]";

const MCP_INVOKE_PAYLOAD_MAX_BYTES = 20 * 1024 * 1024;
const MCP_PAYLOAD_TRUNCATION_MARKER = "[truncated: MCP result exceeded 20 MB]";

type McpInvokeContentBlock = Record<string, unknown>;

/** Bounds MCP result content before it crosses node.invoke. */
export function boundMcpToolResultPayload(result: {
  content: readonly unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}): {
  content: McpInvokeContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
} {
  const payloadMarker = { type: "text" as const, text: MCP_PAYLOAD_TRUNCATION_MARKER };
  const reservedMarkerBytes = jsonUtf8BytesOrInfinity(payloadMarker) + 1;
  const isError = result.isError === true;
  let usedBytes = jsonUtf8BytesOrInfinity({ content: [], ...(isError ? { isError } : {}) });
  let payloadTruncated = false;
  let structuredContent: Record<string, unknown> | undefined;
  if (result.structuredContent) {
    const prefixBytes = Buffer.byteLength(',"structuredContent":');
    const availableBytes = Math.max(
      0,
      MCP_INVOKE_PAYLOAD_MAX_BYTES - usedBytes - prefixBytes - reservedMarkerBytes,
    );
    const measured = boundedJsonUtf8Bytes(result.structuredContent, availableBytes);
    if (measured.complete && measured.bytes <= availableBytes) {
      structuredContent = result.structuredContent;
      usedBytes += prefixBytes + measured.bytes;
    } else {
      payloadTruncated = true;
    }
  }
  const mirroredStructuredContent = structuredContent
    ? JSON.stringify(structuredContent, null, 2)
    : undefined;
  const normalizedBlocks = result.content.filter(
    (block): block is McpInvokeContentBlock =>
      isRecord(block) &&
      (mirroredStructuredContent === undefined ||
        block.type !== "text" ||
        block.text !== mirroredStructuredContent),
  );
  const totalTextBytes = normalizedBlocks.reduce<number>(
    (total, block) =>
      total +
      (block.type === "text" && typeof block.text === "string" ? Buffer.byteLength(block.text) : 0),
    0,
  );
  let remainingTextBytes =
    totalTextBytes > MCP_TEXT_CONTENT_MAX_BYTES
      ? MCP_TEXT_CONTENT_MAX_BYTES - Buffer.byteLength(MCP_TEXT_TRUNCATION_MARKER)
      : MCP_TEXT_CONTENT_MAX_BYTES;
  let markedTruncated = false;
  const textBoundedContent: McpInvokeContentBlock[] = [];
  for (const block of normalizedBlocks) {
    if (block.type !== "text" || typeof block.text !== "string") {
      textBoundedContent.push(block);
      continue;
    }
    if (totalTextBytes <= MCP_TEXT_CONTENT_MAX_BYTES) {
      textBoundedContent.push(block);
      continue;
    }
    if (markedTruncated) {
      continue;
    }
    const text = truncateUtf8Prefix(block.text, remainingTextBytes);
    remainingTextBytes -= Buffer.byteLength(text);
    const blockWasTruncated = text.length < block.text.length;
    if (text || blockWasTruncated) {
      textBoundedContent.push({
        ...block,
        text: blockWasTruncated ? `${text}${MCP_TEXT_TRUNCATION_MARKER}` : text,
      });
    }
    if (blockWasTruncated || remainingTextBytes === 0) {
      if (!blockWasTruncated) {
        textBoundedContent.push({ type: "text", text: MCP_TEXT_TRUNCATION_MARKER.trimStart() });
      }
      markedTruncated = true;
    }
  }
  const content: McpInvokeContentBlock[] = [];
  for (const block of textBoundedContent) {
    const separatorBytes = content.length > 0 ? 1 : 0;
    const availableBytes = Math.max(
      0,
      MCP_INVOKE_PAYLOAD_MAX_BYTES - usedBytes - separatorBytes - reservedMarkerBytes,
    );
    const measured = boundedJsonUtf8Bytes(block, availableBytes);
    if (!measured.complete || measured.bytes > availableBytes) {
      payloadTruncated = true;
      continue;
    }
    content.push(block);
    usedBytes += measured.bytes + separatorBytes;
  }
  if (payloadTruncated) {
    content.push(payloadMarker);
  }
  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError } : {}),
  };
}
