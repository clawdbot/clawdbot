// SQLite reliability stress proof exercises snapshots during concurrent writes.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CliOptions,
  ProfileId,
  ReliabilityReport,
} from "./lib/sqlite-reliability-contract.js";
import { runReliabilityStress } from "./lib/sqlite-reliability-runner.js";

const BOOLEAN_FLAGS = new Set(["--help"]);
const VALUE_FLAGS = new Set(["--agent", "--output", "--profile", "--repository", "--state-dir"]);

class CliUsageError extends Error {
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

function parseOptions(argv: string[]): CliOptions {
  return {
    agentId: parseFlagValue("--agent", argv) ?? null,
    output: parseFlagValue("--output", argv) ?? null,
    profile: parseProfile(parseFlagValue("--profile", argv)),
    repository: parseFlagValue("--repository", argv) ?? null,
    stateDir: parseFlagValue("--state-dir", argv) ?? null,
  };
}

function printUsage(): void {
  console.log(`OpenClaw SQLite reliability stress proof

Usage:
  node --import tsx scripts/bench-sqlite-reliability.ts [options]

Options:
  --profile <smoke|default|large>  Stress profile (default: default)
  --agent <id>                     Stress one per-agent database (default: global)
  --state-dir <path>               Reuse a state directory and retain proof artifacts
  --repository <path>              Snapshot repository path
  --output <path>                  Write machine-readable JSON report
  --help                           Show this text
`);
}

function printProofLines(report: ReliabilityReport): void {
  console.log(`SQLITE_RELIABILITY_PROFILE=${report.profile}`);
  console.log(`SQLITE_RELIABILITY_TARGET=${report.target}`);
  console.log(`SQLITE_RELIABILITY_PLATFORM=${report.platform}`);
  console.log(`SQLITE_RELIABILITY_ARCH=${report.arch}`);
  console.log(`SQLITE_RELIABILITY_ITERATIONS=${report.iterations}`);
  console.log(`SQLITE_RELIABILITY_RETAINED_BATCHES=${report.retainedBatches}`);
  console.log(
    `SQLITE_RELIABILITY_CONCURRENT_RESTORES_VERIFIED=${report.concurrentRestoresVerified}`,
  );
  console.log(`SQLITE_RELIABILITY_RESTORES_VERIFIED=${report.restoresVerified}`);
  console.log(`SQLITE_RELIABILITY_WRITER_ROWS=${report.writer.rowsCommitted}`);
  console.log(
    `SQLITE_RELIABILITY_WAL_SENTINEL=${report.transactionProof.committedWalSentinel ? "verified" : "missing"}`,
  );
  console.log(`SQLITE_RELIABILITY_HELD_BATCH=${report.transactionProof.heldBatch}`);
  console.log(`SQLITE_RELIABILITY_SNAPSHOT_P95_MS=${report.timingsMs.snapshotP95.toFixed(3)}`);
  console.log(`SQLITE_RELIABILITY_RESTORE_P95_MS=${report.timingsMs.restoreP95.toFixed(3)}`);
  console.log(`SQLITE_RELIABILITY_SNAPSHOT_BYTES_MAX=${report.snapshotBytes.max}`);
  console.log(
    `SQLITE_RELIABILITY_COMPACT_RECLAIMED_BYTES=${report.maintenanceProof.compaction.reclaimedBytes}`,
  );
  console.log(
    `SQLITE_RELIABILITY_POST_COMPACT_RESTORE=${report.maintenanceProof.postCompact.restoreVerified ? "verified" : "missing"}`,
  );
  console.log(`SQLITE_RELIABILITY_FINAL_ROWS=${report.maintenanceProof.postCompact.state.rows}`);
  console.log(
    `SQLITE_RELIABILITY_FINAL_STATE_SHA256=${report.maintenanceProof.postCompact.state.sha256}`,
  );
  console.log(`SQLITE_RELIABILITY_WAL_PEAK_BYTES=${report.walBytes.peak}`);
  console.log(`SQLITE_RELIABILITY_WAL_LIMIT_BYTES=${report.walBytes.limit}`);
}

async function main(argv: string[]): Promise<void> {
  try {
    validateArgs(argv);
    if (argv.includes("--help")) {
      printUsage();
      return;
    }
    const options = parseOptions(argv);
    const report = await runReliabilityStress(options);
    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    printProofLines(report);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`error: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}
