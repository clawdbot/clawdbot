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
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

function splitArgumentList(value: string): string[] {
  const normalized = value.replace(/[,@()]/gu, " ");
  return splitShellArgs(normalized) ?? normalized.split(/\s+/u).filter(Boolean);
}

/** Return OpenClaw-equivalent argv when PowerShell Start-Process launches it. */
export function resolvePowerShellStartProcessOpenClawArgv(
  argv: readonly string[],
): string[] | null {
  if (!START_PROCESS_NAMES.has(normalizeExecutableToken(argv[0] ?? ""))) {
    return null;
  }
  let filePath: string | undefined;
  let argumentList: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const name = optionName(token);
    if (name === "-filepath") {
      filePath = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[++index];
      continue;
    }
    if (name === "-argumentlist") {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[++index];
      argumentList = splitArgumentList(value ?? "");
      continue;
    }
    if (START_PROCESS_OPTIONS_WITH_VALUE.has(name)) {
      if (!token.includes("=")) {
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
  return isOpenClawExecutablePattern(filePath) ? ["openclaw", ...argumentList] : null;
}
