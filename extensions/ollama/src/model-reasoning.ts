// Ollama plugin module owns model-specific native thinking contracts.
export function supportsOllamaCloudFullThinkingEffort(modelId: string): boolean {
  // These hosted families accept low, medium, high, and max even when
  // lightweight catalog projections omit their reasoning metadata.
  const normalized = normalizeOllamaCloudModelId(modelId);
  return normalized === "glm-5.2" || /^deepseek-v4-(?:flash|pro)$/.test(normalized);
}

function normalizeOllamaCloudModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/(?::cloud|-cloud)$/, "");
}
