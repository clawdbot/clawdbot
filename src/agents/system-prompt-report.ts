import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

type ToolReportEntry = SessionSystemPromptReport["tools"]["entries"][number];

const toolReportEntryCache = new WeakMap<AgentTool, ToolReportEntry>();
const toolSchemaStatsCache = new WeakMap<
  object,
  Pick<ToolReportEntry, "propertiesCount" | "schemaChars">
>();

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
): Pick<ToolReportEntry, "propertiesCount" | "schemaChars"> {
  if (!parameters || typeof parameters !== "object") {
    return { schemaChars: 0, propertiesCount: null };
  }
  const cached = toolSchemaStatsCache.get(parameters);
  if (cached) {
    return cached;
  }
  const stats = {
    schemaChars: (() => {
      try {
        return JSON.stringify(parameters).length;
      } catch {
        return 0;
      }
    })(),
    propertiesCount: (() => {
      const schema = parameters as Record<string, unknown>;
      const props = typeof schema.properties === "object" ? schema.properties : null;
      if (!props || typeof props !== "object") {
        return null;
      }
      return Object.keys(props as Record<string, unknown>).length;
    })(),
  };
  toolSchemaStatsCache.set(parameters, stats);
  return stats;
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
    const entry = { name, summaryChars, ...schemaStats };
    toolReportEntryCache.set(tool, entry);
    return entry;
  });
}

function measureRenderedProjectContextChars(systemPrompt: string): number {
  return extractBetween(systemPrompt, "\n# Project Context\n", "\n## Silent Replies\n").length;
}

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
}): SessionSystemPromptReport {
  const systemPromptChars = params.systemPrompt.length;
  const projectContextChars = measureRenderedProjectContextChars(params.systemPrompt);
  const toolsEntries = buildToolsEntries(params.tools);
  const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
  const skillsEntries = parseSkillBlocks(params.skillsPrompt);

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
      projectContextChars,
      nonProjectContextChars: Math.max(0, systemPromptChars - projectContextChars),
    },
    injectedWorkspaceFiles: buildBootstrapInjectionStats({
      bootstrapFiles: params.bootstrapFiles,
      injectedFiles: params.injectedFiles,
    }),
    skills: {
      promptChars: params.skillsPrompt.length,
      entries: skillsEntries,
    },
    tools: {
      listChars: 0,
      schemaChars: toolsSchemaChars,
      entries: toolsEntries,
    },
  };
}
