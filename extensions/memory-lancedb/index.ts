import { definePluginEntry } from "./api.js";
import { memoryConfigSchema } from "./config.js";
import { registerMemoryLanceDb } from "./memory-plugin.js";

export { normalizeEmbeddingVector, testing } from "./embeddings.js";
export { parseMemoryCliFilter } from "./memory-cli.js";
export { normalizeRecallQuery } from "./memory-policy.js";
export {
  looksLikeEnvelopeSludge,
  sanitizeForMemoryCapture,
} from "./memory-capture-sanitization.js";
export {
  detectCategory,
  escapeMemoryForPrompt,
  formatRelevantMemoriesContext,
  looksLikePromptInjection,
  shouldCapture,
} from "./memory-policy.js";

export default definePluginEntry({
  id: "memory-lancedb",
  name: "Memory (LanceDB)",
  description: "LanceDB-backed long-term memory with auto-recall/capture",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,
  register: registerMemoryLanceDb,
});
