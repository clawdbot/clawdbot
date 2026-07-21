import {
  listAgentIds,
  resolveAllowedModelRef,
  resolveDefaultAgentId,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import { resolveEffectiveAgentRuntime } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_ID,
  CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF,
} from "./cli-constants.js";
import { adoptedSourceKey, CLAUDE_LOCAL_SESSION_HOST_ID } from "./session-catalog-adoption.js";

export function currentClaudeSessionCatalogConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config ?? {}) as OpenClawConfig;
}

function boundClaudeSource(
  pluginId: string,
  entry: {
    cliSessionBindings?: unknown;
    execHost?: string;
    execNode?: string;
    pluginOwnerId?: string;
    modelSelectionLocked?: boolean;
    pluginExtensions?: unknown;
  },
): { hostId: string; threadId: string } | undefined {
  const anthropic = isRecord(entry.pluginExtensions) ? entry.pluginExtensions.anthropic : undefined;
  const marker = isRecord(anthropic) ? anthropic.sessionCatalog : undefined;
  const hostId =
    isRecord(marker) && typeof marker.sourceHostId === "string"
      ? marker.sourceHostId
      : entry.execHost === "node" && typeof entry.execNode === "string" && entry.execNode.trim()
        ? `node:${entry.execNode.trim()}`
        : CLAUDE_LOCAL_SESSION_HOST_ID;
  const bindings = isRecord(entry.cliSessionBindings) ? entry.cliSessionBindings : undefined;
  const binding = bindings?.[CLAUDE_CLI_BACKEND_ID];
  if (isRecord(binding) && typeof binding.sessionId === "string" && binding.sessionId) {
    return { hostId, threadId: binding.sessionId };
  }
  if (entry.pluginOwnerId !== pluginId || entry.modelSelectionLocked !== true) {
    return undefined;
  }
  return isRecord(marker) && typeof marker.sourceThreadId === "string"
    ? { hostId, threadId: marker.sourceThreadId }
    : undefined;
}

export function listBoundClaudeSessions(api: OpenClawPluginApi): Map<string, string> {
  const config = currentClaudeSessionCatalogConfig(api);
  const defaultAgentId = resolveDefaultAgentId(config);
  const agentIds = [
    defaultAgentId,
    ...listAgentIds(config).filter((agentId) => agentId !== defaultAgentId),
  ];
  const bound = new Map<string, string>();
  for (const { sessionKey, entry } of agentIds.flatMap((agentId) =>
    api.runtime.agent.session.listSessionEntries({ agentId }),
  )) {
    const source = boundClaudeSource(api.id, entry);
    if (source) {
      bound.set(adoptedSourceKey(source.hostId, source.threadId), sessionKey);
    }
  }
  return bound;
}

export function resolveClaudeCatalogCreateSession(
  api: OpenClawPluginApi,
  requestedAgentId?: string,
): { model: string; agentRuntime: string } | undefined {
  const config = currentClaudeSessionCatalogConfig(api);
  const agentId = requestedAgentId ?? resolveDefaultAgentId(config);
  const agentRuntime = resolveEffectiveAgentRuntime({
    cfg: config,
    provider: "anthropic",
    modelId: CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_ID,
    agentId,
  });
  if (agentRuntime !== CLAUDE_CLI_BACKEND_ID) {
    return undefined;
  }
  const defaultModel = resolveDefaultModelForAgent({ cfg: config, agentId });
  const allowed = resolveAllowedModelRef({
    cfg: config,
    catalog: [],
    raw: CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF,
    defaultProvider: defaultModel.provider,
    defaultModel: defaultModel.model,
    agentId,
  });
  return "error" in allowed
    ? undefined
    : {
        model: CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF,
        agentRuntime: CLAUDE_CLI_BACKEND_ID,
      };
}
