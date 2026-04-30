import { runQaParityReportCommand } from "../extensions/qa-lab/src/cli.runtime.ts";

type Options = {
  baselineLabel?: string;
  baselineSummary?: string;
  candidateLabel?: string;
  candidateSummary?: string;
  outputDir?: string;
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
        process.stdout.write(`Usage: openclaw qa parity-report [options]

Options:
  --candidate-summary <path>  Candidate qa-suite-summary.json path
  --baseline-summary <path>   Baseline qa-suite-summary.json path
  --candidate-label <label>   Candidate display label
  --baseline-label <label>    Baseline display label
  --repo-root <path>          Repository root to target
  --output-dir <path>         Artifact directory for the parity report
  -h, --help                  Display help
`);
        process.exit(0);
      case "--baseline-label":
        opts.baselineLabel = takeValue(args, index, arg);
        index += 1;
        break;
      case "--baseline-summary":
        opts.baselineSummary = takeValue(args, index, arg);
        index += 1;
        break;
      case "--candidate-label":
        opts.candidateLabel = takeValue(args, index, arg);
        index += 1;
        break;
      case "--candidate-summary":
        opts.candidateSummary = takeValue(args, index, arg);
        index += 1;
        break;
      case "--output-dir":
        opts.outputDir = takeValue(args, index, arg);
        index += 1;
        break;
      case "--repo-root":
        opts.repoRoot = takeValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown qa parity-report option: ${arg}`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.candidateSummary) {
  throw new Error("--candidate-summary is required.");
}
if (!opts.baselineSummary) {
  throw new Error("--baseline-summary is required.");
}

await runQaParityReportCommand({
  baselineSummary: opts.baselineSummary,
  candidateSummary: opts.candidateSummary,
  ...(opts.baselineLabel ? { baselineLabel: opts.baselineLabel } : {}),
  ...(opts.candidateLabel ? { candidateLabel: opts.candidateLabel } : {}),
  ...(opts.outputDir ? { outputDir: opts.outputDir } : {}),
  ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
});
