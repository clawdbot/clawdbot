// Lightweight CLI contract for the issue #78851 model-resolution profiler.
export type Issue78851ModelResolutionOptions = {
  agentCount: number;
  cpuProfDir?: string;
  cpuProfOutput?: string;
  json: boolean;
  keepTemp: boolean;
  lookupsPerRun: number;
  modelsPerProvider: number;
  output?: string;
  providers: number;
  runs: number;
  runtimeHooks: boolean;
  warmup: number;
};

const BOOLEAN_FLAGS = new Set(["--help", "-h", "--json", "--keep-temp", "--runtime-hooks"]);
const VALUE_FLAGS = new Set([
  "--agents",
  "--cpu-prof-dir",
  "--cpu-prof-output",
  "--lookups",
  "--models-per-provider",
  "--output",
  "--providers",
  "--runs",
  "--warmup",
]);

export class Issue78851CliArgumentError extends Error {
  override name = "Issue78851CliArgumentError";
}

function parseFlagValue(flag: string, args: readonly string[]): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Issue78851CliArgumentError(`${flag} requires a value`);
  }
  return value;
}

function parseInteger(
  flag: string,
  fallback: number,
  args: readonly string[],
  minimum: number,
  label: string,
): number {
  const raw = parseFlagValue(flag, args);
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Issue78851CliArgumentError(`${flag} must be a ${label} integer`);
  }
  return value;
}

function validateArgs(args: readonly string[]): void {
  const seenValueFlags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new Issue78851CliArgumentError(`Unknown argument: ${arg}`);
    }
    if (seenValueFlags.has(arg)) {
      throw new Issue78851CliArgumentError(`${arg} was provided more than once`);
    }
    seenValueFlags.add(arg);
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Issue78851CliArgumentError(`${arg} requires a value`);
    }
    index += 1;
  }
}

export function issue78851ModelResolutionHelpRequested(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export function parseIssue78851ModelResolutionOptions(
  args: readonly string[],
): Issue78851ModelResolutionOptions {
  validateArgs(args);
  return {
    agentCount: parseInteger("--agents", 8, args, 1, "positive"),
    cpuProfDir: parseFlagValue("--cpu-prof-dir", args),
    cpuProfOutput: parseFlagValue("--cpu-prof-output", args),
    json: args.includes("--json"),
    keepTemp: args.includes("--keep-temp"),
    lookupsPerRun: parseInteger("--lookups", 32, args, 1, "positive"),
    modelsPerProvider: parseInteger("--models-per-provider", 16, args, 1, "positive"),
    output: parseFlagValue("--output", args),
    providers: parseInteger("--providers", 48, args, 1, "positive"),
    runs: parseInteger("--runs", 8, args, 1, "positive"),
    runtimeHooks: args.includes("--runtime-hooks"),
    warmup: parseInteger("--warmup", 1, args, 0, "non-negative"),
  };
}

export function issue78851ModelResolutionUsage(): string {
  return `OpenClaw issue #78851 model-resolution profiler

Usage:
  pnpm perf:issue-78851 -- [options]
  node --import tsx scripts/perf/issue-78851-model-resolution.ts [options]

Options:
  --providers <n>             Synthetic configured providers (default: 48)
  --models-per-provider <n>   Models per provider (default: 16)
  --agents <n>                Agent configs/fallback chains (default: 8)
  --lookups <n>               resolveModelAsync calls per phase (default: 32)
  --runs <n>                  Measured runs (default: 8)
  --warmup <n>                Warmup runs before measurement (default: 1)
  --cpu-prof-dir <dir>        Write a V8 .cpuprofile for the measured loop
  --cpu-prof-output <path>    Write the V8 .cpuprofile to this exact path
  --runtime-hooks             Include provider runtime hook resolution
  --output <path>             Write JSON report
  --json                      Print JSON report
  --keep-temp                 Keep generated temp state
  --help, -h                  Show this text
`;
}
