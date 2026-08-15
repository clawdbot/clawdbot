// macOS user helpers support Parallels guest fallback discovery.
export function parseMacosDsclUserHomeLine(line: string): { user: string; home: string } | null {
  const match = /^(\S+)\s+(.+?)\s*$/u.exec(line.replaceAll("\r", ""));
  if (!match) {
    return null;
  }
  return { user: match[1]!, home: match[2]! };
}

export function isLikelyMacosDesktopHome(home: string | undefined): boolean {
  const normalized = home?.trim();
  return normalized !== undefined && /(?:^|\/)Users\/[^/]+$/u.test(normalized);
}
