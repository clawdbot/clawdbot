import { runQaCoverageReportCommand } from "../extensions/qa-lab/src/cli.runtime.ts";

type Options = {
  json?: boolean;
  match?: string[];
  output?: string;
  repoRoot?: string;
  summary?: string;
  tools?: boolean;
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
  --match <query>       Search scenario metadata and print matching suite targets
  --output <path>       Write the report to a file
  --repo-root <path>    Repository root to target
  --summary <path>      Runtime qa-suite-summary.json to overlay on --tools coverage
  --tools               Print runtime tool fixture coverage instead of scenario coverage
  -h, --help            Display help
`);
        process.exit(0);
      case "--json":
        opts.json = true;
        break;
      case "--match":
        opts.match ??= [];
        opts.match.push(takeValue(args, index, arg));
        index += 1;
        break;
      case "--output":
        opts.output = takeValue(args, index, arg);
        index += 1;
        break;
      case "--repo-root":
        opts.repoRoot = takeValue(args, index, arg);
        index += 1;
        break;
      case "--summary":
        opts.summary = takeValue(args, index, arg);
        index += 1;
        break;
      case "--tools":
        opts.tools = true;
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
  ...(opts.match ? { match: opts.match } : {}),
  ...(opts.output ? { output: opts.output } : {}),
  ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
  ...(opts.summary ? { summary: opts.summary } : {}),
  ...(opts.tools ? { tools: true } : {}),
});
