export function parseConfigValue(
  raw: string,
): { value?: unknown; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Missing value." };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { value: JSON.parse(trimmed) };
    } catch (err) {
      return { error: `Invalid JSON: ${String(err)}` };
    }
  }

  if (trimmed === "true") return { value: true };
  if (trimmed === "false") return { value: false };
  if (trimmed === "null") return { value: null };

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return { value: num };
  }

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return { value: JSON.parse(trimmed) };
    } catch {
      const unquoted = trimmed.slice(1, -1);
      return { value: unquoted };
    }
  }

  return { value: trimmed };
}
