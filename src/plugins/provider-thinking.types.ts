/**
 * Provider-owned thinking policy input.
 *
 * Used by shared `/think`, ACP controls, and directive parsing to ask a
 * provider whether a model supports special reasoning UX such as xhigh or a
 * binary on/off toggle.
 */
export type ProviderThinkingPolicyContext = {
  provider: string;
  modelId: string;
};

/**
 * Provider-owned default thinking policy input.
 *
 * `reasoning` is the merged catalog hint for the selected model when one is
 * available. Providers can use it to keep "reasoning model => low" behavior
 * without re-reading the catalog themselves.
 */
export type ProviderDefaultThinkingPolicyContext = ProviderThinkingPolicyContext & {
  reasoning?: boolean;
};
