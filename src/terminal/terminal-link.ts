export function formatTerminalLink(
  label: string,
  url: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const esc = "\u001b";
  const safeLabel = label.replaceAll(esc, "");
  const safeUrl = url.replaceAll(esc, "");
  const allow = opts?.force === true ? true : opts?.force === false ? false : process.stdout.isTTY;
  if (!allow) {
    return opts?.fallback ?? `${safeLabel} (${safeUrl})`;
  }
  return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}
