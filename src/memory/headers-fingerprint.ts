function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

export function fingerprintHeaderNames(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  const out: string[] = [];
  for (const key of Object.keys(headers)) {
    const normalized = normalizeHeaderName(key);
    if (!normalized) continue;
    out.push(normalized);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}
