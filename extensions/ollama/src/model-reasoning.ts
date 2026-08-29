// Ollama plugin module owns model-specific native thinking contracts.
import { normalizeOllamaCloudModelId } from "./defaults.js";

export function supportsOllamaCloudFullThinkingEffort(modelId: string): boolean {
  // These hosted families accept low, medium, high, and max even when
  // lightweight catalog projections omit their reasoning metadata.
  const normalized = normalizeOllamaCloudModelId(modelId);
  return (
    /^glm-5\.[23]$/.test(normalized) || /^deepseek-v4-(?:flash|pro)$/.test(normalized)
  );
}
