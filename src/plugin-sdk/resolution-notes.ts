/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
export function formatResolvedUnresolvedNote(params: {
  resolved: string[];
  unresolved: string[];
}): string | undefined {
  if (params.resolved.length === 0 && params.unresolved.length === 0) {
    return undefined;
  }
  return [
    params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : undefined,
    params.unresolved.length > 0
      ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
