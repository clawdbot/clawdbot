export function parseKeyValueOutput(
  output: string,
  separator: string,
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(separator);
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    if (!key) continue;
    const value = line.slice(idx + separator.length).trim();
    entries[key] = value;
  }
  return entries;
}
