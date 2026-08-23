import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveTalkSessionAgentId } from "../talk/agent-target.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

/** Resolves the raw client key and its canonical, agent-owned persistence target together. */
export function resolveTalkSessionTarget(config: OpenClawConfig, sessionKey: string) {
  const voiceSessionKey = sessionKey.trim();
  if (!voiceSessionKey) {
    throw new Error("Talk session key must be non-empty");
  }
  const agentId = resolveTalkSessionAgentId(config, voiceSessionKey);
  return {
    agentId,
    voiceSessionKey,
    agentSessionKey: resolveSessionStoreKey({
      cfg: config,
      sessionKey: voiceSessionKey,
      storeAgentId: agentId,
    }),
  };
}
