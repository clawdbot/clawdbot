import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";

export type PreparedThinkingPolicy = (
  context: ProviderDefaultThinkingPolicyContext,
) => ProviderThinkingProfile | null | undefined;

// Internal row metadata follows spreads, but not JSON or worker transport.
export const PREPARED_THINKING_POLICY = Symbol("preparedThinkingPolicy");
export type ThinkingCatalogPolicyCarrier = object & {
  [PREPARED_THINKING_POLICY]?: PreparedThinkingPolicy | null;
};
