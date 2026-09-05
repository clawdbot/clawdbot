/**
 * What the model is told when a Tool Search lookup matches no catalog entry.
 * A miss on a server the MCP runtime recorded as failed is an outage; any other
 * miss gets spelling suggestions plus the recovery path for its surface. The
 * outage comes only from the recorded McpToolCatalogDiagnostic: catalog absence
 * alone never proves a server is down, so an invented `mcp:` id or a filtered
 * server keeps the generic unknown-tool path.
 */
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { McpToolCatalogDiagnostic } from "./agent-bundle-mcp-types.js";
import type {
  ToolSearchCatalogEntry,
  ToolSearchCatalogSession,
  ToolSearchToolContext,
  UnknownToolErrorOptions,
} from "./tool-search-types.js";

// Bounded model-visible text: one short entry per failed server, capped.
const MAX_UNAVAILABLE_MCP_SERVERS = 8;
// Serialized bound. Eight entries with 30-char safe names and this many error
// chars, plus the note, fit under MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS even
// when a batch echoes its full 512-byte query budget with no candidates.
const MAX_UNAVAILABLE_MCP_ERROR_CHARS = 160;
const MCP_CATALOG_ID_SERVER_RE = /^mcp:([^:]+):/u;

export type UnavailableMcpServersNote = {
  unavailableMcpServers: Array<{ server: string; error: string }>;
  note: string;
};

/** Bounded by serialized length: JSON escaping inflates a control character up to sixfold. */
function boundedFailure(diagnostic: McpToolCatalogDiagnostic): string {
  let text = truncateUtf16Safe(diagnostic.message, MAX_UNAVAILABLE_MCP_ERROR_CHARS);
  for (
    let over = JSON.stringify(text).length - 2 - MAX_UNAVAILABLE_MCP_ERROR_CHARS;
    over > 0;
    over = JSON.stringify(text).length - 2 - MAX_UNAVAILABLE_MCP_ERROR_CHARS
  ) {
    text = truncateUtf16Safe(text, text.length - Math.ceil(over / 6));
  }
  return text;
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
 * Adds the recorded failed servers to a search-capable tool result (Code Mode
 * exec/wait, tool_search_code) so the first exec already carries the outage;
 * the in-guest `search` keeps returning a plain array for user code.
 */
export function withUnavailableMcpServers<T extends object>(
  payload: T,
  ctx: Pick<ToolSearchToolContext, "catalogRef">,
): T | (T & UnavailableMcpServersNote) {
  const catalog = ctx.catalogRef?.current;
  const outage = catalog ? describeUnavailableMcpServers(catalog) : undefined;
  return outage ? { ...payload, ...outage } : payload;
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
  return `Tool "${needle}" belongs to MCP server "${diagnostic.safeServerName}", which failed for this run: ${boundedFailure(diagnostic)}. Its tools are absent from the Tool Search catalog. Do not retry searches or calls for it; report the outage and continue without it.`;
}

function tokenizeLookupValue(input: string): Set<string> {
  return new Set(normalizeStringEntries(input.toLowerCase().split(/[^a-z0-9]+/u)));
}

function scoreUnknownToolSuggestion(needle: string, entry: ToolSearchCatalogEntry): number {
  const normalizedNeedle = needle.toLowerCase();
  const name = entry.name.toLowerCase();
  const id = entry.id.toLowerCase();
  const label = (entry.label ?? "").toLowerCase();
  const description = entry.description.toLowerCase();
  const needleTokens = tokenizeLookupValue(needle);
  const entryTokens = tokenizeLookupValue(
    `${entry.name} ${entry.id} ${entry.label ?? ""} ${entry.description}`,
  );
  let score = 0;
  if ((name && normalizedNeedle.includes(name)) || id.includes(normalizedNeedle)) {
    score += 40;
  }
  if (name && needleTokens.has(name)) {
    score += 40;
  }
  for (const token of needleTokens) {
    if (entryTokens.has(token)) {
      score += 12;
    }
  }
  if (label.includes(normalizedNeedle) || description.includes(normalizedNeedle)) {
    score += 8;
  }
  return score;
}

function formatUnknownToolIdError(
  needle: string,
  entries: readonly ToolSearchCatalogEntry[],
  options: UnknownToolErrorOptions = {},
): string {
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const suggestions = uniqueStrings(
    entries
      .map((entry) => ({
        value: options.exactIdOnly || (nameCounts.get(entry.name) ?? 0) > 1 ? entry.id : entry.name,
        score: scoreUnknownToolSuggestion(needle, entry),
      }))
      .filter((candidate) => candidate.score > 0)
      .toSorted((a, b) => b.score - a.score || a.value.localeCompare(b.value))
      .map((candidate) => candidate.value),
  ).slice(0, 3);
  const recoveryText =
    options.recoverySurface === "code-mode"
      ? "Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name."
      : options.recoverySurface === "catalog"
        ? "Use catalog.search to find a callable tool handle, then call the handle or use its describe method."
        : "Use tool_search to find a tool, tool_describe to inspect it, then tool_call with the exact id or name.";
  if (suggestions.length === 0) {
    return `Unknown tool id: ${needle}. ${recoveryText}`;
  }
  return `Unknown tool id: ${needle}. Did you mean: ${suggestions.join(", ")}? ${recoveryText}`;
}

/** Message for a lookup that matched none of `entries`, the visible slice of `catalog`. */
export function formatToolLookupMissError(
  needle: string,
  catalog: ToolSearchCatalogSession,
  entries: readonly ToolSearchCatalogEntry[],
  options?: UnknownToolErrorOptions,
): string {
  const unavailable = findUnavailableMcpServer(needle, catalog);
  return unavailable
    ? formatUnavailableMcpToolError(needle, unavailable)
    : formatUnknownToolIdError(needle, entries, options);
}
