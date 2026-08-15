// Feishu helper module supports agent config behavior.
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { ClawdbotConfig } from "./bot-runtime-api.js";

type ReasoningDefault = "on" | "stream" | "off";

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
