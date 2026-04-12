export function unwrapDefaultModuleExport(moduleExport: unknown): unknown {
  let resolved = moduleExport;
  const seen = new Set<unknown>();

  while (
    resolved &&
    typeof resolved === "object" &&
    "default" in (resolved as Record<string, unknown>) &&
    !seen.has(resolved)
  ) {
    seen.add(resolved);
    resolved = (resolved as { default: unknown }).default;
  }

  return resolved;
}
