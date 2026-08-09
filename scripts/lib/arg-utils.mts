// Shared argument parsing helpers for repository scripts.
type FlagArgs = Record<string, unknown>;
type Argv = readonly string[];

type StringOptions = {
  allowEmpty?: boolean;
  allowInline?: boolean;
  missingValueMessage?: string;
  rejectShortOptions?: boolean;
  repeatable?: boolean;
  transform?: (value: string) => unknown;
};

type ConsumedFlag<T extends FlagArgs> = {
  flag?: string;
  nextIndex: number;
  repeatable?: boolean;
  apply(target: T): void;
};

export type FlagSpec<T extends FlagArgs> = {
  consume(argv: Argv, index: number, args: T): ConsumedFlag<T> | null;
};

function failFlagParse(message: string): never {
  throw new Error(message);
}

function assignFlag(target: FlagArgs, key: string, value: unknown) {
  target[key] = value;
}
/**
 * Read a flag value from `--flag value` or `--flag=value` arguments.
 * @internal Shared repository-script contract.
 */
export function readFlagValue(args: Argv, name: string): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === name) {
      return args[index + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

/**
 * Remove the leading `--` separator inserted by package-manager script invocations.
 * @internal Shared repository-script contract.
 */
export function stripLeadingPackageManagerSeparator(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function isMissingStringFlagValue(value: string, options: StringOptions) {
  if (!value && options.allowEmpty !== true) {
    return true;
  }
  if (value.startsWith("--")) {
    return true;
  }
  return options.rejectShortOptions === true && value.startsWith("-");
}

function consumeStringFlag(argv: Argv, index: number, flag: string, options: StringOptions) {
  const arg = argv[index];
  if (arg === undefined) {
    return null;
  }
  const inlineValue = options.allowInline === false ? null : readInlineFlagValue(arg, flag);
  if (inlineValue !== null) {
    if (isMissingStringFlagValue(inlineValue, options)) {
      failFlagParse(options.missingValueMessage ?? `${flag} requires a value`);
    }
    return {
      nextIndex: index,
      value: inlineValue,
    };
  }
  if (argv[index] !== flag) {
    return null;
  }
  const value = argv[index + 1];
  if (value === undefined || isMissingStringFlagValue(value, options)) {
    failFlagParse(options.missingValueMessage ?? `${flag} requires a value`);
  }
  return {
    nextIndex: index + 1,
    value,
  };
}

function readInlineFlagValue(arg: string, flag: string) {
  const prefix = `${flag}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}

function readFlagOptionValue(argv: Argv, index: number, flag: string) {
  const arg = argv[index];
  if (arg === undefined) {
    return null;
  }
  const inlineValue = readInlineFlagValue(arg, flag);
  if (inlineValue !== null) {
    if (!inlineValue) {
      failFlagParse(`${flag} requires a value`);
    }
    return { nextIndex: index, value: inlineValue };
  }
  if (argv[index] !== flag) {
    return null;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    failFlagParse(`${flag} requires a value`);
  }
  return { nextIndex: index + 1, value };
}

function parseIntegerFlagValue(raw: string, flag: string) {
  const text = raw.trim();
  if (!/^-?\d+$/u.test(text)) {
    failFlagParse(`${flag} must be an integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    failFlagParse(`${flag} must be a safe integer`);
  }
  return parsed;
}

/** Create a flag spec that assigns one string value to the parsed args object. */
export function stringFlag<T extends FlagArgs>(
  flag: string,
  key: string,
  options: StringOptions = {},
): FlagSpec<T> {
  return {
    consume(argv, index) {
      const option = consumeStringFlag(argv, index, flag, options);
      if (!option) {
        return null;
      }
      return {
        flag,
        nextIndex: option.nextIndex,
        repeatable: options.repeatable === true,
        apply(target) {
          const value = options.transform ? options.transform(option.value) : option.value;
          assignFlag(target, key, value);
        },
      };
    },
  };
}

/**
 * Create a flag spec that appends repeated string values to an array field.
 * @internal Shared repository-script contract.
 */
export function stringListFlag<T extends FlagArgs>(
  flag: string,
  key: string,
  options: Omit<StringOptions, "repeatable" | "transform"> = {},
): FlagSpec<T> {
  return {
    consume(argv, index) {
      const option = consumeStringFlag(argv, index, flag, options);
      if (!option) {
        return null;
      }
      return {
        flag,
        nextIndex: option.nextIndex,
        repeatable: true,
        apply(target) {
          const current = target[key];
          if (current == null) {
            assignFlag(target, key, [option.value]);
            return;
          }
          if (!Array.isArray(current)) {
            throw new TypeError(`${key} must be an array`);
          }
          current.push(option.value);
        },
      };
    },
  };
}

/**
 * Create a flag spec that parses and assigns a safe integer value.
 * @internal Shared repository-script contract.
 */
export function intFlag<T extends FlagArgs>(
  flag: string,
  key: string,
  options?: { min?: number },
): FlagSpec<T> {
  return {
    consume(argv, index) {
      const raw = readFlagOptionValue(argv, index, flag);
      if (!raw) {
        return null;
      }
      const value = parseIntegerFlagValue(raw.value, flag);
      const min = options?.min ?? Number.NEGATIVE_INFINITY;
      if (value < min) {
        failFlagParse(`${flag} must be at least ${min}`);
      }
      return {
        flag,
        nextIndex: raw.nextIndex,
        repeatable: false,
        apply(target) {
          assignFlag(target, key, value);
        },
      };
    },
  };
}

/** Create a flag spec that assigns a fixed boolean-like value when present. */
export function booleanFlag<T extends FlagArgs>(
  flag: string,
  key: string,
  value: unknown = true,
  options: { repeatable?: boolean } = {},
): FlagSpec<T> {
  return {
    consume(argv, index) {
      if (argv[index] !== flag) {
        return null;
      }
      return {
        flag,
        nextIndex: index,
        repeatable: options.repeatable === true,
        apply(target) {
          assignFlag(target, key, value);
        },
      };
    },
  };
}

/** Apply flag specs to argv and return the mutated parsed args object. */
export function parseFlagArgs<T extends FlagArgs>(
  argv: Argv,
  args: T,
  specs: readonly FlagSpec<T>[],
  options: {
    allowUnknownOptions?: boolean;
    duplicateOptionMessage?: (flag: string) => string;
    ignoreDoubleDash?: boolean;
    onUnhandledArg?: (arg: string, args: T) => "handled" | void;
  } = {},
): T {
  const ignoreDoubleDash = options.ignoreDoubleDash ?? true;
  const seenFlags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--" && ignoreDoubleDash) {
      continue;
    }
    let handled = false;
    for (const spec of specs) {
      const option = spec.consume(argv, i, args);
      if (!option) {
        continue;
      }
      if (typeof option.flag !== "string" || !option.flag) {
        failFlagParse("parseFlagArgs specs must declare a flag for consumed options");
      }
      if (option.repeatable !== true) {
        if (seenFlags.has(option.flag)) {
          failFlagParse(
            options.duplicateOptionMessage?.(option.flag) ??
              `${option.flag} was provided more than once`,
          );
        }
        seenFlags.add(option.flag);
      }
      option.apply(args);
      i = option.nextIndex;
      handled = true;
      break;
    }
    if (handled) {
      continue;
    }
    const fallbackResult = options.onUnhandledArg?.(arg, args);
    if (fallbackResult === "handled") {
      continue;
    }
    if (!options.allowUnknownOptions && arg.startsWith("-")) {
      failFlagParse(`Unknown option: ${arg}`);
    }
  }
  return args;
}
