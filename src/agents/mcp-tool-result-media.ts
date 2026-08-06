import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { mediaKindFromMime, maxBytesForKind } from "@openclaw/media-core/constants";
import { extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { logWarn } from "../logger.js";
import { resolveOutboundAttachmentFromBuffer } from "../media/outbound-attachment.js";
import { markHostOwnedMcpRelayMedia } from "./mcp-tool-result-media-provenance.js";

type McpRelayMediaType = "image" | "audio";

export type McpRelayMediaAttachment = {
  type: McpRelayMediaType;
  mediaUrl: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
};

export type McpRelayMedia = {
  source: "mcp";
  attachments: readonly McpRelayMediaAttachment[];
};

type McpRelayMediaBudget = {
  attachmentCount: number;
  decodedBytes: number;
};

const MAX_MCP_RELAY_MEDIA_ATTACHMENTS_PER_RESULT = 8;
const MAX_MCP_RELAY_MEDIA_BYTES_PER_RESULT = 32 * 1024 * 1024;

function mcpAttachmentFileName(params: {
  serverName: string;
  toolName: string;
  index: number;
  mimeType: string;
}): string {
  const ext = extensionForMime(params.mimeType);
  return `${params.serverName}-${params.toolName}-${params.index}${ext ?? ""}`.replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  );
}

function canFitMcpRelayMediaBudget(params: {
  budget: McpRelayMediaBudget;
  estimatedBytes: number;
  serverName: string;
  toolName: string;
  type: McpRelayMediaType;
}): boolean {
  if (params.budget.attachmentCount >= MAX_MCP_RELAY_MEDIA_ATTACHMENTS_PER_RESULT) {
    logWarn(
      `bundle-mcp: skipping ${params.type} content from ${params.serverName}/${params.toolName}: ` +
        `MCP media attachment count limit reached (${MAX_MCP_RELAY_MEDIA_ATTACHMENTS_PER_RESULT})`,
    );
    return false;
  }
  if (params.budget.decodedBytes + params.estimatedBytes > MAX_MCP_RELAY_MEDIA_BYTES_PER_RESULT) {
    logWarn(
      `bundle-mcp: skipping ${params.type} content from ${params.serverName}/${params.toolName}: ` +
        `MCP media decoded-byte limit reached (${MAX_MCP_RELAY_MEDIA_BYTES_PER_RESULT} bytes)`,
    );
    return false;
  }
  return true;
}

function reserveMcpRelayMediaBudget(budget: McpRelayMediaBudget, decodedBytes: number): void {
  budget.attachmentCount += 1;
  budget.decodedBytes += decodedBytes;
}

function releaseMcpRelayMediaBudget(budget: McpRelayMediaBudget, decodedBytes: number): void {
  budget.attachmentCount = Math.max(0, budget.attachmentCount - 1);
  budget.decodedBytes = Math.max(0, budget.decodedBytes - decodedBytes);
}

async function stageMcpBinaryAttachment(params: {
  serverName: string;
  toolName: string;
  index: number;
  type: McpRelayMediaType;
  data: string;
  mimeType: string;
  budget: McpRelayMediaBudget;
}): Promise<McpRelayMediaAttachment | undefined> {
  const mimeType = normalizeMimeType(params.mimeType);
  if (!mimeType || mediaKindFromMime(mimeType) !== params.type) {
    logWarn(
      `bundle-mcp: skipping ${params.type} content from ${params.serverName}/${params.toolName}: ` +
        `unsupported MIME type (${params.mimeType || "missing"})`,
    );
    return undefined;
  }

  const maxBytes = maxBytesForKind(params.type);
  const estimatedBytes = estimateBase64DecodedBytes(params.data);
  if (estimatedBytes === 0 || estimatedBytes > maxBytes) {
    logWarn(
      `bundle-mcp: skipping ${params.type} content from ${params.serverName}/${params.toolName}: ` +
        `MCP content size ${estimatedBytes} bytes is outside the limit (${maxBytes} bytes)`,
    );
    return undefined;
  }
  if (
    !canFitMcpRelayMediaBudget({
      budget: params.budget,
      estimatedBytes,
      serverName: params.serverName,
      toolName: params.toolName,
      type: params.type,
    })
  ) {
    return undefined;
  }

  let decodedBytes = 0;
  let budgetReserved = false;
  try {
    // The aggregate preflight above intentionally runs before canonicalization,
    // which allocates a cleaned copy for whitespace or unpadded input.
    const canonicalBase64 = canonicalizeBase64(params.data);
    if (!canonicalBase64) {
      throw new Error("MCP content has invalid base64 data");
    }
    const buffer = Buffer.from(canonicalBase64, "base64");
    decodedBytes = buffer.byteLength;
    if (decodedBytes === 0 || decodedBytes > maxBytes) {
      throw new Error(`MCP content size ${decodedBytes} bytes exceeds ${maxBytes} bytes`);
    }
    if (
      !canFitMcpRelayMediaBudget({
        budget: params.budget,
        estimatedBytes: decodedBytes,
        serverName: params.serverName,
        toolName: params.toolName,
        type: params.type,
      })
    ) {
      return undefined;
    }
    reserveMcpRelayMediaBudget(params.budget, decodedBytes);
    budgetReserved = true;

    const name = mcpAttachmentFileName({
      serverName: params.serverName,
      toolName: params.toolName,
      index: params.index,
      mimeType,
    });
    const staged = await resolveOutboundAttachmentFromBuffer(buffer, maxBytes, {
      contentType: mimeType,
      filename: name,
    });
    return {
      type: params.type,
      mediaUrl: staged.path,
      mimeType: staged.contentType ?? mimeType,
      name,
      sizeBytes: decodedBytes,
    };
  } catch (error) {
    if (budgetReserved) {
      releaseMcpRelayMediaBudget(params.budget, decodedBytes);
    }
    logWarn(
      `bundle-mcp: could not stage ${params.type} content from ${params.serverName}/${params.toolName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

async function stageMcpContentBlock(params: {
  serverName: string;
  toolName: string;
  block: ContentBlock;
  index: number;
  budget: McpRelayMediaBudget;
}): Promise<McpRelayMediaAttachment | undefined> {
  if (params.block.type !== "image" && params.block.type !== "audio") {
    return undefined;
  }
  if (!params.block.data || !params.block.mimeType) {
    return undefined;
  }
  return await stageMcpBinaryAttachment({
    serverName: params.serverName,
    toolName: params.toolName,
    index: params.index,
    type: params.block.type,
    data: params.block.data,
    mimeType: params.block.mimeType,
    budget: params.budget,
  });
}

export async function stageMcpRelayMedia(params: {
  serverName: string;
  toolName: string;
  content: readonly ContentBlock[];
}): Promise<McpRelayMedia | undefined> {
  const attachments: McpRelayMediaAttachment[] = [];
  const budget: McpRelayMediaBudget = { attachmentCount: 0, decodedBytes: 0 };
  for (const [index, block] of params.content.entries()) {
    const attachment = await stageMcpContentBlock({
      serverName: params.serverName,
      toolName: params.toolName,
      block,
      index,
      budget,
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }
  if (attachments.length === 0) {
    return undefined;
  }
  const immutableAttachments = Object.freeze(
    attachments.map((attachment) => Object.freeze({ ...attachment })),
  );
  return markHostOwnedMcpRelayMedia(
    Object.freeze({ source: "mcp" as const, attachments: immutableAttachments }),
  );
}
