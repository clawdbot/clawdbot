export type ProfileId = "smoke" | "default" | "large";

type CliOptions = {
  output: string | null;
  profile: ProfileId;
  stateDir: string | null;
};

const BOOLEAN_FLAGS = new Set(["--help"]);
const VALUE_FLAGS = new Set(["--output", "--profile", "--state-dir"]);

export class CliUsageError extends Error {
  override name = "CliUsageError";
}

function parseFlagValue(flag: string, argv: string[]): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
}

function validateArgs(argv: string[]): void {
  const seenValueFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new CliUsageError(`Unknown argument: ${arg}`);
    }
    if (seenValueFlags.has(arg)) {
      throw new CliUsageError(`${arg} was provided more than once`);
    }
    seenValueFlags.add(arg);
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new CliUsageError(`${arg} requires a value`);
    }
    index += 1;
  }
}

function parseProfile(raw: string | undefined): ProfileId {
  if (!raw) {
    return "default";
  }
  if (raw === "smoke" || raw === "default" || raw === "large") {
    return raw;
  }
  throw new CliUsageError(
    `--profile must be one of smoke, default, large; got ${JSON.stringify(raw)}`,
  );
}

export function parseSqliteStateBenchmarkCli(
  argv: string[],
): { help: true } | { help: false; options: CliOptions } {
  validateArgs(argv);
  if (argv.includes("--help")) {
    return { help: true };
  }
  return {
    help: false,
    options: {
      output: parseFlagValue("--output", argv) ?? null,
      profile: parseProfile(parseFlagValue("--profile", argv)),
      stateDir: parseFlagValue("--state-dir", argv) ?? null,
    },
  };
}
