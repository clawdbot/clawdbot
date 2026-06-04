/** Shared parser for slash commands with action and argument tails. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Internal parse state for slash command action extraction. */
export type SlashCommandParseResult =
  | { kind: "no-match" }
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "parsed"; action: string; args: string };

/** Public slash-command parse result returned to command handlers. */
export type ParsedSlashCommand =
  | { ok: true; action: string; args: string }
  | { ok: false; message: string };

function parseSlashCommandActionArgs(raw: string, slash: string): SlashCommandParseResult {
  const trimmed = raw.trim();
  const slashLower = normalizeLowercaseStringOrEmpty(slash);
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith(slashLower)) {
    return { kind: "no-match" };
  }
  // Fix #84572: enforce a boundary after the prefix so `/config-check` does
  // not match the `/config` handler. The character immediately after the
  // matched prefix must be whitespace, a colon, or end-of-string. Otherwise
  // the prefix collided with a longer command name (e.g. a skill named
  // `config-check`) and should be treated as a non-match so the longer
  // handler — or the skill router — gets a chance to claim it.
  const charAfter = trimmed.charAt(slash.length);
  if (charAfter && !/[\s:]/.test(charAfter)) {
    return { kind: "no-match" };
  }
  const rest = trimmed.slice(slash.length).trim();
  if (!rest) {
    return { kind: "empty" };
  }
  const match = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!match) {
    return { kind: "invalid" };
  }
  const action = normalizeLowercaseStringOrEmpty(match[1]);
  const args = (match[2] ?? "").trim();
  return { kind: "parsed", action, args };
}

/** Parses a slash command or returns null when the prefix does not match. */
export function parseSlashCommandOrNull(
  raw: string,
  slash: string,
  opts: { invalidMessage: string; defaultAction?: string },
): ParsedSlashCommand | null {
  const parsed = parseSlashCommandActionArgs(raw, slash);
  if (parsed.kind === "no-match") {
    return null;
  }
  if (parsed.kind === "invalid") {
    return { ok: false, message: opts.invalidMessage };
  }
  if (parsed.kind === "empty") {
    return { ok: true, action: opts.defaultAction ?? "show", args: "" };
  }
  return { ok: true, action: parsed.action, args: parsed.args };
}
