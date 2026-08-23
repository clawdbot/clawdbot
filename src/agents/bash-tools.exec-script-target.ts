/** Parses direct Python and Node script targets from shell command text. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { splitShellArgs } from "../utils/shell-argv.js";

const PREFLIGHT_ENV_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-S",
  "-u",
  "--argv0",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);

function isShellEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
}

function isEnvExecutableToken(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  const base = normalizeOptionalLowercaseString(token.split(/[\\/]/u).at(-1)) ?? "";
  const normalizedBase = base.endsWith(".exe") ? base.slice(0, -4) : base;
  return normalizedBase === "env";
}

export function stripPreflightEnvPrefix(argv: string[]): string[] {
  if (argv.length === 0) {
    return argv;
  }
  let idx = 0;
  while (idx < argv.length && isShellEnvAssignmentToken(argv.at(idx) ?? "")) {
    idx += 1;
  }
  if (!isEnvExecutableToken(argv[idx])) {
    return argv;
  }
  idx += 1;
  while (idx < argv.length) {
    const token = argv.at(idx);
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (isShellEnvAssignmentToken(token)) {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    idx += 1;
    const equalsIndex = token.indexOf("=");
    const option = token.includes("=") ? token.slice(0, equalsIndex) : token;
    if (
      PREFLIGHT_ENV_OPTIONS_WITH_VALUES.has(option) &&
      !token.includes("=") &&
      idx < argv.length
    ) {
      idx += 1;
    }
  }
  return argv.slice(idx);
}

function findFirstPythonScriptArg(tokens: string[]): string | null {
  const optionsWithSeparateValue = new Set(["-W", "-X", "-Q", "--check-hash-based-pycs"]);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens.at(i);
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      const next = tokens.at(i + 1);
      return next && normalizeLowercaseStringOrEmpty(next).endsWith(".py") ? next : null;
    }
    if (token === "-") {
      return null;
    }
    if (token === "-c" || token === "-m") {
      return null;
    }
    if ((token.startsWith("-c") || token.startsWith("-m")) && token.length > 2) {
      return null;
    }
    if (optionsWithSeparateValue.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return normalizeLowercaseStringOrEmpty(token).endsWith(".py") ? token : null;
  }
  return null;
}

function findNodeScriptArgs(tokens: string[]): string[] {
  const optionsWithSeparateValue = new Set(["-r", "--require", "--import"]);
  const preloadScripts: string[] = [];
  let entryScript: string | null = null;
  let hasInlineEvalOrPrint = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens.at(i);
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      if (!hasInlineEvalOrPrint && !entryScript) {
        const next = tokens.at(i + 1);
        if (next && normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
          entryScript = next;
        }
      }
      break;
    }
    if (
      token === "-e" ||
      token === "-p" ||
      token === "--eval" ||
      token === "--print" ||
      token.startsWith("--eval=") ||
      token.startsWith("--print=") ||
      ((token.startsWith("-e") || token.startsWith("-p")) && token.length > 2)
    ) {
      hasInlineEvalOrPrint = true;
      if (token === "-e" || token === "-p" || token === "--eval" || token === "--print") {
        i += 1;
      }
      continue;
    }
    if (optionsWithSeparateValue.has(token)) {
      const next = tokens.at(i + 1);
      if (next && normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
        preloadScripts.push(next);
      }
      i += 1;
      continue;
    }
    if (
      (token.startsWith("-r") && token.length > 2) ||
      token.startsWith("--require=") ||
      token.startsWith("--import=")
    ) {
      const inlineValue = token.startsWith("-r")
        ? token.slice(2)
        : token.slice(token.indexOf("=") + 1);
      if (normalizeLowercaseStringOrEmpty(inlineValue).endsWith(".js")) {
        preloadScripts.push(inlineValue);
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (
      !hasInlineEvalOrPrint &&
      !entryScript &&
      normalizeLowercaseStringOrEmpty(token).endsWith(".js")
    ) {
      entryScript = token;
    }
    break;
  }
  const targets = [...preloadScripts];
  if (entryScript) {
    targets.push(entryScript);
  }
  return targets;
}

function extractInterpreterScriptTargetFromArgv(
  argv: string[] | null,
): { kind: "python"; relOrAbsPaths: string[] } | { kind: "node"; relOrAbsPaths: string[] } | null {
  if (!argv || argv.length === 0) {
    return null;
  }
  let commandIdx = 0;
  while (
    commandIdx < argv.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv.at(commandIdx) ?? "")
  ) {
    commandIdx += 1;
  }
  const executable = normalizeOptionalLowercaseString(argv.at(commandIdx));
  if (!executable) {
    return null;
  }
  const args = argv.slice(commandIdx + 1);
  if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
    const script = findFirstPythonScriptArg(args);
    return script ? { kind: "python", relOrAbsPaths: [script] } : null;
  }
  if (executable === "node") {
    const scripts = findNodeScriptArgs(args);
    return scripts.length > 0 ? { kind: "node", relOrAbsPaths: scripts } : null;
  }
  return null;
}

export function extractInterpreterScriptPathsFromSegment(rawSegment: string): string[] {
  const argv = splitShellArgs(rawSegment.trim());
  if (!argv || argv.length === 0) {
    return [];
  }
  const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
    ? argv.slice(1)
    : argv;
  const target = extractInterpreterScriptTargetFromArgv(
    stripPreflightEnvPrefix(withoutLeadingKeyword),
  );
  return target?.relOrAbsPaths ?? [];
}

export function extractScriptTargetFromCommand(
  command: string,
): { kind: "python"; relOrAbsPaths: string[] } | { kind: "node"; relOrAbsPaths: string[] } | null {
  const raw = command.trim();
  const splitShellArgsPreservingBackslashes = (value: string): string[] | null => {
    const tokens: string[] = [];
    let buf = "";
    let inSingle = false;
    let inDouble = false;

    const pushToken = () => {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = "";
      }
    };

    for (const ch of value) {
      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
        } else {
          buf += ch;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '"') {
          inDouble = false;
        } else {
          buf += ch;
        }
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (/\s/.test(ch)) {
        pushToken();
        continue;
      }
      buf += ch;
    }

    if (inSingle || inDouble) {
      return null;
    }
    pushToken();
    return tokens;
  };
  const shouldUseWindowsPathTokenizer =
    process.platform === "win32" &&
    /(?:^|[\s"'`])(?:[A-Za-z]:\\|\\\\|[^\s"'`|&;()<>]+\\[^\s"'`|&;()<>]+)/.test(raw);
  const candidateArgv = shouldUseWindowsPathTokenizer
    ? [splitShellArgsPreservingBackslashes(raw)]
    : [splitShellArgs(raw)];

  for (const argv of candidateArgv) {
    const attempts = [argv, argv ? stripPreflightEnvPrefix(argv) : null];
    for (const attempt of attempts) {
      const target = extractInterpreterScriptTargetFromArgv(attempt);
      if (target) {
        return target;
      }
    }
  }
  return null;
}
