import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentToolResult } from "./runtime/index.js";

type McpAgentContentBlock = AgentToolResult<unknown>["content"][number];

function stringifyMcpContent(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Converts untrusted MCP content into the agent text/image contract. */
function mcpContentBlockToAgentContent(block: unknown): McpAgentContentBlock {
  if (!isRecord(block)) {
    return { type: "text", text: stringifyMcpContent(block) };
  }
  switch (block.type) {
    case "text":
      if (typeof block.text === "string") {
        return { type: "text", text: block.text };
      }
      break;
    case "image":
      if (typeof block.data === "string" && typeof block.mimeType === "string") {
        return { type: "image", data: block.data, mimeType: block.mimeType };
      }
      break;
    case "audio":
      if (typeof block.mimeType === "string") {
        return { type: "text", text: `[audio ${block.mimeType}]` };
      }
      break;
    case "resource_link": {
      if (typeof block.uri !== "string") {
        break;
      }
      const label =
        typeof block.title === "string"
          ? block.title
          : typeof block.name === "string"
            ? block.name
            : undefined;
      return { type: "text", text: label ? `[${label}] ${block.uri}` : block.uri };
    }
    case "resource": {
      if (!isRecord(block.resource) || typeof block.resource.uri !== "string") {
        break;
      }
      const text = typeof block.resource.text === "string" ? block.resource.text : undefined;
      return { type: "text", text: text ?? block.resource.uri };
    }
  }
  return { type: "text", text: stringifyMcpContent(block) };
}

function projectMcpCallToolResultContent(result: {
  content?: unknown;
  structuredContent?: unknown;
}): AgentToolResult<unknown>["content"] {
  const sourceContent = Array.isArray(result.content) ? result.content : [];
  if (isRecord(result.structuredContent)) {
    return [
      {
        type: "text",
        text: `structuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}`,
      },
      ...sourceContent
        .filter((block) => !isRecord(block) || block.type !== "text")
        .map(mcpContentBlockToAgentContent),
    ];
  }
  return sourceContent.map(mcpContentBlockToAgentContent);
}

/** Projects a raw MCP CallToolResult exactly once at the model boundary. */
export function projectMcpCallToolResult(
  result: { content?: unknown; structuredContent?: unknown; isError?: unknown },
  details: Record<string, unknown> = {},
): AgentToolResult<unknown> {
  const isError = result.isError === true;
  const content = projectMcpCallToolResultContent(result);
  return {
    content:
      content.length > 0
        ? content
        : [
            {
              type: "text",
              text: isError
                ? "MCP tool failed without returning content."
                : "MCP tool completed without returning content.",
            },
          ],
    details: {
      ...details,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(isError ? { status: "error" } : {}),
    },
  };
}
