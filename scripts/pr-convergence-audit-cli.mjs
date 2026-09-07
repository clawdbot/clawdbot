import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { auditPrConvergence, CONVERGENCE_DECISIONS } from "./pr-convergence-audit.mjs";
import {
  createGhPrConvergenceProvider,
  resolveCurrentGitHubRepo,
} from "./pr-convergence-provider.mjs";

function parseArgs(argv) {
  let repo = null;
  let pr = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") {
      repo = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (value?.startsWith("--")) {
      throw new Error(`unknown option: ${value}`);
    }
    if (pr !== null || !/^\d+$/.test(value ?? "") || Number(value) < 1) {
      throw new Error("usage: node scripts/pr-convergence-audit-cli.mjs <PR> [--repo OWNER/REPO]");
    }
    pr = Number(value);
  }
  if (pr === null) {
    throw new Error("usage: node scripts/pr-convergence-audit-cli.mjs <PR> [--repo OWNER/REPO]");
  }
  return { pr, repo };
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]
 * @param {ReturnType<typeof createGhPrConvergenceProvider>} [options.provider]
 * @param {() => string} [options.resolveRepo]
 * @param {(text: string) => void} [options.write]
 */
export async function runPrConvergenceAuditCli({
  argv = process.argv.slice(2),
  provider = createGhPrConvergenceProvider(),
  resolveRepo = resolveCurrentGitHubRepo,
  write = (value) => process.stdout.write(value),
} = {}) {
  const parsed = parseArgs(argv);
  const repo = parsed.repo ?? resolveRepo();
  const result = await auditPrConvergence({ repo, pr: parsed.pr, provider });
  write(`${JSON.stringify(result, null, 2)}\n`);
  return result.decision === CONVERGENCE_DECISIONS.READY ? 0 : 1;
}

/** @param {unknown} error */
function reportDirectRunFailure(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  runPrConvergenceAuditCli()
    .then((status) => {
      process.exitCode = status;
    })
    .catch(reportDirectRunFailure);
}
