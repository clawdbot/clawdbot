import type { ClawdbotConfig } from "./bot-runtime-api.js";

type ReasoningDefault = "on" | "stream" | "off";

const DEFAULT_AGENT_ID = "main";

function normalizeAgentId(value: string | undefined | null): string {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized || DEFAULT_AGENT_ID;
}

export function resolveFeishuConfigReasoningDefault(
  cfg: ClawdbotConfig,
  agentId: string,
): ReasoningDefault {
  const id = normalizeAgentId(agentId);
  const agentDefault = cfg.agents?.list?.find(
    (entry) => normalizeAgentId(entry?.id) === id,
  )?.reasoningDefault;
  return agentDefault ?? cfg.agents?.defaults?.reasoningDefault ?? "off";
}
