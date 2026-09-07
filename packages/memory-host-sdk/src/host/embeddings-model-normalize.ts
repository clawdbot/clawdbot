// Normalizes user-provided embedding model ids by removing accepted provider prefixes.

/** Trim a configured model id, fall back when empty, and strip known prefixes. */
export function normalizeEmbeddingModelWithPrefixes(params: {
  model: string;
  defaultModel: string;
  prefixes: string[];
}): string {
  const trimmed = params.model.trim();
  if (!trimmed) {
    return params.defaultModel;
  }
  for (const prefix of params.prefixes) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}
