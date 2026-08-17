// Telegram helper module supports agent config behavior.
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type ReasoningDefault = "on" | "stream" | "off";

export function resolveTelegramConfigReasoningDefault(
  cfg: OpenClawConfig,
  agentId: string,
): ReasoningDefault {
  const agentDefault = resolveAgentConfig(cfg, agentId)?.reasoningDefault;
  return agentDefault ?? cfg.agents?.defaults?.reasoningDefault ?? "off";
}
