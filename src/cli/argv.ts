// Low-level CLI argv helpers for root options, help/version detection, and command paths.
import { isExperimentalClawsEnabled } from "../claws/experimental.js";
import { isBunRuntime, isNodeRuntime } from "../daemon/runtime-binary.js";
import {
  consumeRootOptionToken,
  FLAG_TERMINATOR,
  isValueToken,
} from "../infra/cli-root-options.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { CORE_CLI_COMMAND_DESCRIPTORS } from "./program/core-command-descriptors.js";
import { SUB_CLI_DESCRIPTORS } from "./program/subcli-descriptors.js";

const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);
const ROOT_VERSION_ALIAS_FLAG = "-v";
const ROOT_COMMAND_DESCRIPTORS = [
  ...CORE_CLI_COMMAND_DESCRIPTORS.filter(
    (descriptor) => descriptor.name !== "claws" || isExperimentalClawsEnabled(),
  ),
  ...SUB_CLI_DESCRIPTORS,
];
const KNOWN_ROOT_COMMANDS: ReadonlySet<string> = new Set(
  ROOT_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name),
);
const ROOT_COMMANDS_WITH_SUBCOMMANDS: ReadonlySet<string> = new Set(
  ROOT_COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.hasSubcommands).map(
    (descriptor) => descriptor.name,
  ),
);

export function isHelpOrVersionInvocation(argv: string[]): boolean {
  if (hasRootVersionAlias(argv)) {
    return true;
  }

  const args = argv.slice(2);
  let sawCommandOption = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    const rootConsumed = consumeRootOptionToken(args, i);
    if (rootConsumed > 0) {
      i += rootConsumed - 1;
      continue;
    }
    if (HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg)) {
      return true;
    }
    if (arg.startsWith("-")) {
      sawCommandOption = true;
      continue;
    }
    positionals.push(arg);
    if (arg !== "help") {
      continue;
    }
    if (sawCommandOption) {
      return false;
    }
    if (positionals.length === 1) {
      return true;
    }
    const [primary] = positionals;
    // Positional `help` may be a command argument for known leaf commands.
    // Unknown roots stay help-compatible because plugins may register namespaces later.
    if (!primary || !KNOWN_ROOT_COMMANDS.has(primary)) {
      return true;
    }
    if (positionals.length === 2 && ROOT_COMMANDS_WITH_SUBCOMMANDS.has(primary)) {
      return true;
    }
    return false;
  }
  return false;
}

function parsePositiveInt(value: string): number | undefined {
  return parseStrictPositiveInteger(value);
}

export function hasFlag(argv: string[], name: string): boolean {
  const args = argv.slice(2);
  for (const arg of args) {
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === name) {
      return true;
    }
  }
  return false;
}

export function hasRootVersionAlias(argv: string[]): boolean {
  const args = argv.slice(2);
  let hasAlias = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === ROOT_VERSION_ALIAS_FLAG) {
      hasAlias = true;
      continue;
    }
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return false;
    }
    return false;
  }
  return hasAlias;
}

export function isRootVersionInvocation(argv: string[]): boolean {
  return isRootInvocationForFlags(argv, VERSION_FLAGS, { includeVersionAlias: true });
}

function isRootInvocationForFlags(
  argv: string[],
  targetFlags: Set<string>,
  options?: { includeVersionAlias?: boolean },
): boolean {
  const args = argv.slice(2);
  let hasTarget = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (
      targetFlags.has(arg) ||
      (options?.includeVersionAlias === true && arg === ROOT_VERSION_ALIAS_FLAG)
    ) {
      hasTarget = true;
      continue;
    }
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    // Unknown flags and subcommand-scoped help/version should fall back to Commander.
    return false;
  }
  return hasTarget;
}

export function isRootHelpInvocation(argv: string[]): boolean {
  return isRootInvocationForFlags(argv, HELP_FLAGS);
}

type HelpNormalizationPositional = { value: string; index: number };

type HelpNormalizationScanResult =
  | {
      ok: true;
      positionals: HelpNormalizationPositional[];
      rootOptions: string[];
      helpFlagIndex: number | null;
    }
  | { ok: false };

function scanHelpNormalizationArgv(argv: string[]): HelpNormalizationScanResult {
  const positionals: HelpNormalizationPositional[] = [];
  const rootOptions: string[] = [];
  let helpFlagIndex: number | null = null;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    const consumed = consumeRootOptionToken(argv, index);
    if (consumed > 0) {
      rootOptions.push(...argv.slice(index, index + consumed));
      index += consumed - 1;
      continue;
    }
    if (HELP_FLAGS.has(arg)) {
      helpFlagIndex = index;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false };
    }
    positionals.push({ value: arg, index });
  }

  return { ok: true, positionals, rootOptions, helpFlagIndex };
}

export function normalizeGeneratedHelpCommandArgv(argv: string[]): string[] {
  const scan = scanHelpNormalizationArgv(argv);
  if (!scan.ok) {
    return argv;
  }
  const { positionals, rootOptions, helpFlagIndex } = scan;
  const [primary, secondary, target] = positionals;
  if (
    !primary ||
    secondary?.value !== "help" ||
    (KNOWN_ROOT_COMMANDS.has(primary.value) && !ROOT_COMMANDS_WITH_SUBCOMMANDS.has(primary.value))
  ) {
    return argv;
  }

  if (positionals.length === 2 && helpFlagIndex === secondary.index + 1) {
    return argv.toSpliced(helpFlagIndex, 1);
  }

  if (
    !target ||
    positionals.length !== 3 ||
    (helpFlagIndex !== null && helpFlagIndex !== target.index + 1)
  ) {
    return argv;
  }
  const [runtimePath, entryPath] = argv;
  if (runtimePath === undefined || entryPath === undefined) {
    return argv;
  }

  return [runtimePath, entryPath, ...rootOptions, primary.value, target.value, "--help"];
}

export function normalizeRootHelpTargetArgv(argv: string[]): string[] {
  const scan = scanHelpNormalizationArgv(argv);
  if (!scan.ok) {
    return argv;
  }
  const { positionals, rootOptions, helpFlagIndex } = scan;

  const [help, target] = positionals;
  // The --help flag must trail the LAST positional so nested targets like
  // `help plugins list --help` still normalize (target is only the first one).
  const lastPositional = positionals.at(-1);
  if (
    help?.value !== "help" ||
    !target ||
    !lastPositional ||
    (helpFlagIndex !== null && helpFlagIndex !== lastPositional.index + 1)
  ) {
    return argv;
  }
  const [runtimePath, entryPath] = argv;
  if (runtimePath === undefined || entryPath === undefined) {
    return argv;
  }

  const targetPath = positionals.slice(1).map((positional) => positional.value);
  return [runtimePath, entryPath, ...rootOptions, ...targetPath, "--help"];
}

type NormalizeRootNoColorArgvOptions = {
  shouldPreserveNoColor?: (params: {
    remainingArgs: readonly string[];
    noColorIndex: number;
  }) => boolean;
};

type NormalizeRootLogLevelArgvOptions = {
  shouldPreserveLogLevel?: (params: {
    remainingArgs: readonly string[];
    logLevelIndex: number;
    consumed: number;
  }) => boolean;
};

function isPossibleCommandOptionValue(
  remainingArgs: readonly string[],
  optionIndex: number,
): boolean {
  const previous = remainingArgs[optionIndex - 1];
  if (!previous?.startsWith("-") || previous === FLAG_TERMINATOR) {
    return false;
  }
  return !previous.includes("=");
}

function consumeRootLogLevelToken(args: readonly string[], index: number): number {
  const arg = args[index];
  if (!arg || arg === FLAG_TERMINATOR) {
    return 0;
  }
  if (arg.startsWith("--log-level=")) {
    return arg.slice("--log-level=".length).trim() ? 1 : 0;
  }
  if (arg === "--log-level") {
    return isValueToken(args[index + 1]) ? 2 : 0;
  }
  return 0;
}

function splitRootOptionPrefix(argv: string[]): {
  prefix: string[];
  rootPrefix: string[];
  remainingArgs: string[];
} {
  const prefix = argv.slice(0, 2);
  const args = argv.slice(2);
  let rootPrefixEnd = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    const consumed = consumeRootOptionToken(args, index);
    if (consumed <= 0) {
      break;
    }
    rootPrefixEnd = index + consumed;
    index += consumed - 1;
  }
  return {
    prefix,
    rootPrefix: args.slice(0, rootPrefixEnd),
    remainingArgs: args.slice(rootPrefixEnd),
  };
}

export function normalizeRootNoColorArgv(
  argv: string[],
  options: NormalizeRootNoColorArgvOptions = {},
): string[] {
  const { prefix, rootPrefix, remainingArgs } = splitRootOptionPrefix(argv);
  const movedNoColorArgs: string[] = [];
  const nextArgs: string[] = [];
  for (let index = 0; index < remainingArgs.length; index += 1) {
    const arg = remainingArgs.at(index);
    if (arg === undefined) {
      break;
    }
    if (arg === FLAG_TERMINATOR) {
      nextArgs.push(...remainingArgs.slice(index));
      break;
    }
    if (arg === "--no-color") {
      // Commander can treat dash-prefixed tokens as command option values.
      // Early callers stay conservative; final Commander parse can pass metadata.
      const shouldPreserve =
        options.shouldPreserveNoColor?.({ remainingArgs, noColorIndex: index }) ??
        isPossibleCommandOptionValue(remainingArgs, index);
      if (shouldPreserve) {
        nextArgs.push(arg);
        continue;
      }
      movedNoColorArgs.push(arg);
      continue;
    }
    nextArgs.push(arg);
  }

  if (movedNoColorArgs.length === 0) {
    return argv;
  }
  return [...prefix, ...rootPrefix, ...movedNoColorArgs, ...nextArgs];
}

export function normalizeRootLogLevelArgv(
  argv: string[],
  options: NormalizeRootLogLevelArgvOptions = {},
): string[] {
  const { prefix, rootPrefix, remainingArgs } = splitRootOptionPrefix(argv);
  const movedLogLevelArgs: string[] = [];
  const nextArgs: string[] = [];
  for (let index = 0; index < remainingArgs.length; index += 1) {
    const arg = remainingArgs.at(index);
    if (arg === undefined) {
      break;
    }
    if (arg === FLAG_TERMINATOR) {
      nextArgs.push(...remainingArgs.slice(index));
      break;
    }
    const consumed = consumeRootLogLevelToken(remainingArgs, index);
    if (consumed > 0) {
      const shouldPreserve =
        options.shouldPreserveLogLevel?.({
          remainingArgs,
          logLevelIndex: index,
          consumed,
        }) ?? isPossibleCommandOptionValue(remainingArgs, index);
      const tokens = remainingArgs.slice(index, index + consumed);
      if (shouldPreserve) {
        nextArgs.push(...tokens);
      } else {
        movedLogLevelArgs.push(...tokens);
      }
      index += consumed - 1;
      continue;
    }
    nextArgs.push(arg);
  }

  if (movedLogLevelArgs.length === 0) {
    return argv;
  }
  return [...prefix, ...rootPrefix, ...movedLogLevelArgs, ...nextArgs];
}

export function getFlagValue(argv: string[], name: string): string | null | undefined {
  const args = argv.slice(2);
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args.at(i);
    if (arg === undefined) {
      break;
    }
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === name) {
      const next = args[i + 1];
      if (!isValueToken(next)) {
        return null;
      }
      value = next;
      i += 1;
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      const assigned = arg.slice(name.length + 1);
      if (!assigned) {
        return null;
      }
      value = assigned;
    }
  }
  return value;
}

export function getVerboseFlag(argv: string[], options?: { includeDebug?: boolean }): boolean {
  if (hasFlag(argv, "--verbose")) {
    return true;
  }
  if (options?.includeDebug && hasFlag(argv, "--debug")) {
    return true;
  }
  return false;
}

export function getPositiveIntFlagValue(argv: string[], name: string): number | null | undefined {
  const raw = getFlagValue(argv, name);
  if (raw === null || raw === undefined) {
    return raw;
  }
  // Keep absent distinct from present-but-invalid so route-first callers can
  // defer invalid input to Commander instead of silently applying defaults.
  return parsePositiveInt(raw) ?? null;
}

export function getCommandPathWithRootOptions(argv: string[], depth = 2): string[] {
  return getCommandPathInternal(argv, depth, { skipRootOptions: true });
}

function getCommandPathInternal(
  argv: string[],
  depth: number,
  opts: { skipRootOptions: boolean },
): string[] {
  const args = argv.slice(2);
  const path: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (opts.skipRootOptions) {
      const consumed = consumeRootOptionToken(args, i);
      if (consumed > 0) {
        i += consumed - 1;
        continue;
      }
    }
    if (arg.startsWith("-")) {
      continue;
    }
    path.push(arg);
    if (path.length >= depth) {
      break;
    }
  }
  return path;
}

export function getPrimaryCommand(argv: string[]): string | null {
  const [primary] = getCommandPathWithRootOptions(argv, 1);
  return primary ?? null;
}

type CommandPositionalsParseOptions = {
  commandPath: ReadonlyArray<string>;
  booleanFlags?: ReadonlyArray<string>;
  valueFlags?: ReadonlyArray<string>;
};

function consumeKnownOptionToken(
  args: ReadonlyArray<string>,
  index: number,
  booleanFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): number {
  const arg = args[index];
  if (!arg || arg === FLAG_TERMINATOR || !arg.startsWith("-")) {
    return 0;
  }

  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);

  if (booleanFlags.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }

  if (!valueFlags.has(flag)) {
    return 0;
  }

  if (equalsIndex !== -1) {
    const value = arg.slice(equalsIndex + 1).trim();
    return value ? 1 : 0;
  }

  return isValueToken(args[index + 1]) ? 2 : 0;
}

export function getCommandPositionalsWithRootOptions(
  argv: string[],
  options: CommandPositionalsParseOptions,
): string[] | null {
  const args = argv.slice(2);
  const commandPath = options.commandPath;
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const valueFlags = new Set(options.valueFlags ?? []);
  const positionals: string[] = [];
  let commandIndex = 0;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }

    const rootConsumed = consumeRootOptionToken(args, i);
    if (rootConsumed > 0) {
      i += rootConsumed - 1;
      continue;
    }

    if (arg.startsWith("-")) {
      const optionConsumed = consumeKnownOptionToken(args, i, booleanFlags, valueFlags);
      if (optionConsumed === 0) {
        return null;
      }
      i += optionConsumed - 1;
      continue;
    }

    if (commandIndex < commandPath.length) {
      if (arg !== commandPath[commandIndex]) {
        return null;
      }
      commandIndex += 1;
      continue;
    }

    positionals.push(arg);
  }

  if (commandIndex < commandPath.length) {
    return null;
  }
  return positionals;
}

export function buildParseArgv(rawArgs: string[], programName = "openclaw"): string[] {
  const normalizedArgv =
    rawArgs[0] === programName
      ? rawArgs.slice(1)
      : rawArgs[0]?.endsWith("openclaw")
        ? rawArgs.slice(1)
        : rawArgs;
  const looksLikeNode =
    normalizedArgv.length >= 2 &&
    (isNodeRuntime(normalizedArgv[0] ?? "") || isBunRuntime(normalizedArgv[0] ?? ""));
  if (looksLikeNode) {
    return normalizedArgv;
  }
  return ["node", programName, ...normalizedArgv];
}

export function shouldMigrateStateFromPath(path: string[]): boolean {
  if (path.length === 0) {
    return true;
  }
  const [primary, secondary] = path;
  if (primary === "health" || primary === "sessions") {
    return false;
  }
  if (primary === "update" && secondary === "status") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  return true;
}
