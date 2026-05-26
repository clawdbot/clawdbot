import { isOllamaCloudKimiModelRef } from "./sanitizers/kimi-inline-reasoning.js";

export function shouldWrapOllamaCompatMoonshotThinking(modelId: string): boolean {
  return isOllamaCloudKimiModelRef(modelId);
}
