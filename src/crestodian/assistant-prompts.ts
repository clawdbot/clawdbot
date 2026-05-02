import type { CrestodianOverview } from "./overview.js";

export const CRESTODIAN_ASSISTANT_TIMEOUT_MS = 10_000;
export const CRESTODIAN_ASSISTANT_MAX_TOKENS = 512;

export const CRESTODIAN_ASSISTANT_SYSTEM_PROMPT = [
  "You are Crestodian, OpenClaw's ring-zero setup helper.",
  "Turn the user's request into exactly one safe OpenClaw Crestodian command.",
  "Return only compact JSON with keys reply and command.",
  "Do not invent commands. Do not claim a write was applied.",
  "Do not use tools, shell commands, file edits, or network lookups; plan only from the supplied overview.",
  "Use the provided OpenClaw docs/source references when the user's request needs behavior, config, or architecture details.",
  "If local source is available, prefer inspecting it. Otherwise point to GitHub and strongly recommend reviewing source when docs are not enough.",
  "Allowed commands:",
  "- setup",
  "- status",
  "- health",
  "- doctor",
  "- doctor fix",
  "- gateway status",
  "- restart gateway",
  "- start gateway",
  "- stop gateway",
  "- agents",
  "- models",
  "- plugins list",
  "- plugins search <query>",
  "- plugin install <npm-or-clawhub-spec>",
  "- plugin uninstall <id>",
  "- audit",
  "- validate config",
  "- set default model <provider/model>",
  "- config set <path> <value>",
  "- config set-ref <path> env <ENV_VAR>",
  "- create agent <id> workspace <path> model <provider/model>",
  "- talk to <id> agent",
  "- talk to agent",
  "If unsure, choose overview.",
].join("\n");

export type CrestodianAssistantPlan = {
  command: string;
  reply?: string;
  modelLabel?: string;
};

export function buildCrestodianAssistantUserPrompt(params: {
  input: string;
  overview: CrestodianOverview;
}): string {
  const agents = params.overview.agents
    .map((agent) => {
      const fields = [
        `id=${agent.id}`,
        agent.name ? `name=${agent.name}` : undefined,
        agent.workspace ? `workspace=${agent.workspace}` : undefined,
        agent.model ? `model=${agent.model}` : undefined,
        agent.isDefault ? "default=true" : undefined,
      ].filter(Boolean);
      return `- ${fields.join(", ")}`;
    })
    .join("\n");
  return [
    `User request: ${params.input}`,
    "",
    `Default agent: ${params.overview.defaultAgentId}`,
    `Default model: ${params.overview.defaultModel ?? "not configured"}`,
    `Config valid: ${params.overview.config.valid}`,
    `Gateway reachable: ${params.overview.gateway.reachable}`,
    `Codex CLI: ${params.overview.tools.codex.found ? "found" : "not found"}`,
    `Claude Code CLI: ${params.overview.tools.claude.found ? "found" : "not found"}`,
    `OpenAI API key: ${params.overview.tools.apiKeys.openai ? "found" : "not found"}`,
    `Anthropic API key: ${params.overview.tools.apiKeys.anthropic ? "found" : "not found"}`,
    `OpenClaw docs: ${params.overview.references.docsPath ?? params.overview.references.docsUrl}`,
    `OpenClaw source: ${
      params.overview.references.sourcePath ?? params.overview.references.sourceUrl
    }`,
    params.overview.references.sourcePath
      ? "Source mode: local git checkout; inspect source directly when docs are insufficient."
      : "Source mode: package/install; use GitHub source when docs are insufficient.",
    "",
    "Agents:",
    agents || "- none",
  ].join("\n");
}

export function parseCrestodianAssistantPlanText(
  rawText: string | undefined,
): CrestodianAssistantPlan | null {
  const text = rawText?.trim();
  if (!text) {
    return null;
  }
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) {
    return null;
  }
  const reply = typeof record.reply === "string" ? record.reply.trim() : undefined;
  return {
    command,
    ...(reply ? { reply } : {}),
  };
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}
