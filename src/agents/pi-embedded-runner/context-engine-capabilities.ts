import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  parseAgentSessionKey,
  normalizeAgentId,
  normalizeMainKey,
} from "../../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { resolveDefaultAgentId } from "../agent-scope.js";

export type ResolveContextEngineCapabilitiesParams = {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  contextEnginePluginId?: string;
  purpose: string;
};

function resolveBoundAgentId(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  // Explicit agent ids are host-resolved at call sites that already know the
  // active session agent, such as embedded attempts.
  const explicitAgentId = normalizeOptionalString(params.agentId);
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  // Canonical agent session keys carry the binding directly.
  const normalizedSessionKey = normalizeOptionalString(params.sessionKey);
  if (!normalizedSessionKey) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  // Legacy main-session aliases are still active sessions; arbitrary legacy
  // aliases stay unbound and fail closed in runtime LLM authorization.
  const loweredSessionKey = normalizeLowercaseStringOrEmpty(normalizedSessionKey);
  const mainKey = normalizeMainKey(params.config?.session?.mainKey);
  if (loweredSessionKey === "main" || loweredSessionKey === mainKey) {
    return resolveDefaultAgentId(params.config ?? {});
  }
  return undefined;
}

/**
 * Build host-owned capabilities that are bound to one context-engine runtime call.
 */
export function resolveContextEngineCapabilities(
  params: ResolveContextEngineCapabilitiesParams,
): Pick<ContextEngineRuntimeContext, "llm"> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const agentId = resolveBoundAgentId({
    config: params.config,
    sessionKey,
    agentId: params.agentId,
  });
  const contextEnginePluginId = normalizeOptionalString(params.contextEnginePluginId);
  return {
    llm: {
      complete: async (request) => {
        const { createRuntimeLlm } = await import("../../plugins/runtime/runtime-llm.runtime.js");
        return await createRuntimeLlm({
          getConfig: () => params.config,
          authority: {
            caller: { kind: "context-engine", id: params.purpose },
            requiresBoundAgent: true,
            ...(sessionKey ? { sessionKey } : {}),
            ...(agentId ? { agentId } : {}),
            ...(contextEnginePluginId ? { pluginIdForPolicy: contextEnginePluginId } : {}),
            allowAgentIdOverride: false,
            allowModelOverride: false,
            allowComplete: true,
          },
        }).complete(request);
      },
    },
  };
}
