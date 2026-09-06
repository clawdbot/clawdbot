// OSC 8 terminal hyperlink formatting with plain-text fallback.

function stripTerminalLinkControls(value: string): string {
  // Remove C0, DEL, and C1 only; printable ANSI fragments remain literal text.
  return value.replace(/\p{Cc}/gu, "");
}

/** Format a clickable terminal link when supported, otherwise return a readable fallback. */
export function formatTerminalLink(
  label: string,
  url: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const allow = opts?.force === true ? true : opts?.force === false ? false : process.stdout.isTTY;
  if (!allow && opts?.fallback !== undefined) {
    return stripTerminalLinkControls(opts.fallback);
  }
  const safeLabel = stripTerminalLinkControls(label);
  const safeUrl = stripTerminalLinkControls(url);
  if (!allow) {
    return `${safeLabel} (${safeUrl})`;
  }
  return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}
