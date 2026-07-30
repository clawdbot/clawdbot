// Resolves PowerShell Start-Process layouts that launch the OpenClaw CLI.
import { splitShellArgs } from "../utils/shell-argv.js";
import { isOpenClawExecutablePattern } from "./exec-approvals-lifecycle-patterns.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

const START_PROCESS_NAMES = new Set(["saps", "start", "start-process"]);
const START_PROCESS_OPTIONS_WITH_VALUE = new Set([
  "-argumentlist",
  "-credential",
  "-environment",
  "-filepath",
  "-redirectstandarderror",
  "-redirectstandardinput",
  "-redirectstandardoutput",
  "-verb",
  "-windowstyle",
  "-workingdirectory",
]);

function optionName(token: string): string {
  return token.trim().toLowerCase().split(/[=:]/u, 1)[0] ?? "";
}

function resolveOptionName(token: string): string {
  const name = optionName(token);
  const matches = [...START_PROCESS_OPTIONS_WITH_VALUE].filter((candidate) =>
    candidate.startsWith(name),
  );
  return matches.length === 1 ? (matches[0] ?? name) : name;
}

function splitArgumentList(value: string): string[] {
  const normalized = value.replace(/[,@()]/gu, " ");
  return splitShellArgs(normalized) ?? normalized.split(/\s+/u).filter(Boolean);
}

function inlineOptionValue(token: string): string | undefined {
  const separatorIndex = token.search(/[=:]/u);
  return separatorIndex === -1 ? undefined : token.slice(separatorIndex + 1);
}

function parseStartProcessArgv(
  argv: readonly string[],
): { argumentList: string[]; filePath: string | undefined } | null {
  if (!START_PROCESS_NAMES.has(normalizeExecutableToken(argv[0] ?? ""))) {
    return null;
  }
  let filePath: string | undefined;
  let argumentList: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const name = resolveOptionName(token);
    if (name === "-filepath") {
      filePath = inlineOptionValue(token) ?? argv[++index];
      continue;
    }
    if (name === "-argumentlist") {
      const value = inlineOptionValue(token) ?? argv[++index];
      argumentList = splitArgumentList(value ?? "");
      continue;
    }
    if (START_PROCESS_OPTIONS_WITH_VALUE.has(name)) {
      if (inlineOptionValue(token) === undefined) {
        index += 1;
      }
      continue;
    }
    if (!token.startsWith("-") && !filePath) {
      filePath = token;
    } else if (!token.startsWith("-") && argumentList.length === 0) {
      argumentList = splitArgumentList(token);
    }
  }
  return { argumentList, filePath };
}

/** Return OpenClaw-equivalent argv when PowerShell Start-Process launches it. */
export function resolvePowerShellStartProcessOpenClawArgv(
  argv: readonly string[],
): string[] | null {
  const parsed = parseStartProcessArgv(argv);
  if (!parsed) {
    return null;
  }
  const { argumentList, filePath } = parsed;
  return isOpenClawExecutablePattern(filePath) ? ["openclaw", ...argumentList] : null;
}

/** Return true when Start-Process can dynamically select OpenClaw lifecycle argv. */
export function unresolvedPowerShellStartProcessMayHideLifecycle(
  argv: readonly string[],
  isUnresolved: (value: string | undefined) => boolean,
): boolean {
  const parsed = parseStartProcessArgv(argv);
  if (!parsed) {
    return false;
  }
  return (
    (isUnresolved(parsed.filePath) &&
      /\b(?:daemon|gateway|uninstall|update)\b/iu.test(parsed.argumentList.join(" "))) ||
    (isOpenClawExecutablePattern(parsed.filePath) && parsed.argumentList.some(isUnresolved))
  );
}
