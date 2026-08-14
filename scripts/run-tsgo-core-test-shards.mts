#!/usr/bin/env node

// Run bounded test graphs in fresh processes so one shard's checker heap cannot
// accumulate while the next shard loads. Hold one lock across the full sequence.
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  resolveLocalHeavyCheckEnv,
} from "./lib/local-heavy-check-runtime.mts";
import { signalExitCode } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { selectTsgoCoreTestShards } from "./lib/tsgo-core-test-shards.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const requestedGroup = process.argv[2];
const shards = selectTsgoCoreTestShards(requestedGroup);
if (!shards) {
  console.error(`Unknown core test shard group: ${requestedGroup}`);
  process.exit(1);
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

try {
  for (const shard of shards) {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/run-tsgo.mjs"), "-b", shard.config, "--builders", "1"],
      {
        cwd: repoRoot,
        env: { ...env, OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
        stdio: "inherit",
      },
    );
    if (result.error) {
      throw result.error;
    }
    if (result.signal) {
      process.exitCode = signalExitCode(result.signal);
      break;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  releaseLock();
}
