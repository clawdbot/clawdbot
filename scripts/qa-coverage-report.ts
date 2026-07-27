// Qa Coverage Report script supports OpenClaw repository automation.
import { booleanFlag, parseFlagArgs, stringFlag, stringListFlag } from "./lib/arg-utils.mjs";

type Options = {
  json?: boolean;
  match?: string[];
  output?: string;
  repoRoot?: string;
  summary?: string;
  tools?: boolean;
};

function parseArgs(args: string[]): Options {
  return parseFlagArgs(
    args,
    {},
    [
      booleanFlag("--json", "json"),
      stringListFlag("--match", "match", { rejectShortOptions: true }),
      stringFlag("--output", "output", { rejectShortOptions: true }),
      stringFlag("--repo-root", "repoRoot", { rejectShortOptions: true }),
      stringFlag("--summary", "summary", { rejectShortOptions: true }),
      booleanFlag("--tools", "tools"),
    ],
    {
      onUnhandledArg(arg: string) {
        if (arg !== "--help" && arg !== "-h") {
          throw new Error(`Unknown qa coverage option: ${arg}`);
        }
        process.stdout.write(`Usage: openclaw qa coverage [options]

Options:
  --json                Print machine-readable JSON
  --match <query>       Search scenario metadata and print matching suite targets
  --output <path>       Write the report to a file
  --repo-root <path>    Repository root to target
  --summary <path>      Runtime qa-suite-summary.json to overlay on --tools coverage
  --tools               Print runtime tool fixture coverage instead of scenario coverage
  -h, --help            Display help
`);
        process.exit(0);
      },
    },
  ) as Options;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const { runQaCoverageReportCommand } = await import("../extensions/qa-lab/src/cli.runtime.ts");
  await runQaCoverageReportCommand({
    ...(opts.json ? { json: true } : {}),
    ...(opts.match ? { match: opts.match } : {}),
    ...(opts.output ? { output: opts.output } : {}),
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
    ...(opts.summary ? { summary: opts.summary } : {}),
    ...(opts.tools ? { tools: true } : {}),
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
