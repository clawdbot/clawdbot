// OSC 8 terminal hyperlink formatting with plain-text fallback.

function stripTerminalLinkControls(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      out += char;
    }
  }
  return out;
}

/** Format a clickable terminal link when supported, otherwise return a readable fallback. */
export function formatTerminalLink(
  label: string,
  url: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const safeLabel = stripTerminalLinkControls(label);
  const safeUrl = stripTerminalLinkControls(url);
  const allow = opts?.force === true ? true : opts?.force === false ? false : process.stdout.isTTY;
  if (!allow) {
    return opts?.fallback === undefined
      ? `${safeLabel} (${safeUrl})`
      : stripTerminalLinkControls(opts.fallback);
  }
  return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}
