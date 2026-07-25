/**
 * System prompt report builder.
 *
 * Session metadata uses this report to account for prompt size, bootstrap file
 * injection, skills, and tool schema footprint without storing raw prompt text.
 */
import { createHash } from "node:crypto";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { countTextTokens, resolveTokenEncoding } from "../shared/token-counter.js";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";
import type { AgentTool } from "./runtime/index.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

type ToolReportEntry = SessionSystemPromptReport["tools"]["entries"][number];

const toolReportEntryCache = new WeakMap<AgentTool, ToolReportEntry>();
const toolSchemaStatsCache = new WeakMap<
  object,
  Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash">
>();

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function extractBetween(input: string, startMarker: string, endMarker: string): string {
  const start = input.indexOf(startMarker);
  if (start === -1) {
    return "";
  }
  const end = input.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? input.slice(start) : input.slice(start, end);
}

function parseSkillBlocks(skillsPrompt: string): Array<{ name: string; blockChars: number }> {
  const prompt = skillsPrompt.trim();
  if (!prompt) {
    return [];
  }
  const blocks = Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi)).map(
    (match) => match[0] ?? "",
  );
  return blocks
    .map((block) => {
      const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)";
      return { name, blockChars: block.length };
    })
    .filter((b) => b.blockChars > 0);
}

function buildToolSchemaStats(
  parameters: AgentTool["parameters"],
): Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash"> {
  if (!parameters || typeof parameters !== "object") {
    return { schemaChars: 0, schemaHash: sha256(""), propertiesCount: null };
  }
  const cached = toolSchemaStatsCache.get(parameters);
  if (cached) {
    return cached;
  }
  let schemaJson;
  try {
    schemaJson = JSON.stringify(parameters);
  } catch {
    schemaJson = "";
  }
  const stats = {
    schemaChars: schemaJson.length,
    schemaHash: sha256(schemaJson),
    propertiesCount: (() => {
      const schema = parameters as Record<string, unknown>;
      const props = typeof schema.properties === "object" ? schema.properties : null;
      if (!props || typeof props !== "object") {
        return null;
      }
      return Object.keys(props as Record<string, unknown>).length;
    })(),
  };
  // Tool parameter objects are reused across runs; cache their stable size/hash
  // so report generation stays cheap during frequent prompt rebuilds.
  toolSchemaStatsCache.set(parameters, stats);
  return stats;
}

function resolveToolSource(tool: AgentTool): string | undefined {
  const record = tool as AgentTool & { source?: unknown; pluginId?: unknown };
  if (typeof record.source === "string" && record.source.trim()) {
    return record.source.trim();
  }
  if (typeof record.pluginId === "string" && record.pluginId.trim()) {
    return record.pluginId.trim();
  }
  return undefined;
}

function buildToolsEntries(tools: AgentTool[]): SessionSystemPromptReport["tools"]["entries"] {
  return tools.map((tool) => {
    const cached = toolReportEntryCache.get(tool);
    if (cached) {
      return cached;
    }
    const name = tool.name;
    const summary = tool.description?.trim() || tool.label?.trim() || "";
    const summaryChars = summary.length;
    const schemaStats = buildToolSchemaStats(tool.parameters);
    const source = resolveToolSource(tool);
    const entry = {
      name,
      summaryChars,
      summaryHash: sha256(summary),
      ...schemaStats,
      ...(source ? { source } : {}),
    };
    toolReportEntryCache.set(tool, entry);
    return entry;
  });
}

function isMcpToolSource(source: string | undefined, name: string): boolean {
  const normalized = (source ?? "").trim().toLowerCase();
  if (normalized === "mcp" || normalized === "bundle-mcp" || normalized.includes("mcp")) {
    return true;
  }
  const toolName = name.trim().toLowerCase();
  return toolName.startsWith("mcp_") || toolName.startsWith("mcp__");
}

function buildPromptTokenEstimate(params: {
  provider?: string;
  model?: string;
  systemPrompt: string;
  skillsPrompt: string;
  tools: AgentTool[];
  injectedFiles: EmbeddedContextFile[];
  projectContextChars: number;
  nonProjectContextChars: number;
}): SessionSystemPromptReport["promptTokenEstimate"] {
  const resolved = resolveTokenEncoding({
    provider: params.provider,
    model: params.model,
  });
  const encoding = resolved.encoding;
  let approximate = resolved.approximate;

  const skillsCounted = countTextTokens(params.skillsPrompt, { encoding });
  approximate = approximate || skillsCounted.approximate;

  let toolsTokens = 0;
  let mcpToolsTokens = 0;
  for (const tool of params.tools) {
    const summary = tool.description?.trim() || tool.label?.trim() || "";
    let schemaJson = "";
    try {
      schemaJson = JSON.stringify(tool.parameters ?? {});
    } catch {
      schemaJson = "";
    }
    const counted = countTextTokens(`${summary}\n${schemaJson}`, { encoding });
    approximate = approximate || counted.approximate;
    if (isMcpToolSource(resolveToolSource(tool), tool.name)) {
      mcpToolsTokens += counted.tokens;
    } else {
      toolsTokens += counted.tokens;
    }
  }

  const injectedText = params.injectedFiles
    .map((file) => `${file.path}\n${file.content ?? ""}`)
    .join("\n");
  const rulesCounted = countTextTokens(injectedText, { encoding });
  approximate = approximate || rulesCounted.approximate;

  // System base excludes skills + project context (same treemap dedupe).
  const systemBaseChars = Math.max(0, params.nonProjectContextChars - params.skillsPrompt.length);
  const systemRatio =
    params.systemPrompt.length > 0 ? systemBaseChars / params.systemPrompt.length : 0;
  const fullSystemCounted = countTextTokens(params.systemPrompt, { encoding });
  approximate = approximate || fullSystemCounted.approximate;
  const systemTokens = Math.max(0, Math.round(fullSystemCounted.tokens * systemRatio));

  // Project frame (headers around injected files) counted into rules.
  const injectedChars = params.injectedFiles.reduce(
    (sum, file) => sum + (file.content?.length ?? 0),
    0,
  );
  const projectFrameChars = Math.max(0, params.projectContextChars - injectedChars);
  const frameCounted =
    projectFrameChars > 0
      ? countTextTokens(params.systemPrompt.slice(0, Math.min(projectFrameChars, 8_192)), {
          encoding,
        })
      : { tokens: 0, approximate: false };
  // Prefer char-proportional frame estimate from full system tokenize.
  const frameTokens =
    params.systemPrompt.length > 0
      ? Math.round(fullSystemCounted.tokens * (projectFrameChars / params.systemPrompt.length))
      : frameCounted.tokens;

  return {
    encoding,
    approximate,
    system: systemTokens,
    tools: toolsTokens,
    mcpTools: mcpToolsTokens,
    rules: rulesCounted.tokens + frameTokens,
    skills: skillsCounted.tokens,
  };
}

function measureRenderedProjectContextChars(systemPrompt: string): number {
  return extractBetween(systemPrompt, "\n# Project Context\n", "\n## Silent Replies\n").length;
}

/** Builds the stored report for a rendered system prompt and its inputs. */
export function buildSystemPromptReport(params: {
  source: SessionSystemPromptReport["source"];
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: SessionSystemPromptReport["bootstrapTruncation"];
  sandbox?: SessionSystemPromptReport["sandbox"];
  systemPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  skillsPrompt: string;
  tools: AgentTool[];
  currentTurn?: SessionSystemPromptReport["currentTurn"];
}): SessionSystemPromptReport {
  const systemPromptChars = params.systemPrompt.length;
  const projectContextChars = measureRenderedProjectContextChars(params.systemPrompt);
  const nonProjectContextChars = Math.max(0, systemPromptChars - projectContextChars);
  const toolsEntries = buildToolsEntries(params.tools);
  const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
  const skillsEntries = parseSkillBlocks(params.skillsPrompt);
  const promptTokenEstimate = buildPromptTokenEstimate({
    provider: params.provider,
    model: params.model,
    systemPrompt: params.systemPrompt,
    skillsPrompt: params.skillsPrompt,
    tools: params.tools,
    injectedFiles: params.injectedFiles,
    projectContextChars,
    nonProjectContextChars,
  });

  return {
    source: params.source,
    generatedAt: params.generatedAt,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    bootstrapMaxChars: params.bootstrapMaxChars,
    bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
    ...(params.bootstrapTruncation ? { bootstrapTruncation: params.bootstrapTruncation } : {}),
    sandbox: params.sandbox,
    systemPrompt: {
      chars: systemPromptChars,
      hash: sha256(params.systemPrompt),
      projectContextChars,
      nonProjectContextChars,
    },
    ...(params.currentTurn ? { currentTurn: params.currentTurn } : {}),
    injectedWorkspaceFiles: buildBootstrapInjectionStats({
      bootstrapFiles: params.bootstrapFiles,
      injectedFiles: params.injectedFiles,
    }),
    skills: {
      promptChars: params.skillsPrompt.length,
      hash: sha256(params.skillsPrompt),
      entries: skillsEntries,
    },
    tools: {
      listChars: 0,
      schemaChars: toolsSchemaChars,
      entries: toolsEntries,
    },
    promptTokenEstimate,
  };
}
