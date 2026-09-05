import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  applyToolCatalogCompaction,
  collectUniqueCatalogToolNames,
  isDirectVisibleCatalogTool,
  resolveCatalog,
  visibleCatalogEntries,
} from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import {
  TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES,
  TOOL_SEARCH_CONTROL_TOOL_NAMES,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type CatalogVisibilityOptions,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
  type ToolSearchMode,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import { ToolInputError, type AnyAgentTool } from "./tools/common.js";

export const MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS = 18_000;
const TOOL_DIRECTORY_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
// Catalog entry arrays are immutable snapshots. Keying their rendered directory by
// array identity preserves prompt-prefix bytes without retaining retired catalogs.
const toolSchemaDirectoryPromptCache = new WeakMap<ToolSearchCatalogEntry[], Map<string, string>>();

export function applyToolSchemaDirectoryCatalog(params: {
  tools: AnyAgentTool[];
  config?: Parameters<typeof resolveToolSearchConfig>[0];
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: Parameters<typeof applyToolCatalogCompaction>[0]["toolHookContext"];
  directToolNames?: Iterable<string>;
}) {
  const config = resolveToolSearchConfig(params.config);
  if (!config.enabled) {
    return {
      tools: params.tools,
      compacted: false,
      catalogToolCount: 0,
      catalogRegistered: false,
      catalogReused: false,
    };
  }
  if (!params.tools.some((tool) => tool.name === TOOL_SEARCH_RAW_TOOL_NAME)) {
    return {
      tools: params.tools.filter((tool) => !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)),
      compacted: false,
      catalogToolCount: 0,
      catalogRegistered: false,
      catalogReused: false,
    };
  }
  const directToolNames = new Set(normalizeStringEntries(Array.from(params.directToolNames ?? [])));
  const uniqueCatalogToolNames = collectUniqueCatalogToolNames(params.tools);
  return applyToolCatalogCompaction({
    ...params,
    enabled: config.enabled,
    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    // The unique-name gate defers any cross-source name collision before the
    // shared trust check runs.
    isVisibleCatalogTool: (tool) =>
      uniqueCatalogToolNames.has(tool.name) && isDirectVisibleCatalogTool(tool, directToolNames),
  });
}

export function buildToolSchemaDirectoryPrompt(
  ctx: ToolSearchToolContext,
  options?: CatalogVisibilityOptions,
): string {
  const config = resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config);
  const catalog = resolveCatalog(ctx);
  const cacheKey = `${config.mode}:${options?.includeMcp === false ? "without-mcp" : "all"}`;
  let cachedPrompts = toolSchemaDirectoryPromptCache.get(catalog.entries);
  const cachedPrompt = cachedPrompts?.get(cacheKey);
  if (cachedPrompt !== undefined) {
    return cachedPrompt;
  }
  const prompt = formatToolSearchCatalogDirectory(
    visibleCatalogEntries(catalog, options),
    config.mode,
  );
  if (!cachedPrompts) {
    cachedPrompts = new Map<string, string>();
    toolSchemaDirectoryPromptCache.set(catalog.entries, cachedPrompts);
  }
  cachedPrompts.set(cacheKey, prompt);
  return prompt;
}

export function resolveToolSearchCatalogTool(
  ctx: ToolSearchToolContext,
  name: unknown,
  options?: CatalogVisibilityOptions,
): AnyAgentTool | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const needle = name.trim();
  if (!needle) {
    return undefined;
  }
  try {
    const matches = visibleCatalogEntries(resolveCatalog(ctx), options).filter(
      (entry) => entry.name === needle,
    );
    return matches.length === 1 ? (matches[0]?.tool as AnyAgentTool | undefined) : undefined;
  } catch (error) {
    if (error instanceof ToolInputError) {
      return undefined;
    }
    throw error;
  }
}

function compactDirectoryDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, 177).trimEnd()}...`;
}

function formatToolDirectoryIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && TOOL_DIRECTORY_IDENTIFIER_RE.test(trimmed) ? trimmed : undefined;
}

function formatToolDirectoryEntry(entry: ToolSearchCatalogEntry): string | undefined {
  if (entry.source !== "openclaw") {
    return undefined;
  }
  const name = formatToolDirectoryIdentifier(entry.name);
  if (!name) {
    return undefined;
  }
  const description = compactDirectoryDescription(entry.description);
  const ownerName = formatToolDirectoryIdentifier(entry.sourceName);
  const owner = ownerName ? ` (${ownerName})` : "";
  return `- ${name}${owner}: ${description || "No description."}`;
}

function formatToolSearchCatalogDirectory(
  entries: ToolSearchCatalogEntry[],
  mode: ToolSearchMode,
): string {
  if (entries.length === 0) {
    return "Available deferred-schema tools: none.";
  }
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const lines = entries
    .filter((entry) => nameCounts.get(entry.name) === 1)
    .toSorted(
      (left, right) =>
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .map(formatToolDirectoryEntry)
    .filter((line): line is string => Boolean(line));
  const heading = "Available deferred-schema tools:";
  const notice = "Policy-approved MCP and client tools may also be discoverable through search.";
  const omittedLabel = " additional tools omitted. ";
  // Each line includes its newline; three fixed separators remain outside the rows.
  let lineChars = lines.reduce((chars, line) => chars + line.length + 1, 0);
  let omitted = entries.length - lines.length;
  let guidance: string;
  for (;;) {
    guidance =
      mode === "code"
        ? "Use tool_search_code with openclaw.tools.search(query), openclaw.tools.describe(id), and openclaw.tools.call(id, args)."
        : omitted > 0
          ? "Use tool_search to find them, then tool_describe to load a full schema before tool_call."
          : "Call tool_describe with a listed tool name to load its full schema before using tool_call.";
    const footerChars =
      guidance.length + (omitted > 0 ? String(omitted).length + omittedLabel.length : 0);
    if (
      heading.length + lineChars + notice.length + footerChars + 3 <=
        MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS ||
      lines.length === 0
    ) {
      break;
    }
    // SAFETY: this renderer owns the nonempty, dense formatted-line array.
    // Remove excluded rows before materializing the bounded directory.
    lineChars -= lines.pop()!.length + 1;
    omitted += 1;
  }
  const footer = omitted > 0 ? `${omitted}${omittedLabel}${guidance}` : guidance;
  return [heading, ...lines, "", notice, footer].join("\n");
}
