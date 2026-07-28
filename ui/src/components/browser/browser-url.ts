export function normalizeBrowserUrlDraft(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // A colon followed by digits is a port, not a scheme.
  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(trimmed);
  if (hasExplicitScheme && !/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  const candidate = hasExplicitScheme ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
