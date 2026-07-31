// Resolves PowerShell Start-Process layouts that launch the OpenClaw CLI.
import { splitShellArgs } from "../utils/shell-argv.js";
import { classifyOpenClawArgv } from "./exec-approvals-lifecycle-cli.js";
import {
  isOpenClawExecutablePattern,
  matchesOpenClawProcessNamePattern,
  negativePowerShellProcessNameSelectorExcludesAll,
} from "./exec-approvals-lifecycle-patterns.js";
import {
  splitLifecycleCommandText,
  splitLifecycleInlineCommands,
} from "./exec-approvals-lifecycle-shell.js";
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
const POWERSHELL_COMMON_OPTIONS_WITH_VALUE = new Set([
  "-erroraction",
  "-errorvariable",
  "-informationaction",
  "-informationvariable",
  "-outbuffer",
  "-outvariable",
  "-pipelinevariable",
  "-progressaction",
  "-warningaction",
  "-warningvariable",
]);
const POWERSHELL_SOURCE_SELECTOR_OPTIONS = new Set([
  "-displayname",
  "-id",
  "-inputobject",
  "-name",
]);
const POWERSHELL_ALIAS_OPTIONS_WITH_VALUE = new Set(["-description", "-option", "-scope"]);
const POWERSHELL_ALIAS_SETTERS = new Set(["nal", "new-alias", "sal", "set-alias"]);
const POWERSHELL_PIPELINE_OBJECT_MUTATION_RE =
  /(?:\$_|\$psitem)\??\.(?:closemainwindow|continue|kill|pause|start|stop)\(/iu;

function optionName(token: string): string {
  return token.trim().toLowerCase().split(/[=:]/u, 1)[0] ?? "";
}

function resolveOptionName(token: string): string {
  const name = optionName(token);
  const matches = [...START_PROCESS_OPTIONS_WITH_VALUE, ...START_PROCESS_FLAGS].filter(
    (candidate) => candidate.startsWith(name),
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

function powerShellSwitchValue(token: string): boolean | null {
  const value = inlineOptionValue(token);
  if (value === undefined) {
    return true;
  }
  const normalized = value.trim().toLowerCase().replace(/^\$/u, "");
  if (["1", "true"].includes(normalized)) {
    return true;
  }
  if (["0", "false"].includes(normalized)) {
    return false;
  }
  return null;
}

function looksLikeOpenClawSelector(token: string, allowUnresolved: boolean): boolean {
  const normalized = token
    .trim()
    .toLowerCase()
    .replaceAll("`", "")
    .replaceAll("^", "")
    .replace(/\[([a-z0-9])\]/giu, "$1")
    .replace(/["']/gu, "");
  if (allowUnresolved && /\$env:[A-Za-z_][A-Za-z0-9_]*/iu.test(token)) {
    return true;
  }
  if (
    /^[(){}]$/u.test(normalized) ||
    /^\$_?\./u.test(normalized) ||
    /^-[a-z]+$/u.test(normalized) ||
    ["displayname", "name", "processname"].includes(normalized)
  ) {
    return false;
  }
  return matchesOpenClawProcessNamePattern(normalized);
}

function isPowerShellProcessOrServiceSource(argv: readonly string[]): boolean {
  return ["get-process", "get-service", "gps", "gsv", "ps"].includes(
    normalizeExecutableToken(argv[0] ?? ""),
  );
}

function isUnfilteredPowerShellProcessOrServiceSource(argv: readonly string[]): boolean {
  if (!isPowerShellProcessOrServiceSource(argv)) {
    return false;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const name = optionName(token);
    if (POWERSHELL_SOURCE_SELECTOR_OPTIONS.has(name)) {
      return false;
    }
    if (POWERSHELL_COMMON_OPTIONS_WITH_VALUE.has(name) && !token.includes(":")) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      return false;
    }
  }
  return true;
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

function powerShellIdentityFilterKeepsOpenClaw(
  argv: readonly string[],
  allowUnresolved: boolean,
): boolean {
  const negativeIndex = argv.findIndex((token) =>
    ["-ne", "-notcontains", "-notin", "-notlike", "-notmatch"].includes(token.trim().toLowerCase()),
  );
  if (negativeIndex === -1) {
    return isPowerShellOpenClawFilter(argv, allowUnresolved);
  }
  const operands = argv.slice(negativeIndex + 1);
  if (operands.some((token) => ["&&", "-and", "-or", "-xor", "||"].includes(token.toLowerCase()))) {
    return true;
  }
  if (operands.some((token) => /[$@][A-Za-z_][A-Za-z0-9_]*/u.test(token))) {
    return true;
  }
  const selectors = operands.filter((token) => !/^[(){}]$/u.test(token.trim()));
  return !(
    selectors.length === 1 &&
    negativePowerShellProcessNameSelectorExcludesAll(
      selectors[0],
      argv[negativeIndex]?.trim().toLowerCase() ?? "",
    )
  );
}

function isPowerShellIdentityFilter(argv: readonly string[]): boolean {
  return (
    ["?", "where", "where-object"].includes(normalizeExecutableToken(argv[0] ?? "")) &&
    argv.slice(1).some((token) =>
      ["displayname", "name", "processname"].includes(
        token
          .trim()
          .toLowerCase()
          .replace(/^\$_?\./u, ""),
      ),
    )
  );
}

function isPowerShellPipelineMutation(argv: readonly string[]): boolean {
  const mutations = new Set([
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
  ]);
  if (mutations.has(normalizeExecutableToken(argv[0] ?? ""))) {
    return true;
  }
  if (
    !["%", "foreach", "foreach-object", "where", "where-object"].includes(
      normalizeExecutableToken(argv[0] ?? ""),
    )
  ) {
    return false;
  }
  if (argv.slice(1).some((token) => mutations.has(normalizeExecutableToken(token)))) {
    return true;
  }
  const script = argv.slice(1).join("").replaceAll("`", "");
  return POWERSHELL_PIPELINE_OBJECT_MUTATION_RE.test(script);
}

function parsePowerShellAlias(
  argv: readonly string[],
): { name: string | undefined; value: string | undefined } | null {
  if (!POWERSHELL_ALIAS_SETTERS.has(normalizeExecutableToken(argv[0] ?? ""))) {
    return null;
  }
  let name: string | undefined;
  let value: string | undefined;
  const positionals: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const option = optionName(token);
    if (["-n", "-name"].includes(option)) {
      name = inlineOptionValue(token) ?? argv[++index];
    } else if (["-v", "-value"].includes(option)) {
      value = inlineOptionValue(token) ?? argv[++index];
    } else if (POWERSHELL_ALIAS_OPTIONS_WITH_VALUE.has(option)) {
      if (inlineOptionValue(token) === undefined) {
        index += 1;
      }
    } else if (!token.startsWith("-")) {
      positionals.push(token);
    }
  }
  name ??= positionals[0];
  value ??= positionals[1];
  return { name, value };
}

function isDynamicPowerShellAliasReference(value: string | undefined): boolean {
  const normalized = (value ?? "").trim();
  return /^[$@([\]{}]/u.test(normalized) || normalized.includes("$(");
}

function extractPowerShellPipelineScriptBlocks(command: string): string[] {
  if (splitLifecycleCommandText(command, new Set(["|"]), "powershell").length < 2) {
    return [];
  }
  const blocks: string[] = [];
  let blockStart = -1;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "`") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        blockStart = index + 1;
      }
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && blockStart !== -1) {
        blocks.push(command.slice(blockStart, index));
        blockStart = -1;
      }
    }
  }
  return blocks;
}

/** Recursively classify executable fragments embedded in PowerShell pipeline script blocks. */
export function powerShellPipelineScriptBlocksRequireApproval(
  command: string,
  classify: (argv: string[], raw: string) => boolean,
): boolean {
  return extractPowerShellPipelineScriptBlocks(command).some(
    (scriptBlock) =>
      powerShellAliasLifecycleInvocationRequiresApproval(scriptBlock) ||
      splitLifecycleInlineCommands(scriptBlock, "powershell").some((part) => {
        const argv = splitShellArgs(part);
        return argv ? classify(argv, part) : false;
      }) ||
      powerShellPipelineScriptBlocksRequireApproval(scriptBlock, classify),
  );
}

/** Return true when a PowerShell alias resolves to a lifecycle-mutating OpenClaw invocation. */
export function powerShellAliasLifecycleInvocationRequiresApproval(
  command: string,
  expandArgv?: (argv: string[]) => { argv: readonly string[]; unresolved: boolean },
): boolean {
  const openClawAliases = new Set<string>();
  const unresolvedAliases = new Set<string>();
  let unresolvedAliasName = false;
  for (const fragment of splitLifecycleCommandText(
    command,
    new Set([";", "|", "\n", "\r"]),
    "powershell",
  )) {
    const parsed = splitShellArgs(fragment.trim().replace(/^[({\s]+|[)}\s]+$/gu, ""));
    if (!parsed?.length) {
      continue;
    }
    const expanded = expandArgv?.(parsed) ?? { argv: parsed, unresolved: false };
    const rawAlias = parsePowerShellAlias(parsed);
    if (rawAlias) {
      const resolvedAlias = parsePowerShellAlias(expanded.argv);
      const rawName = normalizeExecutableToken(rawAlias.name ?? "");
      const resolvedName = normalizeExecutableToken(resolvedAlias?.name ?? "");
      const aliasValue = resolvedAlias?.value ?? rawAlias.value;
      const rawNameIsDynamic = isDynamicPowerShellAliasReference(rawAlias.name);
      const resolvedNameIsDynamic = isDynamicPowerShellAliasReference(resolvedAlias?.name);
      const aliasName =
        resolvedName && !resolvedNameIsDynamic ? resolvedName : rawNameIsDynamic ? "" : rawName;
      if (!aliasName) {
        unresolvedAliasName ||= rawNameIsDynamic;
        continue;
      }
      openClawAliases.delete(aliasName);
      unresolvedAliases.delete(aliasName);
      if (isOpenClawExecutablePattern(aliasValue)) {
        openClawAliases.add(aliasName);
      } else if (
        expanded.unresolved ||
        (isDynamicPowerShellAliasReference(rawAlias.value) &&
          (!resolvedAlias?.value || isDynamicPowerShellAliasReference(resolvedAlias.value)))
      ) {
        unresolvedAliases.add(aliasName);
      }
      continue;
    }
    const invocation = ["&", "."].includes(parsed[0] ?? "") ? parsed.slice(1) : parsed;
    const aliasName = normalizeExecutableToken(invocation[0] ?? "");
    const lifecycleInvocation = classifyOpenClawArgv(["openclaw", ...invocation.slice(1)]);
    if (
      lifecycleInvocation &&
      (openClawAliases.has(aliasName) || unresolvedAliases.has(aliasName) || unresolvedAliasName)
    ) {
      return true;
    }
  }
  return false;
}

/** Return true when a PowerShell pipeline selects and mutates an OpenClaw process or service. */
export function commandHasPowerShellLifecyclePipeline(
  command: string,
  allowUnresolved = false,
  expandArgv?: (argv: string[]) => { argv: readonly string[]; unresolved: boolean },
  classifyScriptBlock?: (argv: string[], raw: string) => boolean,
): boolean {
  const classify =
    classifyScriptBlock ??
    ((argv: string[]) =>
      isOpenClawExecutablePattern(argv[0]) && classifyOpenClawArgv(["openclaw", ...argv.slice(1)]));
  if (powerShellPipelineScriptBlocksRequireApproval(command, classify)) {
    return true;
  }
  const stages = splitLifecycleCommandText(command, new Set(["|"]), "powershell");
  if (stages.length < 2) {
    return false;
  }
  let processOrServiceSource = false;
  let selectedOpenClaw = false;
  for (const stage of stages) {
    const normalizedStage = stage.trim().replace(/^[({\s]+|[)}\s]+$/gu, "");
    const parsedArgv = splitShellArgs(normalizedStage);
    if (!parsedArgv) {
      return false;
    }
    const expanded = expandArgv?.(parsedArgv);
    const argv = expanded && !expanded.unresolved ? expanded.argv : parsedArgv;
    if (isPowerShellSelection(argv, allowUnresolved)) {
      processOrServiceSource = true;
      selectedOpenClaw = true;
      continue;
    }
    if (isPowerShellProcessOrServiceSource(argv)) {
      processOrServiceSource = true;
      selectedOpenClaw ||= isUnfilteredPowerShellProcessOrServiceSource(argv);
      continue;
    }
    if (processOrServiceSource && isPowerShellIdentityFilter(argv)) {
      selectedOpenClaw = powerShellIdentityFilterKeepsOpenClaw(argv, allowUnresolved);
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
  let whatIf = false;
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
    if (name === "-whatif") {
      whatIf = powerShellSwitchValue(token) === true;
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
  return whatIf ? null : { argumentList, filePath };
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
  if (
    argv
      .slice(1)
      .some((token) => /^@[A-Za-z_][A-Za-z0-9_]*$/u.test(token.trim()) && isUnresolved(token))
  ) {
    return true;
  }
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
