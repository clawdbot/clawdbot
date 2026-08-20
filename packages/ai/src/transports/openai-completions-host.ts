/**
 * Chat Completions accepts Azure AI Foundry hosts in addition to traditional
 * Azure OpenAI hosts. Do not replace this with isTraditionalAzureOpenAIHost,
 * which intentionally excludes the .services.ai.azure.com Foundry suffix.
 */
export function isAzureOpenAICompatibleHost(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") ||
    hostname.endsWith(".services.ai.azure.com") ||
    hostname.endsWith(".cognitiveservices.azure.com")
  );
}
