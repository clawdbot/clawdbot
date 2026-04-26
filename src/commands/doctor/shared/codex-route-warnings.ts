import type {
  AgentModelConfig,
  AgentRuntimePolicyConfig,
} from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type CodexPiRouteHit = {
  path: string;
  model: string;
  runtime: string;
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function normalizeModelRef(model: AgentModelConfig | undefined): string | undefined {
  if (typeof model === "string") {
    return model.trim() || undefined;
  }
  return typeof model?.primary === "string" && model.primary.trim()
    ? model.primary.trim()
    : undefined;
}

function isOpenAICodexModelRef(model: string | undefined): model is string {
  return normalizeString(model)?.startsWith("openai-codex/") === true;
}

function isCodexPluginEnabled(cfg: OpenClawConfig): boolean {
  const plugins = cfg.plugins;
  if (plugins?.enabled === false) {
    return false;
  }
  const allow = plugins?.allow;
  if (Array.isArray(allow) && !allow.map((entry) => normalizeString(entry)).includes("codex")) {
    return false;
  }
  return (
    plugins?.entries?.codex?.enabled === true ||
    (Array.isArray(allow) && allow.map((entry) => normalizeString(entry)).includes("codex"))
  );
}

function resolveRuntime(params: {
  env?: NodeJS.ProcessEnv;
  agentRuntime?: AgentRuntimePolicyConfig;
  defaultsRuntime?: AgentRuntimePolicyConfig;
}): string {
  return (
    normalizeString(params.env?.OPENCLAW_AGENT_RUNTIME) ??
    normalizeString(params.agentRuntime?.id) ??
    normalizeString(params.defaultsRuntime?.id) ??
    "pi"
  );
}

function collectOpenAICodexPiRouteHits(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): CodexPiRouteHit[] {
  const defaults = cfg.agents?.defaults;
  const defaultsRuntime = defaults?.agentRuntime;
  const hits: CodexPiRouteHit[] = [];
  const defaultModel = normalizeModelRef(defaults?.model);
  const defaultRuntime = resolveRuntime({ env, defaultsRuntime });
  if (isOpenAICodexModelRef(defaultModel) && defaultRuntime !== "codex") {
    hits.push({ path: "agents.defaults.model", model: defaultModel, runtime: defaultRuntime });
  }

  for (const agent of cfg.agents?.list ?? []) {
    const model = normalizeModelRef(agent.model);
    if (!isOpenAICodexModelRef(model)) {
      continue;
    }
    const runtime = resolveRuntime({
      env,
      agentRuntime: agent.agentRuntime,
      defaultsRuntime,
    });
    if (runtime === "codex") {
      continue;
    }
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : "<unknown>";
    hits.push({ path: `agents.list.${id}.model`, model, runtime });
  }

  return hits;
}

export function collectCodexRouteWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  if (!isCodexPluginEnabled(params.cfg)) {
    return [];
  }
  const hits = collectOpenAICodexPiRouteHits(params.cfg, params.env);
  if (hits.length === 0) {
    return [];
  }
  return [
    [
      "- Codex plugin is enabled, but `openai-codex/*` model refs still use the OpenClaw PI runner unless `agentRuntime.id` is `codex`.",
      ...hits.map(
        (hit) => `- ${hit.path}: ${hit.model} currently resolves with runtime "${hit.runtime}".`,
      ),
      '- To use native Codex app-server, set the model to `openai/<model>` and set `agents.defaults.agentRuntime.id: "codex"` (or the agent-level equivalent).',
      "- Leave this unchanged if you intentionally want Codex OAuth/subscription auth through PI.",
    ].join("\n"),
  ];
}
