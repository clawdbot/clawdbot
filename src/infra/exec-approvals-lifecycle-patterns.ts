// Matches executable shell glob patterns that can resolve to the OpenClaw CLI.
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        // A single-character over-approximation stays safe for malformed or negated classes.
        source += ".";
        index = end;
        continue;
      }
    }
    source += /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`, "iu");
}

/** Return true when an executable token is or can glob-expand to OpenClaw. */
export function isOpenClawExecutablePattern(value: string | undefined): boolean {
  const executable = normalizeExecutableToken(value ?? "");
  if (executable === "openclaw" || executable.startsWith("openclaw@")) {
    return true;
  }
  return /[*?[]/u.test(executable) && globPatternToRegExp(executable).test("openclaw");
}
