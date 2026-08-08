// Shared argument parsing helpers for repository scripts.
function failFlagParse(message) {
  throw new Error(message);
}
/**
 * Read a flag value from `--flag value` or `--flag=value` arguments.
 * @internal Shared repository-script contract.
 */
export function readFlagValue(args, name) {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
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
export function stripLeadingPackageManagerSeparator(argv) {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function isMissingStringFlagValue(value, options = {}) {
  if (value === undefined || (!value && options.allowEmpty !== true)) {
    return true;
  }
  if (value.startsWith("--")) {
    return true;
  }
  return options.rejectShortOptions === true && value.startsWith("-");
}

function consumeStringFlag(argv, index, flag, options = {}) {
  const inlineValue = options.allowInline === false ? null : readInlineFlagValue(argv[index], flag);
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
  if (isMissingStringFlagValue(value, options)) {
    failFlagParse(options.missingValueMessage ?? `${flag} requires a value`);
  }
  return {
    nextIndex: index + 1,
    value,
  };
}

function consumeIntFlag(argv, index, flag, options = {}) {
  const raw = readFlagOptionValue(argv, index, flag);
  if (!raw) {
    return null;
  }
  const parsed = parseIntegerFlagValue(raw.value, flag);
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  if (parsed < min) {
    failFlagParse(`${flag} must be at least ${min}`);
  }
  return {
    nextIndex: raw.nextIndex,
    value: parsed,
  };
}

function readInlineFlagValue(arg, flag) {
  const prefix = `${flag}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}

function readFlagOptionValue(argv, index, flag) {
  const inlineValue = readInlineFlagValue(argv[index], flag);
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

function parseIntegerFlagValue(raw, flag) {
  const text = String(raw).trim();
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
          target[key] = options.transform ? options.transform(option.value) : option.value;
        },
      };
    },
  };
}

/**
 * Create a flag spec that appends repeated string values to an array field.
 * @internal Shared repository-script contract.
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
          target[key] ??= [];
          target[key].push(option.value);
        },
      };
    },
  };
}

function createAssignedValueFlag(flag, consumeOption) {
  return {
    consume(argv, index, args) {
      const option = consumeOption(argv, index, args);
      if (!option) {
        return null;
      }
      return {
        flag,
        nextIndex: option.nextIndex,
        repeatable: false,
        apply(target) {
          target[option.key] = option.value;
        },
      };
    },
  };
}

/**
 * Create a flag spec that parses and assigns a safe integer value.
 * @internal Shared repository-script contract.
 */
export function intFlag(flag, key, options) {
  return createAssignedValueFlag(flag, (argv, index) => {
    const option = consumeIntFlag(argv, index, flag, options);
    return option ? { ...option, key } : null;
  });
}

/** Create a flag spec that assigns a fixed boolean-like value when present. */
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
          target[key] = value;
        },
      };
    },
  };
}

/** Apply flag specs to argv and return the mutated parsed args object. */
export function parseFlagArgs(argv, args, specs, options = {}) {
  const ignoreDoubleDash = options.ignoreDoubleDash ?? true;
  const seenFlags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
