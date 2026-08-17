import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { tryResolveLegacyCompatibilityAgentId } from "../agents/agent-scope-config.js";
import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "./legacy.default-agent-owner-state.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function retainLegacyDefaultAgentId(
  config: OpenClawConfig,
  agentId: string | undefined,
): OpenClawConfig {
  setRetainedLegacyDefaultAgentId(config, agentId ? normalizeAgentId(agentId) : undefined);
  return config;
}

export function inheritLegacyDefaultAgentId(
  source: OpenClawConfig,
  target: OpenClawConfig,
): OpenClawConfig {
  return retainLegacyDefaultAgentId(target, tryGetLegacyDefaultAgentId(source));
}

export function tryGetLegacyDefaultAgentId(config: OpenClawConfig): string | undefined {
  return getRetainedLegacyDefaultAgentId(config);
}
export { tryResolveLegacyCompatibilityAgentId } from "../agents/agent-scope-config.js";

export function resolveSessionStoreCompatibilityAgentId(config: OpenClawConfig): string {
  const persistedAgentId = config.agents?.defaults?.sessionStore?.agentId?.trim();
  return persistedAgentId
    ? normalizeAgentId(persistedAgentId)
    : (tryResolveLegacyCompatibilityAgentId(config) ?? "main");
}
