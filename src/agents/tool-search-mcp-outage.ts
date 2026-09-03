/** Model-facing MCP outage reporting for Tool Search catalog misses (#137398). */

// When a configured MCP server disconnects, the bundle-MCP runtime drops every
// catalog entry for that server (see agent-bundle-mcp-runtime.ts). A subsequent
// lookup of one of its tools used to loop forever on a generic "Unknown tool id"
// error; this module attributes such id-shaped misses to the owning server so
// the model receives a decisive outage signal and stops re-searching.
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

const MCP_SERVER_OUTAGE_HINT =
  "Do not retry tool_search or tool_call for it; report the MCP server outage and continue without it.";

/**
 * Detect a tool lookup aimed at a currently-absent MCP server.
 *
 * MCP catalog ids use the `mcp:<server>:<tool>` shape (see makeCatalogId), so an
 * id-prefixed miss names its owning server even though every entry of that server
 * has already been dropped from the catalog. Name-only lookups cannot identify a
 * server and stay on the generic unknown-tool path.
 */
export function readDisconnectedMcpServerName(
  needle: string,
  entries: readonly ToolSearchCatalogEntry[],
): string | undefined {
  const match = needle.match(/^mcp:([^:]+):/);
  const serverName = match?.[1];
  if (!serverName) {
    return undefined;
  }
  // The server is only "disconnected" when it owns no remaining catalog entries;
  // a partial id typo against a healthy server keeps the generic error.
  return entries.some(
    (entry) =>
      entry.source === "mcp" &&
      (entry.mcp?.serverName === serverName || entry.sourceName === serverName),
  )
    ? undefined
    : serverName;
}

/**
 * Report the outage instead of a generic unknown-tool error so the model stops
 * re-searching and re-calling a tool whose server is down rather than looping.
 */
export function formatMcpServerOutageError(needle: string, serverName: string): string {
  return (
    `Tool "${needle}" is provided by the MCP server "${serverName}", which is currently ` +
    "unavailable (disconnected or unreachable), so its tools are absent from the Tool Search " +
    `catalog. ${MCP_SERVER_OUTAGE_HINT}`
  );
}
