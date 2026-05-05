import { runQaCoverageReportCommand } from "../extensions/qa-lab/src/cli.runtime.ts";

type Options = {
  json?: boolean;
  output?: string;
  repoRoot?: string;
};

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(args: string[]): Options {
  const opts: Options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(`Usage: openclaw qa coverage [options]

Options:
  --json                Print machine-readable JSON
  --output <path>       Write the report to a file
  --repo-root <path>    Repository root to target
  -h, --help            Display help
`);
        process.exit(0);
      case "--json":
        opts.json = true;
        break;
      case "--output":
        opts.output = takeValue(args, index, arg);
        index += 1;
        break;
      case "--repo-root":
        opts.repoRoot = takeValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown qa coverage option: ${arg}`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
await runQaCoverageReportCommand({
  ...(opts.json ? { json: true } : {}),
  ...(opts.output ? { output: opts.output } : {}),
  ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
});
