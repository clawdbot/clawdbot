// Memory Host SDK module implements embeddings debug behavior.
import { normalizeLowercaseStringOrEmpty } from "./string-utils.js";

// Lightweight stderr debug logging for memory embedding internals.

const debugEmbeddings = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_MEMORY_EMBEDDINGS);

/** Write embedding debug metadata when OPENCLAW_DEBUG_MEMORY_EMBEDDINGS is enabled. */
export function debugEmbeddingsLog(message: string, meta?: Record<string, unknown>): void {
  if (!debugEmbeddings) {
    return;
  }
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  process.stderr.write(`${message}${suffix}\n`);
}

/** Parse common truthy env values for debug toggles. */
function isTruthyEnvValue(value?: string): boolean {
  switch (normalizeLowercaseStringOrEmpty(value)) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    default:
      return false;
  }
}
