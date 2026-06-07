// Numeric budget flag/env helpers shared by benchmark and performance scripts.
/** Parse an optional non-negative budget number from CLI or env text. */
export function parseBudgetNumber(raw, label) {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

/** Read a non-negative budget number from an environment variable. */
export function readBudgetEnvNumber(name, env = process.env) {
  return parseBudgetNumber(env[name], name);
}

/** Create a flag spec that stores a non-negative floating-point budget value. */
export function budgetFloatFlag(flag, key) {
  return {
    consume(argv, index) {
      if (argv[index] !== flag) {
        return null;
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      return {
        nextIndex: index + 1,
        apply(target) {
          const parsed = parseBudgetNumber(value, flag);
          if (parsed === null) {
            throw new Error(`${flag} requires a value`);
          }
          target[key] = parsed;
        },
      };
    },
  };
}
