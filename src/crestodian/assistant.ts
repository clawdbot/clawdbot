import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { extractAssistantText } from "../agents/pi-embedded-utils.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../agents/simple-completion-runtime.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { CrestodianOverview } from "./overview.js";

const CRESTODIAN_ASSISTANT_TIMEOUT_MS = 10_000;
const CRESTODIAN_ASSISTANT_MAX_TOKENS = 512;

const CRESTODIAN_ASSISTANT_SYSTEM_PROMPT = [
  "You are Crestodian, OpenClaw's ring-zero setup helper.",
  "Turn the user's request into exactly one safe OpenClaw Crestodian command.",
  "Return only compact JSON with keys reply and command.",
  "Do not invent commands. Do not claim a write was applied.",
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

export type CrestodianAssistantPlanner = (params: {
  input: string;
  overview: CrestodianOverview;
}) => Promise<CrestodianAssistantPlan | null>;

export async function planCrestodianCommandWithConfiguredModel(params: {
  input: string;
  overview: CrestodianOverview;
}): Promise<CrestodianAssistantPlan | null> {
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    return null;
  }
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const agentId = resolveDefaultAgentId(cfg);
  const prepared = await prepareSimpleCompletionModelForAgent({
    cfg,
    agentId,
    allowMissingApiKeyModes: ["aws-sdk"],
  });
  if ("error" in prepared) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRESTODIAN_ASSISTANT_TIMEOUT_MS);
  try {
    const response = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: {
        systemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildCrestodianAssistantUserPrompt({
              input,
              overview: params.overview,
            }),
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens: CRESTODIAN_ASSISTANT_MAX_TOKENS,
        signal: controller.signal,
      },
    });
    const parsed = parseCrestodianAssistantPlanText(extractAssistantText(response));
    if (!parsed) {
      return null;
    }
    return {
      ...parsed,
      modelLabel: `${prepared.selection.provider}/${prepared.selection.modelId}`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
