export type AgentPatchedSessionModelFallback = {
  prevModel: string;
  prevProvider: string;
  prevModelOverride?: string;
  prevProviderOverride?: string;
  prevModelOverrideSource?: "auto" | "user";
  prevModelOverrideRouteResolution?: "resolved";
  prevModelOverrideFallbackOriginProvider?: string;
  prevModelOverrideFallbackOriginModel?: string;
  prevAuthProfileOverride?: string;
  prevAuthProfileOverrideSource?: "auto" | "user" | "user-link";
  prevAuthProfileOverrideCompactionCount?: number;
  prevContextWindow?: string;
  prevThinkingLevel?: string;
  lastValidatedPatchTs?: number;
  ts: number;
  source: "agent-patch";
};

export function createAgentPatchedSessionModelFallback(params: {
  model: string;
  provider: string;
  entry: {
    modelOverride?: string;
    providerOverride?: string;
    modelOverrideSource?: "auto" | "user";
    modelOverrideRouteResolution?: "resolved";
    modelOverrideFallbackOriginProvider?: string;
    modelOverrideFallbackOriginModel?: string;
    authProfileOverride?: string;
    authProfileOverrideSource?: "auto" | "user" | "user-link";
    authProfileOverrideCompactionCount?: number;
    contextWindow?: string;
    thinkingLevel?: string;
  };
  ts: number;
}): AgentPatchedSessionModelFallback {
  const { entry } = params;
  return {
    prevModel: params.model,
    prevProvider: params.provider,
    ...(entry.modelOverride ? { prevModelOverride: entry.modelOverride } : {}),
    ...(entry.providerOverride ? { prevProviderOverride: entry.providerOverride } : {}),
    ...(entry.modelOverrideSource ? { prevModelOverrideSource: entry.modelOverrideSource } : {}),
    ...(entry.modelOverrideRouteResolution
      ? { prevModelOverrideRouteResolution: entry.modelOverrideRouteResolution }
      : {}),
    ...(entry.modelOverrideFallbackOriginProvider
      ? { prevModelOverrideFallbackOriginProvider: entry.modelOverrideFallbackOriginProvider }
      : {}),
    ...(entry.modelOverrideFallbackOriginModel
      ? { prevModelOverrideFallbackOriginModel: entry.modelOverrideFallbackOriginModel }
      : {}),
    ...(entry.authProfileOverride ? { prevAuthProfileOverride: entry.authProfileOverride } : {}),
    ...(entry.authProfileOverrideSource
      ? { prevAuthProfileOverrideSource: entry.authProfileOverrideSource }
      : {}),
    ...(entry.authProfileOverrideCompactionCount !== undefined
      ? { prevAuthProfileOverrideCompactionCount: entry.authProfileOverrideCompactionCount }
      : {}),
    ...(entry.contextWindow ? { prevContextWindow: entry.contextWindow } : {}),
    ...(entry.thinkingLevel ? { prevThinkingLevel: entry.thinkingLevel } : {}),
    ts: params.ts,
    source: "agent-patch",
  };
}
