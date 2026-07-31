// Resolves PowerShell Start-Process layouts that launch the OpenClaw CLI.
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { classifyOpenClawArgv } from "./exec-approvals-lifecycle-cli.js";
import {
  isOpenClawExecutablePattern,
  matchesOpenClawProcessNamePattern,
  negativePowerShellProcessNameSelectorExcludesAll,
} from "./exec-approvals-lifecycle-patterns.js";
import { resolveLifecyclePackageRunnerArgv } from "./exec-approvals-lifecycle-runners.js";
import {
  splitLifecycleCommandText,
  splitLifecycleInlineCommands,
  unwrapLifecycleControlArgv,
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
const POWERSHELL_COMMON_OPTION_ALIASES = new Map([
  ["-ea", "-erroraction"],
  ["-ev", "-errorvariable"],
  ["-ia", "-informationaction"],
  ["-iv", "-informationvariable"],
  ["-ob", "-outbuffer"],
  ["-ov", "-outvariable"],
  ["-pv", "-pipelinevariable"],
  ["-proga", "-progressaction"],
  ["-wa", "-warningaction"],
  ["-wv", "-warningvariable"],
]);
const POWERSHELL_SOURCE_SELECTOR_OPTIONS = new Set([
  "-displayname",
  "-id",
  "-inputobject",
  "-name",
]);
const POWERSHELL_ALIAS_OPTIONS_WITH_VALUE = new Set(["-description", "-option", "-scope"]);
const POWERSHELL_ALIAS_SETTERS = new Set(["nal", "new-alias", "sal", "set-alias"]);
const POWERSHELL_ALIAS_PROVIDER_SETTERS = new Set(["new-item", "ni", "set-item", "si"]);
const POWERSHELL_EXECUTABLE_SCRIPT_BLOCK_OPTIONS = new Set([
  "-action",
  "-begin",
  "-end",
  "-filterscript",
  "-initializationscript",
  "-parallel",
  "-process",
  "-scriptblock",
]);
const POWERSHELL_PIPELINE_OBJECT_MUTATION_RE =
  /(?:\$_|\$psitem)\??\.(?:closemainwindow|continue|kill|pause|start|stop)\(/iu;
const POWERSHELL_DIRECT_OBJECT_MUTATION_RE =
  /\(\s*((?:get-process|get-service|gps|gsv|ps)\b[^()]*)\)\s*\??\.\s*(?:closemainwindow|continue|kill|pause|start|stop)\s*\(/giu;

function optionName(token: string): string {
  return token.trim().toLowerCase().split(/[=:]/u, 1)[0] ?? "";
}

function resolvePowerShellCommonOptionName(token: string): string {
  const name = optionName(token);
  const alias = POWERSHELL_COMMON_OPTION_ALIASES.get(name);
  if (alias) {
    return alias;
  }
  const matches = [...POWERSHELL_COMMON_OPTIONS_WITH_VALUE].filter((candidate) =>
    candidate.startsWith(name),
  );
  return matches.length === 1 ? (matches[0] ?? name) : name;
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

/** Return true only when the final effective PowerShell WhatIf switch enables preview mode. */
export function powerShellArgvUsesWhatIf(argv: readonly string[]): boolean {
  let whatIf = false;
  for (const token of argv.slice(1)) {
    if (optionName(token) === "-whatif") {
      whatIf = powerShellSwitchValue(token) === true;
    }
  }
  return whatIf;
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
    const name = resolvePowerShellCommonOptionName(token);
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

/** Return true when a selected OpenClaw process or service is mutated through an object method. */
export function powerShellDirectObjectMutationRequiresApproval(
  command: string,
  argv: readonly string[],
): boolean {
  if (!(argv[0] ?? "").trim().startsWith("(")) {
    return false;
  }
  return [...command.matchAll(POWERSHELL_DIRECT_OBJECT_MUTATION_RE)].some((match) => {
    const selection = splitShellArgs(match[1] ?? "");
    if (!selection) {
      return false;
    }
    const source = normalizeExecutableToken(selection[0] ?? "");
    const selectsNode =
      ["get-process", "gps", "ps"].includes(source) &&
      selection
        .slice(1)
        .some((token) => ["node", "nodejs"].includes(normalizeExecutableToken(token)));
    return selectsNode || isPowerShellSelection(selection, true);
  });
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
  const hasCompoundPredicate = argv.some((token) =>
    ["&&", "-and", "-or", "-xor", "||"].includes(token.toLowerCase()),
  );
  if (hasCompoundPredicate) {
    return true;
  }
  const negativeIndex = argv.findIndex((token) =>
    ["-ne", "-notcontains", "-notin", "-notlike", "-notmatch"].includes(token.trim().toLowerCase()),
  );
  if (negativeIndex === -1) {
    return isPowerShellOpenClawFilter(argv, allowUnresolved);
  }
  const operands = argv.slice(negativeIndex + 1);
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
  if (powerShellArgvUsesWhatIf(argv)) {
    return false;
  }
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
  const executable = normalizeExecutableToken(argv[0] ?? "");
  const aliasCmdlet = POWERSHELL_ALIAS_SETTERS.has(executable);
  const providerCmdlet = POWERSHELL_ALIAS_PROVIDER_SETTERS.has(executable);
  if (!aliasCmdlet && !providerCmdlet) {
    return null;
  }
  let name: string | undefined;
  let path: string | undefined;
  let value: string | undefined;
  const positionals: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const option = optionName(token);
    const commonOption = resolvePowerShellCommonOptionName(token);
    if (["-n", "-name"].includes(option)) {
      name = inlineOptionValue(token) ?? argv[++index];
    } else if (["-literalpath", "-path"].includes(option)) {
      path = inlineOptionValue(token) ?? argv[++index];
    } else if (["-v", "-value"].includes(option)) {
      value = inlineOptionValue(token) ?? argv[++index];
    } else if (POWERSHELL_ALIAS_OPTIONS_WITH_VALUE.has(option)) {
      if (inlineOptionValue(token) === undefined) {
        index += 1;
      }
    } else if (POWERSHELL_COMMON_OPTIONS_WITH_VALUE.has(commonOption)) {
      if (inlineOptionValue(token) === undefined) {
        index += 1;
      }
    } else if (!token.startsWith("-")) {
      positionals.push(token);
    }
  }
  if (aliasCmdlet) {
    name ??= positionals[0];
    value ??= positionals[1];
  } else {
    const pathIsPositional = path === undefined;
    path ??= positionals[0];
    value ??= positionals[pathIsPositional ? 1 : 0];
    const providerPath = (path ?? "").trim().replace(/["']/gu, "");
    const providerMatch = /^alias:(?:[/\\])?(.*)$/iu.exec(providerPath);
    if (!providerMatch) {
      return null;
    }
    name = providerMatch[1] || name;
  }
  return { name, value };
}

function unwrapPowerShellInvocationArgv(argv: readonly string[]): readonly string[] {
  let invocation = argv;
  for (let depth = 0; depth < 8; depth += 1) {
    const unwrapped = unwrapLifecycleControlArgv(invocation, "powershell");
    if (unwrapped === null) {
      return invocation;
    }
    invocation = unwrapped;
  }
  return [];
}

function isDynamicPowerShellAliasReference(value: string | undefined): boolean {
  const normalized = (value ?? "").trim();
  return /^[$@([\]{}]/u.test(normalized) || normalized.includes("$(");
}

function resolvePowerShellAliasTarget(
  aliasName: string,
  aliasTargets: ReadonlyMap<string, string>,
): string | null {
  let target = aliasTargets.get(aliasName);
  const seen = new Set([aliasName]);
  while (target) {
    const normalized = normalizeExecutableToken(target);
    if (!aliasTargets.has(normalized)) {
      return target;
    }
    if (seen.has(normalized)) {
      return null;
    }
    seen.add(normalized);
    target = aliasTargets.get(normalized);
  }
  return null;
}

function classifyPowerShellAliasedInvocation(argv: readonly string[], depth = 0): boolean {
  if (argv.length === 0 || depth >= 8) {
    return false;
  }
  if (isOpenClawExecutablePattern(argv[0])) {
    return classifyOpenClawArgv(["openclaw", ...argv.slice(1)]);
  }
  const startProcessArgv = resolvePowerShellStartProcessOpenClawArgv(argv);
  if (startProcessArgv) {
    return classifyOpenClawArgv(startProcessArgv);
  }
  const runner = resolveLifecyclePackageRunnerArgv(argv);
  if (runner.kind === "approval-required") {
    return true;
  }
  if (runner.kind === "argv") {
    return classifyPowerShellAliasedInvocation(runner.argv, depth + 1);
  }
  const carried = resolveCarrierCommandArgv([...argv], depth, { includeExec: true });
  return carried?.length ? classifyPowerShellAliasedInvocation(carried, depth + 1) : false;
}

function isExecutablePowerShellScriptBlockStart(command: string, blockStart: number): boolean {
  const prefix = command.slice(0, blockStart).trimEnd();
  if (/(?:^|\s)[&.]\s*$/u.test(prefix)) {
    return true;
  }
  const option = /(?:^|\s)(-[A-Za-z][A-Za-z-]*)(?:\s*[:=])?\s*$/u.exec(prefix)?.[1];
  if (!option) {
    return false;
  }
  const normalized = optionName(option);
  return (
    [...POWERSHELL_EXECUTABLE_SCRIPT_BLOCK_OPTIONS].filter((candidate) =>
      candidate.startsWith(normalized),
    ).length === 1
  );
}

function extractPowerShellPipelineScriptBlocks(command: string): string[] {
  const hasPipeline = splitLifecycleCommandText(command, new Set(["|"]), "powershell").length >= 2;
  const blocks: string[] = [];
  let blockStart = -1;
  let executableBlock = false;
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
        executableBlock = hasPipeline || isExecutablePowerShellScriptBlockStart(command, index);
      }
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && blockStart !== -1) {
        if (executableBlock) {
          blocks.push(command.slice(blockStart, index));
        }
        blockStart = -1;
        executableBlock = false;
      }
    }
  }
  return blocks;
}

/** Recursively classify executable fragments embedded in PowerShell pipeline script blocks. */
function powerShellPipelineScriptBlocksRequireApproval(
  command: string,
  classify: (argv: string[], raw: string) => boolean,
): boolean {
  return extractPowerShellPipelineScriptBlocks(command).some(
    (scriptBlock) =>
      powerShellAliasLifecycleInvocationRequiresApproval(scriptBlock, undefined, classify) ||
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
  classifyInvocation?: (argv: string[], raw: string) => boolean,
): boolean {
  const aliasTargets = new Map<string, string>();
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
    const rawInvocation = unwrapPowerShellInvocationArgv(parsed);
    const expandedResult = expandArgv?.(parsed) ?? { argv: parsed, unresolved: false };
    const expanded = {
      ...expandedResult,
      argv: unwrapPowerShellInvocationArgv(expandedResult.argv),
    };
    const rawAlias = parsePowerShellAlias(rawInvocation);
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
      aliasTargets.delete(aliasName);
      unresolvedAliases.delete(aliasName);
      if (
        expanded.unresolved ||
        (isDynamicPowerShellAliasReference(rawAlias.value) &&
          (!resolvedAlias?.value || isDynamicPowerShellAliasReference(resolvedAlias.value)))
      ) {
        unresolvedAliases.add(aliasName);
      } else if (aliasValue) {
        aliasTargets.set(aliasName, aliasValue);
      }
      continue;
    }
    const invocation = rawInvocation;
    const aliasName = normalizeExecutableToken(invocation[0] ?? "");
    const lifecycleInvocation = classifyOpenClawArgv(["openclaw", ...invocation.slice(1)]);
    const aliasTarget = resolvePowerShellAliasTarget(aliasName, aliasTargets);
    const resolvedInvocation = aliasTarget ? [aliasTarget, ...invocation.slice(1)] : null;
    if (
      (resolvedInvocation &&
        (classifyInvocation
          ? classifyInvocation(resolvedInvocation, resolvedInvocation.join(" "))
          : classifyPowerShellAliasedInvocation(resolvedInvocation))) ||
      (lifecycleInvocation && (unresolvedAliases.has(aliasName) || unresolvedAliasName))
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
    const commonOption = resolvePowerShellCommonOptionName(token);
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
    if (POWERSHELL_COMMON_OPTIONS_WITH_VALUE.has(commonOption)) {
      if (inlineOptionValue(token) === undefined) {
        index += 1;
      }
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
    (isUnresolved(parsed.filePath) && classifyOpenClawArgv(["openclaw", ...parsed.argumentList])) ||
    (isOpenClawExecutablePattern(parsed.filePath) && parsed.argumentList.some(isUnresolved))
  );
}
