/**
 * Reads the `codex_apps` tool inventory from `mcpServerStatus/list`, grouped by
 * connector (app) id, with the connector metadata Codex uses to name tools.
 */
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readCodexMcpToolConnectorId, readCodexMcpToolConnectorName } from "./mcp-tool-metadata.js";
import { isJsonObject } from "./protocol.js";

export const CODEX_APPS_MCP_SERVER = "codex_apps";
const MCP_STATUS_PAGE_SIZE = 100;
const MCP_STATUS_MAX_PAGES = 100;

export type CodexAppToolRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** One raw `codex_apps` server tool plus the connector metadata Codex names it by. */
export type CodexAppServerTool = {
  /** Raw MCP tool name as the `codex_apps` server lists it. */
  name: string;
  connectorId: string;
  connectorName?: string;
  title?: string;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

/** Reads every `codex_apps` tool carrying a connector id, grouped by that id. */
export async function readCodexAppToolsByConnector(params: {
  request: CodexAppToolRequest;
  threadId?: string;
}): Promise<Map<string, CodexAppServerTool[]>> {
  const toolsByApp = new Map<string, CodexAppServerTool[]>();
  const seenCursors = new Set<string>();
  let cursor: string | null | undefined;
  for (let page = 0; page < MCP_STATUS_MAX_PAGES; page += 1) {
    const response = await params.request("mcpServerStatus/list", {
      ...(params.threadId ? { threadId: params.threadId } : {}),
      detail: "toolsAndAuthOnly",
      limit: MCP_STATUS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!isJsonObject(response) || !Array.isArray(response.data)) {
      throw new Error("Codex mcpServerStatus/list returned invalid scheduled app inventory");
    }
    for (const status of response.data) {
      if (!isJsonObject(status) || !isJsonObject(status.tools)) {
        throw new Error("Codex scheduled app inventory contained an invalid server status");
      }
      if (status.name !== CODEX_APPS_MCP_SERVER) {
        continue;
      }
      for (const [toolName, tool] of Object.entries(status.tools)) {
        const connectorId = readCodexMcpToolConnectorId(tool);
        if (!connectorId) {
          continue;
        }
        const metadata = asOptionalRecord(tool);
        const annotations = asOptionalRecord(metadata?.annotations);
        const connectorName = readCodexMcpToolConnectorName(tool);
        const tools = toolsByApp.get(connectorId) ?? [];
        tools.push({
          name: toolName,
          connectorId,
          ...(connectorName ? { connectorName } : {}),
          title: typeof metadata?.title === "string" ? metadata.title : undefined,
          destructiveHint: annotations?.destructiveHint === false ? false : undefined,
          openWorldHint: annotations?.openWorldHint === false ? false : undefined,
        });
        toolsByApp.set(connectorId, tools);
      }
    }
    if (
      response.nextCursor !== undefined &&
      response.nextCursor !== null &&
      typeof response.nextCursor !== "string"
    ) {
      throw new Error("Codex scheduled app inventory returned an invalid pagination cursor");
    }
    cursor = response.nextCursor;
    if (!cursor) {
      return toolsByApp;
    }
    if (seenCursors.has(cursor)) {
      throw new Error("Codex app connector inventory repeated its pagination cursor");
    }
    seenCursors.add(cursor);
  }
  throw new Error("Codex app connector inventory exceeded its bounded page limit");
}
