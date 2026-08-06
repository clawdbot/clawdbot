// Microsoft Foundry plugin module implements shared runtime behavior.
export {
  TOKEN_REFRESH_MARGIN_MS,
  buildFoundryProviderBaseUrl,
  extractFoundryEndpoint,
  FOUNDRY_ANTHROPIC_SCOPE,
  isFoundryProviderApi,
  resolveConfiguredModelNameHint,
  ANTHROPIC_MESSAGES_API,
  type CachedTokenEntry,
} from "./shared.js";

export function getFoundryTokenCacheKey(params?: {
  scope?: string;
  subscriptionId?: string;
  tenantId?: string;
}): string {
  return `${params?.scope ?? ""}:${params?.subscriptionId ?? ""}:${params?.tenantId ?? ""}`;
}
