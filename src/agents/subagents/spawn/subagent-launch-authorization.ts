/** Authorization captured when a trusted sessions_spawn request selects a model. */
export type SubagentLaunchAuthorization = {
  modelOverride: {
    provider?: string;
    model: string;
  };
};

/** Applies only the exact model choice authorized during spawn planning. */
export function applySubagentLaunchAuthorization(
  request: Record<string, unknown>,
  authorization?: SubagentLaunchAuthorization,
): Record<string, unknown> {
  const modelOverride = authorization?.modelOverride;
  if (!modelOverride) {
    return request;
  }
  return {
    ...request,
    ...(modelOverride.provider ? { provider: modelOverride.provider } : {}),
    model: modelOverride.model,
  };
}
