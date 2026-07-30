// Resolves PowerShell Start-Process layouts that launch the OpenClaw CLI.
import { splitShellArgs } from "../utils/shell-argv.js";
import { isOpenClawExecutablePattern } from "./exec-approvals-lifecycle-patterns.js";
import { splitLifecycleCommandText } from "./exec-approvals-lifecycle-shell.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

const START_PROCESS_NAMES = new Set(["saps", "start", "start-process"]);
const START_PROCESS_FLAGS = new Set([
  "-confirm",
  "-debug",
  "-loaduserprofile",
  "-nonewwindow",
  "-passthru",
  "-usenewenvironment",
  "-verbose",
  "-wait",
  "-whatif",
]);
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

function collectArgumentList(
  argv: readonly string[],
  start: number,
): { argumentList: string[]; lastIndex: number } {
  const argumentList: string[] = [];
  let index = start;
  for (; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const name = resolveOptionName(token);
    if (
      index > start &&
      (START_PROCESS_OPTIONS_WITH_VALUE.has(name) || START_PROCESS_FLAGS.has(name))
    ) {
      break;
    }
    argumentList.push(...splitArgumentList(token));
  }
  return { argumentList, lastIndex: index - 1 };
}

function inlineOptionValue(token: string): string | undefined {
  const separatorIndex = token.search(/[=:]/u);
  return separatorIndex === -1 ? undefined : token.slice(separatorIndex + 1);
}

function looksLikeOpenClawSelector(token: string, allowUnresolved: boolean): boolean {
  const normalized = token
    .trim()
    .toLowerCase()
    .replaceAll("`", "")
    .replaceAll("^", "")
    .replace(/\[([a-z0-9])\]/giu, "$1")
    .replace(/["']/gu, "");
  return (
    normalized.includes("openclaw") ||
    /opencla[?*]/u.test(normalized) ||
    (allowUnresolved && /\$env:[A-Za-z_][A-Za-z0-9_]*/iu.test(token))
  );
}

function isPowerShellProcessOrServiceSource(argv: readonly string[]): boolean {
  return ["get-process", "get-service", "gps", "gsv", "ps"].includes(
    normalizeExecutableToken(argv[0] ?? ""),
  );
}

function isPowerShellSelection(argv: readonly string[], allowUnresolved: boolean): boolean {
  return (
    isPowerShellProcessOrServiceSource(argv) &&
    argv.slice(1).some((token) => looksLikeOpenClawSelector(token, allowUnresolved))
  );
}

function isPowerShellOpenClawFilter(argv: readonly string[], allowUnresolved: boolean): boolean {
  return (
    ["?", "where", "where-object"].includes(normalizeExecutableToken(argv[0] ?? "")) &&
    argv.slice(1).some((token) => looksLikeOpenClawSelector(token, allowUnresolved))
  );
}

function isPowerShellPipelineMutation(argv: readonly string[]): boolean {
  return [
    "kill",
    "remove-service",
    "restart-service",
    "resume-service",
    "sasv",
    "set-service",
    "start-service",
    "stop-process",
    "stop-service",
    "suspend-service",
    "spps",
    "spsv",
  ].includes(normalizeExecutableToken(argv[0] ?? ""));
}

/** Return true when a PowerShell pipeline selects and mutates an OpenClaw process or service. */
export function commandHasPowerShellLifecyclePipeline(
  command: string,
  allowUnresolved = false,
): boolean {
  const stages = splitLifecycleCommandText(command, new Set(["|"]), "powershell");
  if (stages.length < 2) {
    return false;
  }
  let processOrServiceSource = false;
  let selectedOpenClaw = false;
  for (const stage of stages) {
    const normalizedStage = stage.trim().replace(/^[({\s]+|[)}\s]+$/gu, "");
    const argv = splitShellArgs(normalizedStage);
    if (!argv) {
      return false;
    }
    if (isPowerShellSelection(argv, allowUnresolved)) {
      processOrServiceSource = true;
      selectedOpenClaw = true;
      continue;
    }
    if (isPowerShellProcessOrServiceSource(argv)) {
      processOrServiceSource = true;
      continue;
    }
    if (processOrServiceSource && isPowerShellOpenClawFilter(argv, allowUnresolved)) {
      selectedOpenClaw = true;
      continue;
    }
    if (selectedOpenClaw && isPowerShellPipelineMutation(argv)) {
      return true;
    }
  }
  return false;
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
      const inline = inlineOptionValue(token);
      if (inline !== undefined) {
        argumentList = splitArgumentList(inline);
      } else {
        const collected = collectArgumentList(argv, index + 1);
        argumentList = collected.argumentList;
        index = collected.lastIndex;
      }
      continue;
    }
    if (START_PROCESS_FLAGS.has(name)) {
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
      const collected = collectArgumentList(argv, index);
      argumentList = collected.argumentList;
      index = collected.lastIndex;
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
      /\b(?:daemon|gateway|hooks|plugins|uninstall|update)\b/iu.test(
        parsed.argumentList.join(" "),
      )) ||
    (isOpenClawExecutablePattern(parsed.filePath) && parsed.argumentList.some(isUnresolved))
  );
}
