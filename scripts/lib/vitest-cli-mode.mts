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
  "--inspect-brk",
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

export function vitestOptionConsumesNextArg(arg: string): boolean {
  if (arg.includes("=")) {
    return false;
  }
  return (
    VITEST_OPTIONS_WITH_VALUE.has(arg) ||
    VITEST_DOTTED_OPTIONS_WITH_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

export function hasNonRunVitestSubcommand(
  argv: string[],
  commands = NON_RUN_VITEST_SUBCOMMANDS,
): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      return false;
    }
    if (vitestOptionConsumesNextArg(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return commands.has(arg);
  }
  return false;
}

/** Metadata collection may import tests, but must not prepare subprocess builds. */
export function isVitestWorkerMetadataRequest(argv: string[]): boolean {
  if (hasNonRunVitestSubcommand(argv, new Set(["list"]))) {
    return true;
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") {
      break;
    }
    if (["--help", "-h", "--version", "-v"].includes(arg)) {
      return true;
    }
    if (vitestOptionConsumesNextArg(arg)) {
      index++;
    }
  }
  return false;
}
