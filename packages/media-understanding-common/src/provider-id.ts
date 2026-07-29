// Provider id normalization for media-understanding config and execution.

/** Normalize a provider id for comparison. */
function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Normalize provider aliases to canonical config provider ids. */
export function normalizeMediaProviderId(id: string): string {
  const normalized = normalizeProviderId(id);
  if (normalized === "gemini") {
    return "google";
  }
  if (normalized === "minimax-cn") {
    return "minimax";
  }
  if (normalized === "minimax-portal-cn") {
    return "minimax-portal";
  }
  return normalized;
}

/** Normalize provider ids while preserving execution-specific regional aliases. */
export function normalizeMediaExecutionProviderId(id: string): string {
  const normalized = normalizeProviderId(id);
  if (normalized === "minimax-cn" || normalized === "minimax-portal-cn") {
    return normalized;
  }
  return normalizeMediaProviderId(normalized);
}
