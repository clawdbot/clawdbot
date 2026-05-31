export function readEnvNumber(name, env = process.env) {
  const raw = env[name]?.trim();
  if (!raw) {
    return null;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readFlagValue(args, name) {
  for (let index = 0; index < args.length; index += 1) {
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

export function stripLeadingPackageManagerSeparator(argv) {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function isMissingStringFlagValue(value, options = {}) {
  if (!value) {
    return true;
  }
  if (value.startsWith("--")) {
    return true;
  }
  return options.rejectShortOptions === true && value.startsWith("-");
}

function consumeStringFlag(argv, index, flag, options = {}) {
  const inlineValue = readInlineFlagValue(argv[index], flag);
  if (inlineValue !== null) {
    if (isMissingStringFlagValue(inlineValue, options)) {
      throw new Error(`${flag} requires a value`);
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
    throw new Error(`${flag} requires a value`);
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
    throw new Error(`${flag} must be at least ${min}`);
  }
  return {
    nextIndex: raw.nextIndex,
    value: parsed,
  };
}

function consumeFloatFlag(argv, index, flag, options = {}) {
  const raw = readFlagOptionValue(argv, index, flag);
  if (!raw) {
    return null;
  }
  const parsed = parseFloatFlagValue(raw.value, flag);
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const includeMin = options.includeMin ?? true;
  const isValid = Number.isFinite(parsed) && (includeMin ? parsed >= min : parsed > min);
  if (!isValid) {
    const comparator = includeMin ? "at least" : "greater than";
    throw new Error(`${flag} must be ${comparator} ${min}`);
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
      throw new Error(`${flag} requires a value`);
    }
    return { nextIndex: index, value: inlineValue };
  }
  if (argv[index] !== flag) {
    return null;
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return { nextIndex: index + 1, value };
}

function parseIntegerFlagValue(raw, flag) {
  const text = String(raw).trim();
  if (!/^-?\d+$/u.test(text)) {
    throw new Error(`${flag} must be an integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a safe integer`);
  }
  return parsed;
}

function parseFloatFlagValue(raw, flag) {
  const text = String(raw).trim();
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text)) {
    throw new Error(`${flag} must be a number`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a finite number`);
  }
  return parsed;
}

export function stringFlag(flag, key, options = {}) {
  return {
    consume(argv, index) {
      const option = consumeStringFlag(argv, index, flag, options);
      if (!option) {
        return null;
      }
      return {
        nextIndex: option.nextIndex,
        apply(target) {
          target[key] = option.value;
        },
      };
    },
  };
}

export function stringListFlag(flag, key, options = {}) {
  return {
    consume(argv, index) {
      const option = consumeStringFlag(argv, index, flag, options);
      if (!option) {
        return null;
      }
      return {
        nextIndex: option.nextIndex,
        apply(target) {
          target[key] ??= [];
          target[key].push(option.value);
        },
      };
    },
  };
}

function createAssignedValueFlag(consumeOption) {
  return {
    consume(argv, index, args) {
      const option = consumeOption(argv, index, args);
      if (!option) {
        return null;
      }
      return {
        nextIndex: option.nextIndex,
        apply(target) {
          target[option.key] = option.value;
        },
      };
    },
  };
}

export function intFlag(flag, key, options) {
  return createAssignedValueFlag((argv, index) => {
    const option = consumeIntFlag(argv, index, flag, options);
    return option ? { ...option, key } : null;
  });
}

export function floatFlag(flag, key, options) {
  return createAssignedValueFlag((argv, index) => {
    const option = consumeFloatFlag(argv, index, flag, options);
    return option ? { ...option, key } : null;
  });
}

export function booleanFlag(flag, key, value = true) {
  return {
    consume(argv, index) {
      if (argv[index] !== flag) {
        return null;
      }
      return {
        nextIndex: index,
        apply(target) {
          target[key] = value;
        },
      };
    },
  };
}

export function parseFlagArgs(argv, args, specs, options = {}) {
  const ignoreDoubleDash = options.ignoreDoubleDash ?? true;
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
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}
