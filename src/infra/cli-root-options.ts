/** CLI token that stops root option scanning and leaves following args positional. */
export const FLAG_TERMINATOR = "--";

const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level", "--container"]);

/** Returns whether a token can be consumed as a root option value. */
export function isValueToken(arg: string | undefined): boolean {
  if (!arg || arg === FLAG_TERMINATOR) {
    return false;
  }
  if (!arg.startsWith("-")) {
    return true;
  }
  return /^-\d+(?:\.\d+)?$/.test(arg);
}

/** Count root-option tokens conservatively for route matching. */
export function consumeRootOptionToken(args: ReadonlyArray<string>, index: number): number {
  const arg = args[index];
  if (!arg) {
    return 0;
  }
  if (ROOT_BOOLEAN_FLAGS.has(arg)) {
    return 1;
  }
  if (
    arg.startsWith("--profile=") ||
    arg.startsWith("--log-level=") ||
    arg.startsWith("--container=")
  ) {
    return 1;
  }
  if (ROOT_VALUE_FLAGS.has(arg)) {
    return isValueToken(args[index + 1]) ? 2 : 1;
  }
  return 0;
}

/** Consume required root values by their Commander role before startup policy is selected. */
export function consumeRootCommandOptionToken(args: readonly string[], index: number): number {
  return consumeKnownOptionToken(args, index, ROOT_BOOLEAN_FLAGS, ROOT_VALUE_FLAGS, "command-path");
}

/** Read positional command tokens while accepting root options at any pre-terminator position. */
export function getRootOptionAwareCommandPath(argv: readonly string[], depth: number): string[] {
  const args = argv.slice(2);
  const path: string[] = [];
  let literal = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      break;
    }
    if (!literal && arg === FLAG_TERMINATOR) {
      // A leading terminator still leaves a command to discover; later operands belong to callers.
      if (path.length > 0) {
        break;
      }
      literal = true;
      continue;
    }
    const consumed = literal ? 0 : consumeRootCommandOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (!literal && arg.startsWith("-")) {
      continue;
    }
    path.push(arg);
    if (path.length >= depth) {
      break;
    }
  }
  return path;
}

type CommandPositionalsParseOptions = {
  commandPath: ReadonlyArray<string>;
  booleanFlags?: ReadonlyArray<string>;
  valueFlags?: ReadonlyArray<string>;
  maxPositionals?: number;
  mode?: "route" | "command-path";
};

function consumeKnownOptionToken(
  args: ReadonlyArray<string>,
  index: number,
  booleanFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
  mode: CommandPositionalsParseOptions["mode"],
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
    return mode === "command-path" || arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  // Required Commander values include empty strings, flag-looking tokens, and `--`.
  // Discovery must consume them before choosing startup policy; routes still validate values.
  if (mode === "command-path") {
    return args[index + 1] !== undefined ? 2 : 0;
  }
  return isValueToken(args[index + 1]) ? 2 : 0;
}

/** Parse command positionals while consuming known root and command options. */
export function getCommandPositionalsWithRootOptions(
  argv: readonly string[],
  options: CommandPositionalsParseOptions,
): string[] | null {
  return parseCommandArgsWithRootOptions(argv, options, false);
}

/** Preserve the leaf's raw arguments after consuming its root and parent options. */
export function getCommandArgsWithRootOptions(
  argv: readonly string[],
  options: Omit<CommandPositionalsParseOptions, "maxPositionals">,
): string[] | null {
  return parseCommandArgsWithRootOptions(argv, options, true);
}

function parseCommandArgsWithRootOptions(
  argv: readonly string[],
  options: CommandPositionalsParseOptions,
  returnTail: boolean,
): string[] | null {
  const args = argv.slice(2);
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const valueFlags = new Set(options.valueFlags ?? []);
  const positionals: string[] = [];
  let commandIndex = 0;
  let literal = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || (!arg && options.mode !== "command-path")) {
      break;
    }
    if (!literal && arg === FLAG_TERMINATOR) {
      if (options.mode !== "command-path") {
        break;
      }
      literal = true;
      continue;
    }
    const rootConsumed = literal
      ? 0
      : options.mode === "command-path"
        ? consumeRootCommandOptionToken(args, index)
        : consumeRootOptionToken(args, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    if (!literal && arg.startsWith("-")) {
      const optionConsumed = consumeKnownOptionToken(
        args,
        index,
        booleanFlags,
        valueFlags,
        options.mode,
      );
      if (optionConsumed === 0) {
        return null;
      }
      index += optionConsumed - 1;
      continue;
    }
    if (commandIndex < options.commandPath.length) {
      if (arg !== options.commandPath[commandIndex]) {
        return null;
      }
      commandIndex += 1;
      if (returnTail && commandIndex === options.commandPath.length) {
        const tail = args.slice(index + 1);
        // A downstream parser must not reactivate flags after an earlier literal boundary.
        return literal ? [FLAG_TERMINATOR, ...tail] : tail;
      }
      continue;
    }
    positionals.push(arg);
    if (positionals.length === options.maxPositionals) {
      return positionals;
    }
  }

  return commandIndex < options.commandPath.length ? null : positionals;
}
