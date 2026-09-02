#!/usr/bin/env node

// Run bounded test graphs in fresh processes so one shard's checker heap cannot
// accumulate while the next shard loads.
import path from "node:path";
import type { CoreTsgoGraph } from "./check-tsgo-core-boundary.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import { resolveLocalCheckEnv } from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  selectTsgoCoreTestShards,
  selectChangedTsgoCoreTestShards,
  TSGO_CORE_TEST_SHARDS,
  selectTsgoCoreTestStripe,
} from "./lib/tsgo-core-test-shards.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
function runShard(config: string, env: NodeJS.ProcessEnv): Promise<number> {
  return runManagedCommand({
    bin: process.execPath,
    args: distArtifactEntryArgs(path.join(repoRoot, "scripts/run-tsgo.mts"), [
      "-b",
      config,
      "--builders",
      "1",
    ]),
    cwd: repoRoot,
    env,
    requireProcessTreeExit: process.platform !== "win32",
  });
}

/** Runs selected canonical graphs under the same output and child-process owner. */
async function runTsgoCoreTestShards(
  shards: readonly { name: string; config: string }[],
  options: { concurrency?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const concurrency = options.concurrency ?? 1;
  const env = resolveLocalCheckEnv(options.env ?? process.env);
  // The batch owns outputs once; its existing compiler concurrency stays intact
  // without children waiting to reacquire their parent's lock.
  return await withDistArtifactOwnership(repoRoot, async () => {
    const queue = [...shards];
    let failureCode = 0;
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const shard = queue.shift();
        // Stop draining after the first failure so the exit stays prompt.
        if (!shard || failureCode !== 0) {
          return;
        }
        const code = await runShard(shard.config, env).catch((error: unknown) => {
          failureCode = 1;
          throw error;
        });
        if (code !== 0 && failureCode === 0) {
          failureCode = code;
        }
      }
    });
    const results = await Promise.allSettled(workers);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "tsgo core test shards failed");
    }
    return failureCode;
  });
}

/** Owns one changed-check execution; plans never retain compiler inventories. */
export function createChangedCoreTestCheck(paths: readonly string[], env: NodeJS.ProcessEnv) {
  let graphs: CoreTsgoGraph[] | undefined;
  return {
    async checkBoundary(): Promise<number> {
      graphs = undefined;
      const { checkCoreTsgoGraphBoundary, CoreTsgoBoundaryInterruptedError } =
        await import("./check-tsgo-core-boundary.mts");
      try {
        graphs = await checkCoreTsgoGraphBoundary();
        return 0;
      } catch (error) {
        if (error instanceof CoreTsgoBoundaryInterruptedError) {
          console.error(error.message);
          return error.exitCode;
        }
        throw error;
      }
    },
    async checkTypes(): Promise<number> {
      const inspected = graphs;
      graphs = undefined;
      const shards = inspected && selectChangedTsgoCoreTestShards(paths, inspected);
      const selected = shards ?? TSGO_CORE_TEST_SHARDS;
      console.error(
        `[check:changed] core test graphs: ${selected.map((shard) => shard.name).join(", ")}`,
      );
      return await runTsgoCoreTestShards(selected, { env });
    },
  };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
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

  process.exitCode = await runTsgoCoreTestShards(shards, { concurrency });
}
