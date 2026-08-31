import { CliUsageError, parseSqliteBenchmarkCli } from "./sqlite-benchmark-cli.js";
import type { CliOptions } from "./sqlite-reliability-contract.js";

const VALUE_FLAGS = new Set(["--agent", "--output", "--profile", "--repository", "--state-dir"]);

export { CliUsageError };

export function parseSqliteReliabilityCli(
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
      agentId: value("--agent"),
      output: value("--output"),
      profile: parsed.profile,
      repository: value("--repository"),
      stateDir: value("--state-dir"),
    },
  };
}
