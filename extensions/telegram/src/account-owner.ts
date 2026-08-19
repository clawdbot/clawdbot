import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";

/** Resolves the agent that owns account-scoped Telegram runtime state. */
export function resolveTelegramAccountOwnerAgentId(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
  }).agentId;
}
