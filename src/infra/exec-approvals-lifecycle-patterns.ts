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
      const posixClass = /^\[\[:[a-z]+:\]\]/iu.exec(pattern.slice(index));
      if (posixClass) {
        source += ".";
        index += posixClass[0].length - 1;
        continue;
      }
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        // A single-character over-approximation stays safe for malformed or negated classes.
        source += ".";
        index = end;
        continue;
      }
    }
    if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end !== -1) {
        const body = pattern.slice(index + 1, end);
        const range = /^([a-z])\.\.([a-z])$/iu.exec(body);
        const choices = range
          ? Array.from(
              { length: Math.abs(range[1]!.charCodeAt(0) - range[2]!.charCodeAt(0)) + 1 },
              (_unused, offset) =>
                String.fromCharCode(
                  range[1]!.charCodeAt(0) +
                    offset * (range[1]!.charCodeAt(0) <= range[2]!.charCodeAt(0) ? 1 : -1),
                ),
            )
          : body.split(",").map((choice) => choice.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"));
        source += choices.length === 1 ? (choices[0] ?? "") : `(?:${choices.join("|")})`;
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
  if (
    executable === "openclaw" ||
    executable === "openclaw.mjs" ||
    executable.startsWith("openclaw@")
  ) {
    return true;
  }
  return (
    /[*?[{]/u.test(executable) &&
    ["openclaw", "openclaw.mjs"].some((candidate) =>
      globPatternToRegExp(executable).test(candidate),
    )
  );
}

/** Return true when a process selector regex or wildcard can select OpenClaw. */
export function matchesOpenClawProcessPattern(value: string | undefined): boolean {
  const pattern = (value ?? "").trim().toLowerCase().replace(/["']/gu, "");
  if (pattern.includes("openclaw")) {
    return true;
  }
  const candidates = ["openclaw", "openclaw.exe", "openclaw gateway", "/opt/openclaw"];
  if (
    /[*?[]/u.test(pattern) &&
    candidates.some((name) => globPatternToRegExp(pattern).test(name))
  ) {
    return true;
  }
  try {
    const regex = new RegExp(pattern, "iu");
    return candidates.some((name) => regex.test(name));
  } catch {
    return false;
  }
}

/** Return true when a system service/unit glob can select an OpenClaw unit. */
export function matchesOpenClawUnitPattern(value: string | undefined): boolean {
  const pattern = (value ?? "").trim().toLowerCase().replace(/["']/gu, "");
  if (pattern.includes("openclaw")) {
    return true;
  }
  return (
    /[*?[{]/u.test(pattern) &&
    ["openclaw-gateway.service", "openclaw.service", "com.openclaw.gateway"].some((unit) =>
      globPatternToRegExp(pattern).test(unit),
    )
  );
}
