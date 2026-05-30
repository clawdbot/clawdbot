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

export function readBudgetEnvNumber(name, env = process.env) {
  return parseBudgetNumber(env[name], name);
}

export function budgetFloatFlag(flag, key) {
  return {
    consume(argv, index) {
      if (argv[index] !== flag) {
        return null;
      }
      return {
        nextIndex: index + 1,
        apply(target) {
          const parsed = parseBudgetNumber(argv[index + 1], flag);
          if (parsed === null) {
            throw new Error(`${flag} requires a value`);
          }
          target[key] = parsed;
        },
      };
    },
  };
}
