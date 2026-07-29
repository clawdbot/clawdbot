import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Resolve whether delegated system-agent persistent operations may skip the
 * operator prompt. Interactive setup flows remain guarded by the chat engine.
 */
export function shouldAlwaysApproveDelegatedSystemAgentOperations(params: {
  config: OpenClawConfig;
  delegated: boolean;
}): boolean {
  return params.delegated && params.config.approvals?.systemAgent?.mode === "always";
}
