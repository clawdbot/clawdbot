/**
 * What the model is told when a Tool Search lookup matches no catalog entry.
 * A miss on a server the MCP runtime recorded as failed is an outage; any other
 * miss gets the generic recovery text `tool-search-recovery` owns. The outage
 * comes only from the recorded McpToolCatalogDiagnostic: catalog absence alone
 * never proves a server is down, so an invented `mcp:` id or a filtered server
 * keeps the generic unknown-tool path.
 */
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";
import type { McpToolCatalogDiagnostic } from "./agent-bundle-mcp-types.js";
import { formatUnknownToolIdError, type ToolLookupErrorOptions } from "./tool-search-recovery.js";
import type {
  ToolSearchCatalogEntry,
  ToolSearchCatalogSession,
  ToolSearchToolContext,
} from "./tool-search-types.js";

// Bounded model-visible text: one short entry per failed server, capped.
const MAX_UNAVAILABLE_MCP_SERVERS = 8;
// Serialized bound. Eight entries with 30-char safe names and this many error
// chars, plus the note, fit under MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS even
// when a batch echoes its full 512-byte query budget and every group and the
// batch carry the `truncated` flag its dropped candidates leave behind.
export const MAX_UNAVAILABLE_MCP_ERROR_CHARS = 120;
const MCP_CATALOG_ID_SERVER_RE = /^mcp:([^:]+):/u;

export type UnavailableMcpServersNote = {
  unavailableMcpServers: Array<{ server: string; error: string }>;
  note: string;
};

/** Bounded by serialized length: JSON escaping inflates a control character up to sixfold. */
function boundSerializedText(message: string, maxChars: number): string {
  let text = truncateSanitizedExternalContent(message, maxChars).text;
  for (
    let over = JSON.stringify(text).length - 2 - maxChars;
    over > 0;
    over = JSON.stringify(text).length - 2 - maxChars
  ) {
    text = truncateSanitizedExternalContent(text, text.length - Math.ceil(over / 6)).text;
  }
  return text;
}

function boundedFailure(diagnostic: McpToolCatalogDiagnostic): string {
  return boundSerializedText(diagnostic.message, MAX_UNAVAILABLE_MCP_ERROR_CHARS);
}

/** The outage with every error re-bounded to `maxChars`; server names and the note stay whole. */
export function trimUnavailableMcpServerErrors(
  outage: UnavailableMcpServersNote,
  maxChars: number,
): UnavailableMcpServersNote {
  return {
    ...outage,
    unavailableMcpServers: outage.unavailableMcpServers.map((server) => ({
      server: server.server,
      error: boundSerializedText(server.error, maxChars),
    })),
  };
}

/** Search-result addition naming every recorded failed server; undefined when none failed. */
export function describeUnavailableMcpServers(
  catalog: ToolSearchCatalogSession,
): UnavailableMcpServersNote | undefined {
  const diagnostics = catalog.mcpDiagnostics?.diagnostics;
  if (!diagnostics?.length) {
    return undefined;
  }
  const servers = diagnostics.slice(0, MAX_UNAVAILABLE_MCP_SERVERS).map((diagnostic) => ({
    server: diagnostic.safeServerName,
    error: boundedFailure(diagnostic),
  }));
  const names = servers.map((server) => `"${server.server}"`).join(", ");
  const [label, its, them] =
    servers.length > 1 ? ["MCP servers", "their", "them"] : ["MCP server", "its", "it"];
  return {
    unavailableMcpServers: servers,
    note: `${label} ${names} failed for this run, so ${its} tools are absent from this catalog. Do not retry searches or calls for ${them}; report the outage and continue without ${them}.`,
  };
}

/**
 * Adds the recorded failed servers to a tool_search_code result so the first
 * run already carries the outage; the in-guest `search` keeps returning a plain
 * array for user code. The outage leads the payload: the control renderer clips
 * an oversized result from the tail, and the value is what may give way.
 */
export function withUnavailableMcpServers<T extends object>(
  payload: T,
  ctx: Pick<ToolSearchToolContext, "catalogRef">,
): T | (T & UnavailableMcpServersNote) {
  const outage = resolveUnavailableMcpServers(ctx);
  return outage ? { ...outage, ...payload } : payload;
}

/** The run's recorded outage, or undefined when no MCP server failed. */
export function resolveUnavailableMcpServers(
  ctx: Pick<ToolSearchToolContext, "catalogRef">,
): UnavailableMcpServersNote | undefined {
  const catalog = ctx.catalogRef?.current;
  return catalog ? describeUnavailableMcpServers(catalog) : undefined;
}

/**
 * Recorded failed server a lookup names through its catalog id, `mcp:<server>:…`.
 * Only that encoded form proves MCP ownership: a bare or `<server>__…`-shaped
 * name has no catalog entry behind it, so an unrelated or policy-hidden tool
 * keeps the generic unknown-tool recovery.
 */
function findUnavailableMcpServer(
  needle: string,
  catalog: ToolSearchCatalogSession,
): McpToolCatalogDiagnostic | undefined {
  const server = MCP_CATALOG_ID_SERVER_RE.exec(needle)?.[1];
  return server === undefined
    ? undefined
    : catalog.mcpDiagnostics?.diagnostics.find(
        (diagnostic) => diagnostic.safeServerName === server,
      );
}

function formatUnavailableMcpToolError(
  needle: string,
  diagnostic: McpToolCatalogDiagnostic,
): string {
  const failure = wrapExternalContent(boundedFailure(diagnostic), {
    source: "api",
    includeWarning: false,
  });
  return `Tool "${needle}" belongs to MCP server "${diagnostic.safeServerName}", which failed for this run: ${failure}. Its tools are absent from the Tool Search catalog. Do not retry searches or calls for it; report the outage and continue without it.`;
}

/** Message for a lookup that matched none of `entries`, the visible slice of `catalog`. */
export function formatToolLookupMissError(
  needle: string,
  catalog: ToolSearchCatalogSession,
  entries: readonly ToolSearchCatalogEntry[],
  options?: ToolLookupErrorOptions,
): string {
  const unavailable = findUnavailableMcpServer(needle, catalog);
  return unavailable
    ? formatUnavailableMcpToolError(needle, unavailable)
    : formatUnknownToolIdError(needle, entries, options);
}
