/** Load this subprocess runtime only when the plugin is opening an MCP connection. */
export type { JSONRPCMessage as McpMessage } from "@modelcontextprotocol/sdk/types.js";
export { connectMcpClient, disposeMcpClient } from "../agents/mcp-client-lifecycle.js";
export { createMcpStdioClient, type McpStdioClient } from "../agents/mcp-stdio-client.js";
export {
  OpenClawStdioClientTransport,
  type McpStdioDecoder,
  type McpStdioExit,
} from "../agents/mcp-stdio-transport.js";
