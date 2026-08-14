// Telegram helper module supports agent config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";

type ReasoningDefault = "on" | "stream" | "off";

export function resolveTelegramConfigReasoningDefault(
  cfg: OpenClawConfig,
  agentId: string,
): ReasoningDefault {
  const id = normalizeAgentId(agentId);
  const agentDefault = cfg.agents?.list?.find(
    (entry) => normalizeAgentId(entry?.id) === id,
  )?.reasoningDefault;
  return agentDefault ?? cfg.agents?.defaults?.reasoningDefault ?? "off";
}
