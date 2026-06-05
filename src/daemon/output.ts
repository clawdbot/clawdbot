/** Shared terminal output formatting helpers for daemon install/control commands. */
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";

/** Normalizes Windows separators for command output paths. */
export const toPosixPath = (value: string) => value.replace(/\\/g, "/");

/** Formats a labeled daemon output line with terminal-aware styling. */
export function formatLine(label: string, value: string): string {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
}

export function writeFormattedLines(
  stdout: NodeJS.WritableStream,
  lines: Array<{ label: string; value: string }>,
  opts?: { leadingBlankLine?: boolean },
): void {
  // Keep daemon command output line-oriented so shell callers can parse labels.
  if (opts?.leadingBlankLine) {
    stdout.write("\n");
  }
  for (const line of lines) {
    stdout.write(`${formatLine(line.label, line.value)}\n`);
  }
}
