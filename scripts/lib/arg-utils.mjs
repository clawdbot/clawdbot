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

function consumeStringFlag(argv, index, flag, currentValue) {
  if (argv[index] !== flag) {
    return null;
  }
  return {
    nextIndex: index + 1,
    value: argv[index + 1] ?? currentValue,
  };
}

function consumeIntFlag(argv, index, flag, currentValue, options = {}) {
  if (argv[index] !== flag) {
    return null;
  }
  const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  return {
    nextIndex: index + 1,
    value: Number.isFinite(parsed) && parsed >= min ? parsed : currentValue,
  };
}

function consumeFloatFlag(argv, index, flag, currentValue, options = {}) {
  if (argv[index] !== flag) {
    return null;
  }
  const parsed = Number.parseFloat(argv[index + 1] ?? "");
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const includeMin = options.includeMin ?? true;
  const isValid = Number.isFinite(parsed) && (includeMin ? parsed >= min : parsed > min);
  return {
    nextIndex: index + 1,
    value: isValid ? parsed : currentValue,
  };
}

export function stringFlag(flag, key) {
  return {
    consume(argv, index, args) {
      const option = consumeStringFlag(argv, index, flag, args[key]);
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
  return createAssignedValueFlag((argv, index, args) => {
    const option = consumeIntFlag(argv, index, flag, args[key], options);
    return option ? { ...option, key } : null;
  });
}

export function floatFlag(flag, key, options) {
  return createAssignedValueFlag((argv, index, args) => {
    const option = consumeFloatFlag(argv, index, flag, args[key], options);
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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--" && options.ignoreDoubleDash) {
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
