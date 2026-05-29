export function summarizeStringEntries(params: {
  entries?: ReadonlyArray<string> | null;
  limit?: number;
  emptyText?: string;
}): string {
  const entries = params.entries ?? [];
  if (entries.length === 0) {
    return params.emptyText ?? "";
  }
  const rawLimit = params.limit ?? 6;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 6;
  const sample = entries.slice(0, limit);
  const suffix = entries.length > sample.length ? ` (+${entries.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}
