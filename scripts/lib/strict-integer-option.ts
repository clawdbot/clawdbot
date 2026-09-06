// Strict integer parsing is dependency-free so native Node TypeScript scripts can reuse it.
export function parseStrictIntegerOption(params: {
  fallback: number;
  label: string;
  min: number;
  raw: string | undefined;
}): number {
  const raw = params.raw?.trim();
  if (!raw) {
    return params.fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      `${params.label} must be an integer >= ${params.min}; got ${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < params.min) {
    throw new Error(
      `${params.label} must be an integer >= ${params.min}; got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}
