import {
  CliUsageError,
  parseSqliteBenchmarkCli,
  type SqliteBenchmarkProfileId,
} from "./sqlite-benchmark-cli.js";

export type ProfileId = SqliteBenchmarkProfileId;

type CliOptions = {
  output: string | null;
  profile: ProfileId;
  stateDir: string | null;
};

const VALUE_FLAGS = new Set(["--output", "--profile", "--state-dir"]);

export { CliUsageError };

export function parseSqliteStateBenchmarkCli(
  argv: string[],
): { help: true } | { help: false; options: CliOptions } {
  const parsed = parseSqliteBenchmarkCli(argv, VALUE_FLAGS);
  if (parsed.help) {
    return parsed;
  }
  const value = (flag: string) => parsed.values.get(flag) ?? null;
  return {
    help: false,
    options: {
      output: value("--output"),
      profile: parsed.profile,
      stateDir: value("--state-dir"),
    },
  };
}
