// Parses Vitest passthrough args for test-planner entry filter accounting.
/** Vitest options that consume the following CLI token as a value. */
export const OPTION_TAKES_VALUE = new Set([
  "-t",
  "-c",
  "-r",
  "--testNamePattern",
  "--config",
  "--root",
  "--dir",
  "--reporter",
  "--outputFile",
  "--pool",
  "--execArgv",
  "--vmMemoryLimit",
  "--maxWorkers",
  "--environment",
  "--shard",
  "--changed",
  "--sequence",
  "--inspect",
  "--inspectBrk",
  "--testTimeout",
  "--hookTimeout",
  "--bail",
  "--retry",
  "--diff",
  "--exclude",
  "--project",
  "--slowTestThreshold",
  "--teardownTimeout",
  "--attachmentsDir",
  "--mode",
  "--api",
  "--browser",
  "--maxConcurrency",
  "--mergeReports",
  "--configLoader",
  "--experimental",
]);

/** Flags that only make sense for a single generated test run. */
export const SINGLE_RUN_ONLY_FLAGS = new Set(["--coverage", "--outputFile", "--mergeReports"]);

/**
 * Splits Vitest passthrough args into file filters and option args.
 */
export const parsePassthroughArgs = (args = []) => {
  const fileFilters = [];
  const optionArgs = [];
  let consumeNextAsOptionValue = false;

  for (const arg of args) {
    if (consumeNextAsOptionValue) {
      optionArgs.push(arg);
      consumeNextAsOptionValue = false;
      continue;
    }
    if (arg === "--") {
      optionArgs.push(arg);
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("-")) {
      optionArgs.push(arg);
      consumeNextAsOptionValue = !arg.includes("=") && OPTION_TAKES_VALUE.has(arg);
      continue;
    }
    fileFilters.push(arg);
  }

  return { fileFilters, optionArgs };
};

export const countExplicitEntryFilters = (entryArgs) => {
  const { fileFilters } = parsePassthroughArgs(entryArgs.slice(2));
  return fileFilters.length > 0 ? fileFilters.length : null;
};

export const getExplicitEntryFilters = (entryArgs) =>
  parsePassthroughArgs(entryArgs.slice(2)).fileFilters;
