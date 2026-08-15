#!/usr/bin/env node

// Run bounded test graphs in fresh processes so one shard's checker heap cannot
// accumulate while the next shard loads. Hold one lock across the full sequence.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  resolveLocalHeavyCheckEnv,
} from "./lib/local-heavy-check-runtime.mts";
import { signalExitCode } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  selectTsgoCoreTestShards,
  selectTsgoCoreTestStripe,
} from "./lib/tsgo-core-test-shards.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
// CI stripes split the serial shard sequence across parallel jobs; the
// stripe union is exactly the full shard list, so coverage is unchanged.
const stripeFlagIndex = process.argv.indexOf("--stripe");
let shards;
if (stripeFlagIndex >= 0) {
  const stripeSpec = process.argv[stripeFlagIndex + 1] ?? "";
  shards = selectTsgoCoreTestStripe(stripeSpec);
  if (!shards) {
    console.error(`Invalid core test stripe (expected i/n): ${stripeSpec}`);
    process.exit(1);
  }
} else {
  const requestedGroup = process.argv[2];
  shards = selectTsgoCoreTestShards(requestedGroup);
  if (!shards) {
    console.error(`Unknown core test shard group: ${requestedGroup}`);
    process.exit(1);
  }
}
// Each graph is a serial single-project build, so tsgo gains little past four
// cores; CI stripe jobs opt into overlapping fresh child processes to use the
// idle cores. Local runs stay serial to keep the heap-bounded default.
const concurrencyFlagIndex = process.argv.indexOf("--concurrency");
let concurrency = 1;
if (concurrencyFlagIndex >= 0) {
  const rawConcurrency = process.argv[concurrencyFlagIndex + 1] ?? "";
  concurrency = Number(rawConcurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    console.error(`Invalid shard concurrency (expected 1-4): ${rawConcurrency}`);
    process.exit(1);
  }
}
const env = resolveLocalHeavyCheckEnv(process.env);
const releaseLock =
  env.OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD === "1"
    ? () => {}
    : acquireLocalHeavyCheckLockSync({
        cwd: repoRoot,
        env,
        toolName: "tsgo:core:test",
      });

function runShard(config: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [path.join(repoRoot, "scripts/run-tsgo.mjs"), "-b", config, "--builders", "1"],
      {
        cwd: repoRoot,
        env: { ...env, OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
        stdio: "inherit",
      },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve(signal ? signalExitCode(signal) : (code ?? 1));
    });
  });
}

try {
  const queue = [...shards];
  let failureCode = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const shard = queue.shift();
      // Stop draining after the first failure so the exit stays prompt.
      if (!shard || failureCode !== 0) {
        return;
      }
      const code = await runShard(shard.config);
      if (code !== 0 && failureCode === 0) {
        failureCode = code;
      }
    }
  });
  await Promise.all(workers);
  if (failureCode !== 0) {
    process.exitCode = failureCode;
  }
} finally {
  releaseLock();
}
