const FALSE_OPTION_VALUES = new Set(["0", "false", "no", "off"]);
const NO_OPTIONS_WITH_VALUE = new Set<string>();

/** Normalize a lifecycle CLI option name without its attached value. */
export function lifecycleOptionName(token: string): string {
  return token.trim().toLowerCase().replaceAll("`", "").replaceAll("^", "").split("=", 1)[0] ?? "";
}

/** Return the final effective value of a repeatable boolean option before `--`. */
export function lifecycleHasEffectiveBooleanOption(
  argv: readonly string[],
  start: number,
  names: ReadonlySet<string>,
  optionsWithValue: ReadonlySet<string> = NO_OPTIONS_WITH_VALUE,
): boolean {
  let enabled = false;
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      break;
    }
    const name = lifecycleOptionName(token);
    if (optionsWithValue.has(name) && !token.includes("=")) {
      index += 1;
      continue;
    }
    const negatedName = name.startsWith("--no-") ? `--${name.slice("--no-".length)}` : "";
    if (negatedName && names.has(negatedName)) {
      enabled = false;
      continue;
    }
    if (names.has(name)) {
      const value = token.includes("=")
        ? token.slice(token.indexOf("=") + 1).toLowerCase()
        : "true";
      enabled = !FALSE_OPTION_VALUES.has(value);
    }
  }
  return enabled;
}

/** Return true when a boolean option's attached value is resolved only at shell runtime. */
export function lifecycleBooleanOptionValueMayBeDynamic(
  argv: readonly string[],
  start: number,
  names: ReadonlySet<string>,
  isDynamic: (value: string | undefined) => boolean,
  optionsWithValue: ReadonlySet<string> = NO_OPTIONS_WITH_VALUE,
): boolean {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      break;
    }
    const name = lifecycleOptionName(token);
    if (optionsWithValue.has(name) && !token.includes("=")) {
      index += 1;
      continue;
    }
    if (names.has(name) && token.includes("=") && isDynamic(token)) {
      return true;
    }
  }
  return false;
}
