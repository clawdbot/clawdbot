const MAX_TOKENS_PARAM_KEYS = ["maxTokens", "max_completion_tokens", "max_tokens"] as const;

export function resolveNonNegativeMaxTokensParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resolveMaxTokensParam(
  params: Record<string, unknown> | undefined,
): number | undefined {
  if (!params) {
    return undefined;
  }
  for (const key of MAX_TOKENS_PARAM_KEYS) {
    const resolved = resolveNonNegativeMaxTokensParam(params[key]);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

export function canonicalizeMaxTokensParam(params: {
  merged: Record<string, unknown>;
  sources: Array<Record<string, unknown> | undefined>;
}): void {
  let resolved: number | undefined;
  for (const source of params.sources) {
    const sourceValue = resolveMaxTokensParam(source);
    if (sourceValue !== undefined) {
      resolved = sourceValue;
    }
  }
  if (resolved === undefined) {
    return;
  }
  for (const key of MAX_TOKENS_PARAM_KEYS) {
    delete params.merged[key];
  }
  params.merged.maxTokens = resolved;
}
