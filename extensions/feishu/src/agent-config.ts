// Feishu helper module supports agent config behavior.
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { ClawdbotConfig } from "./bot-runtime-api.js";

type ReasoningDefault = "on" | "stream" | "off";

export function resolveFeishuConfigReasoningDefault(
  cfg: ClawdbotConfig,
  agentId: string,
): ReasoningDefault {
  const agentDefault = resolveAgentConfig(cfg, agentId)?.reasoningDefault;
  return agentDefault ?? cfg.agents?.defaults?.reasoningDefault ?? "off";
}
