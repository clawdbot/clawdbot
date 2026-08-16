// Matches executable shell glob patterns that can resolve to the OpenClaw CLI.
import { compileSafeRegexDetailed, testRegexWithBoundedInput } from "../security/safe-regex.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

/** Return true for known OpenClaw CLI entry scripts under an OpenClaw path. */
export function isOpenClawEntryScriptPath(value: string | undefined): boolean {
  const script = (value ?? "").trim().toLowerCase().replace(/["']/gu, "");
  return (
    script.includes("openclaw") &&
    /(?:^|[/\\])(?:openclaw\.mjs|(?:dist[/\\])?(?:entry|index)\.(?:c?js|mjs))$/u.test(script)
  );
}

function globPatternSource(pattern: string): string {
  let source = "";
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
      let depth = 1;
      let end = index + 1;
      for (; end < pattern.length && depth > 0; end += 1) {
        if (pattern[end] === "{") {
          depth += 1;
        } else if (pattern[end] === "}") {
          depth -= 1;
        }
      }
      end = depth === 0 ? end - 1 : -1;
      if (end !== -1) {
        const body = pattern.slice(index + 1, end);
        const range = /^([a-z])\.\.([a-z])$/iu.exec(body);
        const alternatives: string[] = [];
        let alternativeStart = 0;
        let alternativeDepth = 0;
        for (let offset = 0; offset <= body.length; offset += 1) {
          const bodyChar = body[offset];
          if (bodyChar === "{") {
            alternativeDepth += 1;
          } else if (bodyChar === "}") {
            alternativeDepth = Math.max(0, alternativeDepth - 1);
          }
          if ((bodyChar === "," && alternativeDepth === 0) || offset === body.length) {
            alternatives.push(body.slice(alternativeStart, offset));
            alternativeStart = offset + 1;
          }
        }
        const choices = range
          ? Array.from(
              { length: Math.abs(range[1]!.charCodeAt(0) - range[2]!.charCodeAt(0)) + 1 },
              (_unused, offset) =>
                String.fromCharCode(
                  range[1]!.charCodeAt(0) +
                    offset * (range[1]!.charCodeAt(0) <= range[2]!.charCodeAt(0) ? 1 : -1),
                ),
            )
          : alternatives.map(globPatternSource);
        source += choices.length === 1 ? (choices[0] ?? "") : `(?:${choices.join("|")})`;
        index = end;
        continue;
      }
    }
    source += /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char;
  }
  return source;
}

function globPatternToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globPatternSource(pattern)}$`, "iu");
}

/** Return true when an executable token is or can glob-expand to a candidate basename. */
export function matchesLifecycleExecutablePattern(
  value: string | undefined,
  candidates: ReadonlySet<string>,
): boolean {
  const executable = normalizeExecutableToken(value ?? "");
  return (
    candidates.has(executable) ||
    (/[*?[{]/u.test(executable) &&
      [...candidates].some((candidate) => globPatternToRegExp(executable).test(candidate)))
  );
}

/** Return true when an executable token is or can glob-expand to OpenClaw. */
export function isOpenClawExecutablePattern(value: string | undefined): boolean {
  const executable = normalizeExecutableToken(value ?? "");
  if (
    executable === "openclaw" ||
    executable === "openclaw.mjs" ||
    executable === "openclaw.ps1" ||
    executable.startsWith("openclaw@") ||
    isOpenClawEntryScriptPath(value)
  ) {
    return true;
  }
  return matchesLifecycleExecutablePattern(
    executable,
    new Set(["openclaw", "openclaw.mjs", "openclaw.ps1"]),
  );
}

/** Return true when a process selector regex or wildcard can select OpenClaw. */
export function matchesOpenClawProcessPattern(value: string | undefined): boolean {
  return matchesOpenClawProcessCandidates(value, [
    ...OPENCLAW_PROCESS_NAME_CANDIDATES,
    "node.exe",
    "openclaw gateway",
    "/opt/openclaw",
    "node /opt/openclaw/openclaw.mjs gateway",
    "node /opt/openclaw/dist/entry.js gateway",
    "node /opt/openclaw/dist/index.js gateway",
    String.raw`node C:\Users\Alice\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs gateway`,
  ]);
}

const OPENCLAW_PROCESS_NAME_CANDIDATES = [
  "openclaw",
  "openclaw.exe",
  "openclaw.ps1",
  "openclaw.mjs",
  "node",
  "node.exe",
] as const;

function matchesOpenClawProcessCandidates(
  value: string | undefined,
  candidates: readonly string[],
): boolean {
  const pattern = (value ?? "").trim().toLowerCase().replace(/["']/gu, "");
  if (!pattern) {
    return false;
  }
  const spellsOpenClaw =
    /o[^a-z0-9]*p[^a-z0-9]*e[^a-z0-9]*n[^a-z0-9]*c[^a-z0-9]*l[^a-z0-9]*a[^a-z0-9]*w/iu;
  if (pattern.includes("openclaw") || spellsOpenClaw.test(pattern)) {
    return true;
  }
  if (
    /[*?[]/u.test(pattern) &&
    candidates.some((name) => globPatternToRegExp(pattern).test(name))
  ) {
    return true;
  }
  const compiled = compileSafeRegexDetailed(pattern, "iu");
  if (!compiled.regex) {
    // Unsafe or unsupported selectors fail closed before process selection.
    return true;
  }
  return candidates.some((name) => testRegexWithBoundedInput(compiled.regex, name));
}

/** Return true when a PowerShell process-name selector can select OpenClaw. */
export function matchesOpenClawProcessNamePattern(value: string | undefined): boolean {
  return matchesOpenClawProcessCandidates(value, OPENCLAW_PROCESS_NAME_CANDIDATES);
}

/** Return true only when a negative PowerShell selector excludes every OpenClaw host name. */
export function negativePowerShellProcessNameSelectorExcludesAll(
  value: string | undefined,
  operator: string,
): boolean {
  const pattern = (value ?? "").trim().toLowerCase().replace(/["']/gu, "");
  if (!pattern) {
    return false;
  }
  if (operator === "-notlike") {
    const wildcard = globPatternToRegExp(pattern);
    return OPENCLAW_PROCESS_NAME_CANDIDATES.every((name) => wildcard.test(name));
  }
  if (operator === "-notmatch") {
    const compiled = compileSafeRegexDetailed(pattern, "iu");
    return Boolean(
      compiled.regex &&
      OPENCLAW_PROCESS_NAME_CANDIDATES.every((name) =>
        testRegexWithBoundedInput(compiled.regex!, name),
      ),
    );
  }
  return false;
}

function matchesCurrentOpenClawLaunchdGlob(pattern: string): boolean {
  const basename = pattern.split(/[/\\]/u).at(-1) ?? "";
  const labelParts = basename.split(".");
  return (
    labelParts.length >= 3 &&
    globPatternToRegExp(labelParts[0] ?? "").test("ai") &&
    globPatternToRegExp(labelParts[1] ?? "").test("openclaw")
  );
}

/** Return true when a system service/unit glob can select an OpenClaw unit. */
export function matchesOpenClawUnitPattern(value: string | undefined): boolean {
  const pattern = (value ?? "").trim().toLowerCase().replace(/["']/gu, "");
  if (pattern.includes("openclaw")) {
    return true;
  }
  return (
    (/[*?[{]/u.test(pattern) &&
      [
        "openclaw-gateway.service",
        "openclaw.service",
        "ai.openclaw.gateway",
        "ai.openclaw.gateway.plist",
        "~/Library/LaunchAgents/ai.openclaw.gateway.plist",
        "/Users/alice/Library/LaunchAgents/ai.openclaw.gateway.plist",
        "com.openclaw.gateway",
        "com.openclaw.gateway.plist",
        "~/Library/LaunchAgents/com.openclaw.gateway.plist",
        "/Users/alice/Library/LaunchAgents/com.openclaw.gateway.plist",
      ].some((unit) => globPatternToRegExp(pattern).test(unit))) ||
    matchesCurrentOpenClawLaunchdGlob(pattern)
  );
}
