import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  applyToolCatalogCompaction,
  classifyTool,
  collectUniqueCatalogToolNames,
  compactToolSearchCatalogEntry,
  resolveCatalog,
  visibleCatalogEntries,
} from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES,
  TOOL_SEARCH_CONTROL_TOOL_NAMES,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type CatalogVisibilityOptions,
  type ToolSearchCatalogRef,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import { ToolInputError, type AnyAgentTool } from "./tools/common.js";

export const MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS = 18_000;
const TOOL_DIRECTORY_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

type ToolSearchDirectoryIntent = {
  tokens: Set<string>;
  hasUrl: boolean;
  hasFilePath: boolean;
  hasMention: boolean;
  hasSchedule: boolean;
  hasCurrentFact: boolean;
  hasMemoryRecall: boolean;
};
type ToolDirectoryFamily = "memory" | "web";

export function applyToolSchemaDirectoryCatalog(params: {
  tools: AnyAgentTool[];
  config?: Parameters<typeof resolveToolSearchConfig>[0];
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: Parameters<typeof applyToolCatalogCompaction>[0]["toolHookContext"];
  hydrateToolNames?: Iterable<string>;
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
  const hydrateToolNames = new Set(
    normalizeStringEntries(Array.from(params.hydrateToolNames ?? [])),
  );
  const uniqueCatalogToolNames = collectUniqueCatalogToolNames(params.tools);
  return applyToolCatalogCompaction({
    ...params,
    enabled: config.enabled,
    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    isVisibleCatalogTool: (tool) =>
      hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name),
  });
}

export function buildToolSchemaDirectoryPrompt(
  ctx: ToolSearchToolContext,
  options?: CatalogVisibilityOptions,
): string {
  const runtime = new ToolSearchRuntime(
    ctx,
    resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config),
  );
  return formatToolSearchCatalogDirectory(runtime.all(options));
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

function formatToolDirectoryEntry(
  entry: ReturnType<typeof compactToolSearchCatalogEntry>,
): string | undefined {
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

function renderToolSearchCatalogDirectory(lines: string[], total: number): string {
  const omitted = total - lines.length;
  const footer =
    omitted > 0
      ? `${omitted} additional tools omitted. Use tool_search to find them, then tool_describe to load a full schema before tool_call.`
      : "Call tool_describe with a listed tool name to load its full schema before using tool_call.";
  return ["Available deferred-schema tools:", ...lines, "", footer].join("\n");
}

function formatToolSearchCatalogDirectory(
  entries: Array<ReturnType<typeof compactToolSearchCatalogEntry>>,
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
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map(formatToolDirectoryEntry)
    .filter((line): line is string => Boolean(line));
  const fullDirectory = renderToolSearchCatalogDirectory(lines, entries.length);
  if (fullDirectory.length <= MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS) {
    return fullDirectory;
  }
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      renderToolSearchCatalogDirectory(lines.slice(0, middle), entries.length).length <=
      MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return renderToolSearchCatalogDirectory(lines.slice(0, low), entries.length);
}

const TOOL_DIRECTORY_HYDRATION_KEYWORDS: Array<{
  terms: readonly string[];
  toolHints: readonly string[];
  weight: number;
}> = [
  {
    terms: ["search", "lookup", "look", "find", "current", "today", "price", "latest", "news"],
    toolHints: ["searxng", "web"],
    weight: 8,
  },
  {
    terms: ["url", "link", "page", "fetch", "read", "article", "http", "https"],
    toolHints: ["fetch", "browser"],
    weight: 8,
  },
  {
    terms: ["send", "reply", "message", "post", "react", "embed", "discord", "imessage"],
    toolHints: ["message", "session", "send"],
    weight: 7,
  },
  {
    terms: ["file", "path", "read", "write", "edit", "patch", "grep", "list"],
    toolHints: ["read", "write", "edit", "grep", "find", "ls", "patch"],
    weight: 6,
  },
  {
    terms: ["run", "command", "shell", "terminal", "build", "test", "pnpm", "git"],
    toolHints: ["exec", "process"],
    weight: 7,
  },
  {
    terms: [
      "remember",
      "recall",
      "memory",
      "memories",
      "known",
      "history",
      "previous",
      "prior",
      "earlier",
      "decided",
      "decision",
      "discussed",
    ],
    toolHints: ["memory"],
    weight: 6,
  },
  {
    terms: ["remind", "schedule", "later", "tomorrow", "daily", "weekly", "cron"],
    toolHints: ["cron", "automation", "heartbeat"],
    weight: 8,
  },
  {
    terms: ["image", "picture", "photo", "meme", "gif", "screenshot", "visual"],
    toolHints: ["image", "vision", "browser"],
    weight: 6,
  },
  {
    terms: ["audio", "voice", "speak", "tts", "transcribe"],
    toolHints: ["audio", "voice", "tts"],
    weight: 6,
  },
];

function tokenize(input: string): string[] {
  return normalizeStringEntries(input.toLowerCase().split(/[^a-z0-9_./:-]+/u));
}

function readToolDirectoryIntent(query: string): ToolSearchDirectoryIntent {
  const tokens = new Set(tokenize(query));
  const hasCurrentFact = ["current", "today", "latest", "price", "weather", "news"].some((term) =>
    tokens.has(term),
  );
  const hasExplicitMemoryRecall = [
    "remember",
    "recall",
    "memory",
    "memories",
    "known",
    "history",
    "previous",
    "prior",
    "earlier",
    "decided",
    "decision",
    "discussed",
  ].some((term) => tokens.has(term));
  const hasIdentityRecall =
    /\b(?:do you know|who (?:is|are|was)|what did (?:we|i|you|they)|when did (?:we|i|you|they))\b/iu.test(
      query,
    );
  return {
    tokens,
    hasUrl: tokens.has("http") || tokens.has("https") || /https?:\/\//iu.test(query),
    hasFilePath: tokens.has("/") || /(^|\s)(\.{1,2}\/|\/|[a-z]:\\)/iu.test(query),
    hasMention: /<@!?\d+>/u.test(query) || tokens.has("discord"),
    hasSchedule: ["remind", "schedule", "later", "tomorrow", "daily", "weekly", "cron"].some(
      (term) => tokens.has(term),
    ),
    hasCurrentFact,
    hasMemoryRecall: hasExplicitMemoryRecall || (hasIdentityRecall && !hasCurrentFact),
  };
}

function classifyDirectoryToolFamilies(
  tool: Pick<AnyAgentTool, "name" | "description">,
  intent: ToolSearchDirectoryIntent,
): Set<ToolDirectoryFamily> {
  const toolText = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  const families = new Set<ToolDirectoryFamily>();
  if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)) {
    return families;
  }
  const hasMemoryToolSignal =
    /\b(?:memory|memories|recall|remember|history|prior|knowledge|libravdb)\b/iu.test(toolText) ||
    /(?:^|_)(?:memory|recall|remember|libravdb)(?:_|$)/iu.test(tool.name);
  const hasWebToolSignal =
    /\b(?:web|internet|online|browser|url|http|https|page|article|fetch|crawl|searxng|google|bing|brave|tavily|duckduckgo|serp)\b/iu.test(
      toolText,
    ) ||
    /(?:^|_)(?:web|fetch|browser|searxng|google|bing|brave|tavily|duckduckgo|serp)(?:_|$)/iu.test(
      tool.name,
    );
  const hasWebIntent =
    intent.hasUrl ||
    intent.hasCurrentFact ||
    ["search", "lookup", "look", "find", "current", "today", "price", "latest", "news"].some(
      (term) => intent.tokens.has(term),
    );
  if (hasWebToolSignal && hasWebIntent) {
    families.add("web");
  }
  if (hasMemoryToolSignal && intent.hasMemoryRecall) {
    families.add("memory");
  }
  return families;
}

function scoreDirectoryTool(
  tool: Pick<AnyAgentTool, "name" | "description">,
  intent: ToolSearchDirectoryIntent,
) {
  const toolText = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  const toolTokens = new Set(tokenize(toolText));
  let score = 0;
  for (const token of toolTokens) {
    if (intent.tokens.has(token)) {
      score += 2;
    }
  }
  for (const group of TOOL_DIRECTORY_HYDRATION_KEYWORDS) {
    if (
      group.terms.some((term) => intent.tokens.has(term)) &&
      group.toolHints.some((hint) => toolText.includes(hint))
    ) {
      score += group.weight;
    }
  }
  if (intent.hasUrl && /fetch|browser|web/iu.test(toolText)) {
    score += 10;
  }
  if (intent.hasFilePath && /read|write|edit|grep|find|ls|file|patch/iu.test(toolText)) {
    score += 8;
  }
  if (intent.hasMention && /message|discord|react|send/iu.test(toolText)) {
    score += 8;
  }
  if (intent.hasSchedule && /cron|schedule|remind|heartbeat|automation/iu.test(toolText)) {
    score += 8;
  }
  if (
    intent.hasCurrentFact &&
    /searxng|web|internet|online|fetch|weather|finance|price|google|bing|brave|tavily|duckduckgo|serp/iu.test(
      toolText,
    )
  ) {
    score += 8;
  }
  if (
    intent.hasMemoryRecall &&
    /memory|memories|recall|remember|history|prior|knowledge|libravdb/iu.test(toolText)
  ) {
    score += 8;
  }
  return score;
}

function expandDirectoryHydrationGroups(params: {
  selectedNames: readonly string[];
  tools: readonly Pick<AnyAgentTool, "name" | "description">[];
  intent: ToolSearchDirectoryIntent;
  maxTools: number;
}): string[] {
  if (params.maxTools <= 0) {
    return [];
  }
  const emitted = new Set<string>();
  const expandedFamilies = new Set<ToolDirectoryFamily>();
  const expanded: string[] = [];
  const toolsByName = new Map(params.tools.map((tool) => [tool.name, tool]));
  const toolsByFamily = new Map<ToolDirectoryFamily, string[]>();
  const selectedRank = new Map(params.selectedNames.map((name, index) => [name, index]));
  for (const tool of params.tools) {
    for (const family of classifyDirectoryToolFamilies(tool, params.intent)) {
      const names = toolsByFamily.get(family) ?? [];
      names.push(tool.name);
      toolsByFamily.set(family, names);
    }
  }
  for (const names of toolsByFamily.values()) {
    names.sort(
      (a, b) =>
        (selectedRank.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (selectedRank.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
    );
  }
  for (const selectedName of params.selectedNames) {
    if (expanded.length >= params.maxTools) {
      break;
    }
    if (!emitted.has(selectedName)) {
      expanded.push(selectedName);
      emitted.add(selectedName);
    }
    const selectedTool = toolsByName.get(selectedName);
    if (!selectedTool || expanded.length >= params.maxTools) {
      continue;
    }
    for (const family of classifyDirectoryToolFamilies(selectedTool, params.intent)) {
      if (expandedFamilies.has(family)) {
        continue;
      }
      expandedFamilies.add(family);
      for (const groupedName of toolsByFamily.get(family) ?? []) {
        if (expanded.length >= params.maxTools) {
          return expanded;
        }
        if (!emitted.has(groupedName)) {
          expanded.push(groupedName);
          emitted.add(groupedName);
        }
      }
    }
  }
  return expanded;
}

export function estimateToolSchemaDirectoryToolNames(params: {
  tools: readonly AnyAgentTool[];
  query?: string;
  maxTools?: number;
  requiredToolNames?: Iterable<string>;
}): string[] {
  const maxTools = Math.max(0, Math.min(12, params.maxTools ?? 4));
  const hydratableTools: AnyAgentTool[] = [];
  const externalToolNames = new Set<string>();
  const uniqueCatalogToolNames = collectUniqueCatalogToolNames(params.tools);
  for (const tool of params.tools) {
    if (!uniqueCatalogToolNames.has(tool.name)) {
      continue;
    }
    if (classifyTool(tool).source === "mcp") {
      externalToolNames.add(tool.name);
      continue;
    }
    hydratableTools.push(tool);
  }
  const required = normalizeStringEntries(Array.from(params.requiredToolNames ?? [])).filter(
    (name) => !externalToolNames.has(name),
  );
  const requiredSet = new Set(required);
  const query = params.query?.trim() ?? "";
  if (!query && required.length >= maxTools) {
    return required.slice(0, maxTools);
  }
  const intent = readToolDirectoryIntent(query);
  const scored = hydratableTools
    .filter((tool) => !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      score: requiredSet.has(tool.name)
        ? Number.MAX_SAFE_INTEGER
        : scoreDirectoryTool(tool, intent),
    }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const selected = uniqueStrings([...required, ...scored.map((entry) => entry.name)]);
  return expandDirectoryHydrationGroups({
    selectedNames: selected,
    tools: hydratableTools,
    intent,
    maxTools,
  });
}
