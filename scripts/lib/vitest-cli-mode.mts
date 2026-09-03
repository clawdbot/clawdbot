// Shared CLI classification for the test launcher and config execution hooks.
const NON_RUN_VITEST_SUBCOMMANDS = new Set(["bench", "list", "related"]);
const VITEST_OPTIONS_WITH_VALUE = new Set([
  "--attachmentsDir",
  "--bail",
  "--browser",
  "--config",
  "--configLoader",
  "-c",
  "--changed",
  "--dir",
  "--diff",
  "--environment",
  "--exclude",
  "--execArgv",
  "--hookTimeout",
  "--inspect",
  "--inspectBrk",
  "--listTags",
  "--maxConcurrency",
  "--maxWorkers",
  "--mergeReports",
  "--mode",
  "--outputFile",
  "--pool",
  "--project",
  "--reporter",
  "--reporters",
  "--retry",
  "--root",
  "-r",
  "--sequence",
  "--sequence.hooks",
  "--sequence.seed",
  "--sequence.setupFiles",
  "--shard",
  "--silent",
  "--slowTestThreshold",
  "--tagsFilter",
  "--teardownTimeout",
  "--testNamePattern",
  "-t",
  "--testTimeout",
  "--update",
  "-u",
  "--vmMemoryLimit",
]);
const VITEST_DOTTED_OPTIONS_WITH_VALUE_PREFIXES = [
  "--browser.",
  "--coverage.",
  "--diff.",
  "--expect.",
  "--experimental.",
  "--outputFile.",
  "--retry.",
  "--typecheck.",
];

export function vitestOptionConsumesNextArg(arg: string, nextArg?: string): boolean {
  // MRI treats an empty inline value like a separated option, not a supplied value.
  const token = arg.replace(/[=]$/u, "");
  if (
    !arg.startsWith("-") ||
    /^-+no-/u.test(arg) ||
    token.includes("=") ||
    nextArg === undefined ||
    nextArg.startsWith("-")
  ) {
    return false;
  }
  const option = token.replace(
    /([a-z])-([a-z])/gu,
    (_, a: string, b: string) => a + b.toUpperCase(),
  );
  // Positive booleans own literal true/false; negations never own an operand.
  return (
    nextArg === "true" ||
    nextArg === "false" ||
    VITEST_OPTIONS_WITH_VALUE.has(option) ||
    VITEST_DOTTED_OPTIONS_WITH_VALUE_PREFIXES.some((prefix) => option.startsWith(prefix))
  );
}

export const VITEST_SUBCOMMANDS = new Set([
  "run",
  "watch",
  "dev",
  "bench",
  "list",
  "related",
  "init",
]);

function* vitestPositionals(argv: string[]) {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    // CAC stores the native separator tail in options["--"], not in file filters.
    if (arg === "--") {
      break;
    }
    if (vitestOptionConsumesNextArg(arg, argv[index + 1])) {
      index++;
    } else if (!arg.startsWith("-")) {
      yield arg;
    }
  }
}

export function hasNonRunVitestSubcommand(
  argv: string[],
  commands = NON_RUN_VITEST_SUBCOMMANDS,
): boolean {
  const first = vitestPositionals(argv).next();
  return !first.done && commands.has(first.value);
}

export function collectVitestFileFilters(argv: string[]): string[] {
  const values = [...vitestPositionals(argv)];
  return values[0] && VITEST_SUBCOMMANDS.has(values[0]) ? values.slice(1) : values;
}

export function resolveBooleanModeFlag(
  argv: string[],
  index: number,
  longName: string,
  shortName: string | null = null,
): { value: boolean; consumedNext: boolean } | null {
  const arg = argv[index];
  if (arg === undefined) {
    return null;
  }
  const parseValue = (rawValue: string): boolean => rawValue !== "false";
  const flags = shortName === null ? [`--${longName}`] : [`--${longName}`, shortName];
  for (const flag of flags) {
    if (arg === `--no-${longName}`) {
      return { value: false, consumedNext: false };
    }
    if (arg === flag || arg === `${flag}=`) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        return { value: parseValue(next), consumedNext: true };
      }
      return { value: true, consumedNext: false };
    }
    if (arg.startsWith(`${flag}=`)) {
      return { value: parseValue(arg.slice(flag.length + 1)), consumedNext: false };
    }
  }
  return null;
}

export function resolveExplicitVitestMode(argv: string[]): "run" | "watch" | null {
  let mode: "run" | "watch" | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      break;
    }
    const watchFlag = resolveBooleanModeFlag(argv, index, "watch", "-w");
    if (watchFlag) {
      if (watchFlag.consumedNext) {
        index += 1;
      }
      if (watchFlag.value) {
        return "watch";
      }
      mode = "run";
      continue;
    }
    const runFlag = resolveBooleanModeFlag(argv, index, "run");
    if (runFlag) {
      if (runFlag.consumedNext) {
        index += 1;
      }
      if (runFlag.value) {
        mode = "run";
      }
      continue;
    }
    if (vitestOptionConsumesNextArg(arg, argv[index + 1])) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (mode !== null) {
      continue;
    }
    if (arg === "watch" || arg === "dev") {
      return "watch";
    }
    if (arg === "run") {
      mode = "run";
      continue;
    }
    return null;
  }
  return mode;
}
