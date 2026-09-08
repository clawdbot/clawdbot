export function assertAllowedJsonFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  options: { fieldPrefix?: string; reportField?: boolean } = {},
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  // Empty JSON keys are valid; only undefined means every field was allowed.
  if (unexpected !== undefined) {
    const field = unexpected === "" ? '""' : unexpected;
    const detail =
      options.reportField === false
        ? "an unexpected field"
        : `unexpected field ${options.fieldPrefix ?? ""}${field}`;
    throw new Error(`${label} has ${detail}`);
  }
}
