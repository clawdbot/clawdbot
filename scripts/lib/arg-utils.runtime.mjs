// Shared argument parsing helpers for repository scripts.
/**
 * @template {Record<string, unknown>} T
 * @typedef {{ bivarianceHack(target: T): void }["bivarianceHack"]} ApplyFlag
 */
/**
 * @template {Record<string, unknown>} T
 * @typedef {{
 *   flag?: string,
 *   nextIndex: number,
 *   repeatable?: boolean,
 *   apply: ApplyFlag<T>,
 * }} ConsumedFlag
 */
/**
 * @template {Record<string, unknown>} T
 * @typedef {{
 *   bivarianceHack(
 *     argv: readonly string[],
 *     index: number,
 *     args: T,
 *   ): ConsumedFlag<T> | null,
 * }["bivarianceHack"]} ConsumeFlag
 */
/**
 * @template {Record<string, unknown>} T
 * @typedef {{
 *   consume: ConsumeFlag<T>,
 * }} FlagSpec
 */
/**
 * @typedef {{
 *   allowEmpty?: boolean,
 *   allowInline?: boolean,
 *   missingValueMessage?: string,
 *   rejectShortOptions?: boolean,
 *   repeatable?: boolean,
 *   transform?: (value: string) => unknown,
 * }} StringOptions
 */
/**
 * @template {Record<string, unknown>} T
 * @typedef {{
 *   allowUnknownOptions?: boolean,
 *   duplicateOptionMessage?: (flag: string) => string,
 *   ignoreDoubleDash?: boolean,
 *   onUnhandledArg?: (arg: string, args: T) => "handled" | void,
 * }} ParseOptions
 */
/** @param {string} message */
function failFlagParse(message) {
  throw new Error(message);
}
/**
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 */
function assignFlag(target, key, value) {
  target[key] = value;
}
/**
 * Read a flag value from `--flag value` or `--flag=value` arguments.
 * @internal Shared repository-script contract.
 * @param {readonly string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
export function readFlagValue(args, name) {
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
 * @param {string[]} argv
 * @returns {string[]}
 */
export function stripLeadingPackageManagerSeparator(argv) {
  return argv[0] === "--" ? argv.slice(1) : argv;
}
/**
 * @param {string} value
 * @param {StringOptions} options
 */
function isMissingStringFlagValue(value, options) {
  if (!value && options.allowEmpty !== true) {
    return true;
  }
  if (value.startsWith("--")) {
    return true;
  }
  return options.rejectShortOptions === true && value.startsWith("-");
}
/**
 * @param {readonly string[]} argv
 * @param {number} index
 * @param {string} flag
 * @param {StringOptions} options
 */
function consumeStringFlag(argv, index, flag, options) {
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
/**
 * @param {string} arg
 * @param {string} flag
 */
function readInlineFlagValue(arg, flag) {
  const prefix = `${flag}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}
/**
 * @param {readonly string[]} argv
 * @param {number} index
 * @param {string} flag
 */
function readFlagOptionValue(argv, index, flag) {
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
/**
 * @param {string} raw
 * @param {string} flag
 */
function parseIntegerFlagValue(raw, flag) {
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
/**
 * Create a flag spec that assigns one string value to the parsed args object.
 * @template {Record<string, unknown>} T
 * @param {string} flag
 * @param {string} key
 * @param {StringOptions} [options]
 * @returns {FlagSpec<T>}
 */
export function stringFlag(flag, key, options = {}) {
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
 * @template {Record<string, unknown>} T
 * @param {string} flag
 * @param {string} key
 * @param {Omit<StringOptions, "repeatable" | "transform">} [options]
 * @returns {FlagSpec<T>}
 */
export function stringListFlag(flag, key, options = {}) {
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
 * @template {Record<string, unknown>} T
 * @param {string} flag
 * @param {string} key
 * @param {{ min?: number }} [options]
 * @returns {FlagSpec<T>}
 */
export function intFlag(flag, key, options) {
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
/**
 * Create a flag spec that assigns a fixed boolean-like value when present.
 * @template {Record<string, unknown>} T
 * @param {string} flag
 * @param {string} key
 * @param {unknown} [value]
 * @param {{ repeatable?: boolean }} [options]
 * @returns {FlagSpec<T>}
 */
export function booleanFlag(flag, key, value = true, options = {}) {
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
/**
 * Apply flag specs to argv and return the mutated parsed args object.
 * @template {Record<string, unknown>} T
 * @param {readonly string[]} argv
 * @param {T} args
 * @param {readonly FlagSpec<T>[]} specs
 * @param {ParseOptions<T>} [options]
 * @returns {T}
 */
export function parseFlagArgs(argv, args, specs, options = {}) {
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
