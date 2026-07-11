import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolResult } from "./runtime/index.js";

export type McpAgentContentBlock = AgentToolResult<unknown>["content"][number];

/** Converts the full MCP content union into the agent text/image contract. */
export function mcpContentBlockToAgentContent(block: ContentBlock): McpAgentContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      if (block.data && block.mimeType) {
        return { type: "image", data: block.data, mimeType: block.mimeType };
      }
      return { type: "text", text: JSON.stringify(block) };
    case "audio":
      return { type: "text", text: `[audio ${block.mimeType}]` };
    case "resource_link": {
      const label = block.title ?? block.name;
      return { type: "text", text: label ? `[${label}] ${block.uri}` : block.uri };
    }
    case "resource": {
      const resource = block.resource;
      const text = "text" in resource ? resource.text : undefined;
      return { type: "text", text: text ?? resource.uri };
    }
    default:
      return { type: "text", text: JSON.stringify(block) };
  }
}
