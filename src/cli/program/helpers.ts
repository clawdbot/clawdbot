export function collectOption(
  value: string,
  previous: string[] = [],
): string[] {
  return [...previous, value];
}

export function parsePositiveIntOrUndefined(
  value: unknown,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const parsed = Math.trunc(value);
    return parsed > 0 ? parsed : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return undefined;
    return parsed;
  }
  return undefined;
}
