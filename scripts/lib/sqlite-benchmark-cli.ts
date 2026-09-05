export type SqliteBenchmarkProfileId = "smoke" | "default" | "large";

export class CliUsageError extends Error {
  override name = "CliUsageError";
}

function parseProfile(raw: string | undefined): SqliteBenchmarkProfileId {
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

export function parseSqliteBenchmarkCli(
  argv: string[],
  valueFlags: ReadonlySet<string>,
):
  | { help: true }
  | {
      help: false;
      profile: SqliteBenchmarkProfileId;
      values: ReadonlyMap<string, string>;
    } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help") {
      continue;
    }
    if (!valueFlags.has(arg)) {
      throw new CliUsageError(`Unknown argument: ${arg}`);
    }
    if (values.has(arg)) {
      throw new CliUsageError(`${arg} was provided more than once`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new CliUsageError(`${arg} requires a value`);
    }
    values.set(arg, value);
    index += 1;
  }
  if (argv.includes("--help")) {
    return { help: true };
  }
  return {
    help: false,
    profile: parseProfile(values.get("--profile")),
    values,
  };
}
