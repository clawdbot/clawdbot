/**
 * Azure OpenAI-compatible hostname matchers shared by the completions
 * transport and its compat resolver. Internal on purpose: this module is not
 * barrel-exported from `@openclaw/ai/transports`, so Azure hostname policy can
 * change without a public API obligation.
 */

/**
 * Dedicated/traditional Azure OpenAI hostnames; every deployment speaks the
 * OpenAI API. `.cognitiveservices.azure.com` belongs here to mirror the Azure
 * Responses classification (`isTraditionalAzureOpenAIHost`): deployment ids on
 * these hosts are operator-chosen but always front OpenAI models.
 */
export function isDedicatedAzureOpenAIHostname(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") || hostname.endsWith(".cognitiveservices.azure.com")
  );
}

/**
 * Multi-model Azure AI Foundry hostnames. These resources can front
 * non-OpenAI deployments (MAI, Llama, DeepSeek, ...), so callers must not
 * assume Azure OpenAI-only semantics from the hostname alone.
 */
export function isAzureFoundryMultiModelHostname(hostname: string): boolean {
  return (
    hostname.endsWith(".services.ai.azure.com") || hostname.endsWith(".api.cognitive.microsoft.com")
  );
}

/** Matches any Azure OpenAI-compatible API hostname (dedicated or Foundry). */
export function isAzureOpenAICompatibleHostname(hostname: string): boolean {
  return isDedicatedAzureOpenAIHostname(hostname) || isAzureFoundryMultiModelHostname(hostname);
}
