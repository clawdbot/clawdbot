import { splitShellArgs } from "../utils/shell-argv.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

export const COMMAND_CARRIER_EXECUTABLES = new Set(["sudo", "doas", "env", "command", "builtin"]);

export const SOURCE_EXECUTABLES = new Set([".", "source"]);

const MAX_ENV_SPLIT_PAYLOAD_DEPTH = 32;

const COMMAND_EXECUTING_OPTIONS = new Set(["-p"]);
const COMMAND_QUERY_OPTIONS = new Set(["-v", "-V"]);
const ENV_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-P",
  "-S",
  "-s",
  "-u",
  "--argv0",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);
const ENV_SPLIT_STRING_OPTIONS = new Set(["-S", "-s", "--split-string"]);
const ENV_STANDALONE_OPTIONS = new Set(["-0", "-i", "--ignore-environment", "--null"]);
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-D",
  "-g",
  "-h",
  "-p",
  "-R",
  "-T",
  "-U",
  "-u",
  "--chdir",
  "--chroot",
  "--close-from",
  "--command-timeout",
  "--group",
  "--host",
  "--other-user",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);
const SUDO_STANDALONE_OPTIONS = new Set([
  "-A",
  "-B",
  "-b",
  "-E",
  "-H",
  "-i",
  "-k",
  "-N",
  "-n",
  "-P",
  "-S",
  "-s",
  "--askpass",
  "--background",
  "--bell",
  "--login",
  "--no-update",
  "--non-interactive",
  "--preserve-env",
  "--preserve-groups",
  "--reset-home",
  "--reset-timestamp",
  "--set-home",
  "--shell",
  "--stdin",
]);
const SUDO_NON_EXEC_OPTIONS = new Set([
  "-K",
  "-l",
  "-V",
  "-v",
  "-e",
  "--edit",
  "--help",
  "--list",
  "--remove-timestamp",
  "--validate",
  "--version",
]);
const DOAS_OPTIONS_WITH_VALUE = new Set(["-a", "-C", "-u"]);
const DOAS_STANDALONE_OPTIONS = new Set(["-L", "-n", "-s"]);
const EXEC_OPTIONS_WITH_VALUE = new Set(["-a"]);
const EXEC_STANDALONE_OPTIONS = new Set(["-c", "-l"]);

export function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
}

function optionName(token: string): string {
  return token.split("=", 1)[0] ?? token;
}

type ParsedCarrierOption = {
  name: string;
  hasInlineValue: boolean;
  inlineValue?: string;
};

function parseCarrierOptionToken(
  token: string,
  standaloneOptions: ReadonlySet<string>,
  optionsWithValue: ReadonlySet<string>,
  nonExecutingOptions: ReadonlySet<string> = new Set(),
): ParsedCarrierOption[] | null {
  if (token.startsWith("--")) {
    const name = optionName(token);
    if (
      standaloneOptions.has(name) ||
      optionsWithValue.has(name) ||
      nonExecutingOptions.has(name)
    ) {
      const valueDelimiter = token.indexOf("=");
      return [
        {
          name,
          hasInlineValue: valueDelimiter >= 0,
          inlineValue: valueDelimiter >= 0 ? token.slice(valueDelimiter + 1) : undefined,
        },
      ];
    }
    return null;
  }

  if (!/^-[A-Za-z0-9]/u.test(token)) {
    return null;
  }

  const options: ParsedCarrierOption[] = [];
  for (let index = 1; index < token.length; index += 1) {
    const name = `-${token[index] ?? ""}`;
    if (optionsWithValue.has(name)) {
      options.push({
        name,
        hasInlineValue: index < token.length - 1,
        inlineValue: index < token.length - 1 ? token.slice(index + 1) : undefined,
      });
      return options;
    }
    if (standaloneOptions.has(name) || nonExecutingOptions.has(name)) {
      options.push({ name, hasInlineValue: false });
      continue;
    }
    return null;
  }
  return options.length > 0 ? options : null;
}

function knownCarrierOptionConsumesNextValue(
  options: readonly ParsedCarrierOption[],
  optionsWithValue: ReadonlySet<string>,
  nonExecutingOptions: ReadonlySet<string> = new Set(),
): boolean | null {
  let consumesNextValue = false;
  for (const option of options) {
    if (nonExecutingOptions.has(option.name)) {
      return null;
    }
    if (optionsWithValue.has(option.name)) {
      consumesNextValue = !option.hasInlineValue;
    }
  }
  return consumesNextValue;
}

function stripSudoEnvAssignmentsFromCommandArgv(
  executable: string,
  argv: string[],
): string[] | null {
  if (executable !== "sudo") {
    return argv.length > 0 ? argv : null;
  }
  let index = 0;
  while (index < argv.length && isEnvAssignmentToken(argv[index] ?? "")) {
    index += 1;
  }
  return index < argv.length ? argv.slice(index) : null;
}

function findParsedCarrierOption(
  options: readonly ParsedCarrierOption[],
  names: ReadonlySet<string>,
): ParsedCarrierOption | undefined {
  return options.find((option) => names.has(option.name));
}

function resolveEnvSplitPayload(
  payload: string,
  trailingArgv: string[],
  depth: number,
): string[] | null {
  const innerArgv = splitShellArgs(payload);
  if (!innerArgv || innerArgv.length === 0) {
    return null;
  }
  const carriedArgv = [...innerArgv, ...trailingArgv];
  return resolveEnvCarriedArgv(["env", ...carriedArgv], depth + 1) ?? carriedArgv;
}

export type ParsedEnvInvocationPrelude = {
  assignmentKeys: string[];
  commandIndex: number;
  splitArgv?: string[];
  usesModifiers: boolean;
};

export function parseEnvInvocationPrelude(
  argv: string[],
  depth = 0,
): ParsedEnvInvocationPrelude | null {
  if (depth > MAX_ENV_SPLIT_PAYLOAD_DEPTH || normalizeExecutableToken(argv[0] ?? "") !== "env") {
    return null;
  }
  let usesModifiers = false;
  const assignmentKeys: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token) {
      return null;
    }
    if (isEnvAssignmentToken(token)) {
      usesModifiers = true;
      const delimiter = token.indexOf("=");
      if (delimiter > 0) {
        assignmentKeys.push(token.slice(0, delimiter));
      }
      continue;
    }
    if (token === "--" || token === "-") {
      return index + 1 < argv.length
        ? { assignmentKeys, commandIndex: index + 1, usesModifiers }
        : null;
    }
    if (token.startsWith("-")) {
      const option = parseCarrierOptionToken(token, ENV_STANDALONE_OPTIONS, ENV_OPTIONS_WITH_VALUE);
      if (!option) {
        return null;
      }
      usesModifiers = true;
      const splitStringOption = findParsedCarrierOption(option, ENV_SPLIT_STRING_OPTIONS);
      if (splitStringOption) {
        const payloadIndex = splitStringOption.inlineValue === undefined ? index + 1 : index;
        const payload = splitStringOption.inlineValue ?? argv[payloadIndex];
        const trailingIndex = payloadIndex + 1;
        const splitArgv =
          typeof payload === "string"
            ? resolveEnvSplitPayload(payload, argv.slice(trailingIndex), depth)
            : null;
        return splitArgv
          ? {
              assignmentKeys,
              commandIndex: trailingIndex,
              splitArgv,
              usesModifiers,
            }
          : null;
      }
      const consumeNextValue = knownCarrierOptionConsumesNextValue(option, ENV_OPTIONS_WITH_VALUE);
      if (consumeNextValue) {
        index += 1;
      }
      continue;
    }
    return { assignmentKeys, commandIndex: index, usesModifiers };
  }
  return null;
}

export function envInvocationUsesModifiers(argv: string[]): boolean {
  const parsed = parseEnvInvocationPrelude(argv);
  return parsed?.usesModifiers ?? normalizeExecutableToken(argv[0] ?? "") === "env";
}

export function unwrapEnvInvocation(argv: string[]): string[] | null {
  const parsed = parseEnvInvocationPrelude(argv);
  return parsed ? (parsed.splitArgv ?? argv.slice(parsed.commandIndex)) : null;
}

export function resolveEnvCarriedArgv(argv: string[], depth = 0): string[] | null {
  const parsed = parseEnvInvocationPrelude(argv, depth);
  return parsed ? (parsed.splitArgv ?? argv.slice(parsed.commandIndex)) : null;
}

function resolveCommandBuiltinCarriedArgv(argv: string[]): string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable !== "command" && executable !== "builtin") {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return argv.slice(index + 1);
    }
    if (!token.startsWith("-")) {
      return argv.slice(index);
    }
    const normalized = optionName(token);
    if (COMMAND_QUERY_OPTIONS.has(normalized)) {
      return null;
    }
    if (!COMMAND_EXECUTING_OPTIONS.has(normalized)) {
      return null;
    }
  }
  return null;
}

function resolveSudoLikeCarriedArgv(argv: string[]): string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  const standaloneOptions =
    executable === "sudo"
      ? SUDO_STANDALONE_OPTIONS
      : executable === "doas"
        ? DOAS_STANDALONE_OPTIONS
        : null;
  const optionsWithValue =
    executable === "sudo"
      ? SUDO_OPTIONS_WITH_VALUE
      : executable === "doas"
        ? DOAS_OPTIONS_WITH_VALUE
        : null;
  if (!standaloneOptions || !optionsWithValue) {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return stripSudoEnvAssignmentsFromCommandArgv(executable, argv.slice(index + 1));
    }
    if (!token.startsWith("-")) {
      return stripSudoEnvAssignmentsFromCommandArgv(executable, argv.slice(index));
    }
    const option = parseCarrierOptionToken(
      token,
      standaloneOptions,
      optionsWithValue,
      executable === "sudo" ? SUDO_NON_EXEC_OPTIONS : undefined,
    );
    if (!option) {
      return null;
    }
    const consumeNextValue = knownCarrierOptionConsumesNextValue(
      option,
      optionsWithValue,
      executable === "sudo" ? SUDO_NON_EXEC_OPTIONS : undefined,
    );
    if (consumeNextValue === null) {
      return null;
    }
    if (consumeNextValue) {
      index += 1;
    }
  }
  return null;
}

function resolveExecCarriedArgv(argv: string[]): string[] | null {
  if (normalizeExecutableToken(argv[0] ?? "") !== "exec") {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return argv.slice(index + 1);
    }
    if (!token.startsWith("-")) {
      return argv.slice(index);
    }
    const option = parseCarrierOptionToken(token, EXEC_STANDALONE_OPTIONS, EXEC_OPTIONS_WITH_VALUE);
    if (!option) {
      return null;
    }
    const consumeNextValue = knownCarrierOptionConsumesNextValue(option, EXEC_OPTIONS_WITH_VALUE);
    if (consumeNextValue) {
      index += 1;
    }
  }
  return null;
}

export function resolveCarrierCommandArgv(
  argv: string[],
  depth = 0,
  options?: { includeExec?: boolean },
): string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  switch (executable) {
    case "env":
      return resolveEnvCarriedArgv(argv, depth);
    case "command":
    case "builtin":
      return resolveCommandBuiltinCarriedArgv(argv);
    case "sudo":
    case "doas":
      return resolveSudoLikeCarriedArgv(argv);
    case "exec":
      return options?.includeExec ? resolveExecCarriedArgv(argv) : null;
    default:
      return null;
  }
}
