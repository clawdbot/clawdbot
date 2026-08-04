// Runs one CI node test shard job: either explicit changed-test targets or a
// list of packed group plans. Extracted from .github/workflows/ci.yml so the
// execution policy is unit-testable and plans can run concurrently.
import { spawn } from "node:child_process";
import {
  constants,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { acquireLocalHeavyCheckLockSync } from "./lib/local-heavy-check-runtime.mjs";

// Two concurrent plans halve the serial tail of packed jobs. Children run with
// inner test-projects parallelism 1 so a job never exceeds two Vitest runs;
// stacking outer and inner parallelism oversubscribes the 4 vCPU runner class.
const PLAN_CONCURRENCY = 2;
const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const FS_MODULE_CACHE_WRITER_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER";
const NODE_COMPILE_CACHE_PATH_ENV_KEY = "NODE_COMPILE_CACHE";
const NODE_COMPILE_CACHE_WRITER_ENV_KEY = "OPENCLAW_NODE_COMPILE_CACHE_WRITER";
const VITEST_EXTRA_ARGS_ENV_KEY = "OPENCLAW_NODE_TEST_VITEST_ARGS_JSON";
const FS_MODULE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const NODE_COMPILE_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const FS_MODULE_CACHE_PRUNE_TARGET_RATIO = 0.75;
const FS_MODULE_CACHE_METADATA_FILE = "_metadata.json";
const FS_MODULE_CACHE_GENERATION_FILE = ".openclaw-transform-generation";

function parseJsonEnv(env, name, fallback = null) {
  try {
    return JSON.parse(env[name] ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

export function resolveShardPlans(env = process.env) {
  const targets = parseJsonEnv(env, "OPENCLAW_NODE_TEST_TARGETS_JSON");
  if (Array.isArray(targets) && targets.length > 0) {
    // One target per child process preserves the isolation boundaries encoded
    // by full-suite include-pattern shards while keeping one runner job.
    return targets.map((target) => ({ kind: "target", name: target, target }));
  }

  const groups = parseJsonEnv(env, "OPENCLAW_NODE_TEST_GROUPS_JSON");
  const plans =
    Array.isArray(groups) && groups.length > 0
      ? groups
      : [
          {
            configs: parseJsonEnv(env, "OPENCLAW_NODE_TEST_CONFIGS_JSON", []),
            env: parseJsonEnv(env, "OPENCLAW_NODE_TEST_ENV_JSON"),
            includePatterns: parseJsonEnv(env, "OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON"),
            shard_name: env.OPENCLAW_VITEST_SHARD_NAME,
          },
        ];
  return plans.map((plan) => ({
    kind: "group",
    name: plan.shard_name ?? plan.configs?.[0] ?? "group",
    plan,
  }));
}

export function buildChildEnv(entry, baseEnv, scratchDir, index, options = {}) {
  const persistentCacheRoot = baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim();
  const cacheDirectory = persistentCacheRoot
    ? `vitest-cache-${options.cacheSlot ?? index}`
    : options.serial
      ? "vitest-cache-shared"
      : `vitest-cache-${index}`;
  const childEnv = {
    ...baseEnv,
    // Never give concurrent Vitest processes the same live directory. A
    // persistent backend is cloned per CI job, then split into stable worker
    // slots so serial plans on one worker reuse transforms without ENOTEMPTY
    // races. The scratch fallback preserves per-plan isolation.
    [FS_MODULE_CACHE_PATH_ENV_KEY]: join(persistentCacheRoot || scratchDir, cacheDirectory),
    OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
    // This wrapper holds the repo heavy-check lock; children skipping it is
    // what lets two plans run concurrently instead of serializing on the lock.
    OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
  };
  if (entry.kind === "target") {
    return childEnv;
  }
  const plan = entry.plan;
  if (plan.shard_name) {
    childEnv.OPENCLAW_VITEST_SHARD_NAME = plan.shard_name;
  }
  if (plan.env && typeof plan.env === "object" && !Array.isArray(plan.env)) {
    for (const [key, value] of Object.entries(plan.env)) {
      if (typeof value === "string") {
        childEnv[key] = value;
      }
    }
  }
  if (Array.isArray(plan.includePatterns) && plan.includePatterns.length > 0) {
    const includeFile = join(scratchDir, `node-test-include-${index}.json`);
    writeFileSync(includeFile, JSON.stringify(plan.includePatterns), "utf8");
    childEnv.OPENCLAW_VITEST_INCLUDE_FILE = includeFile;
  } else {
    delete childEnv.OPENCLAW_VITEST_INCLUDE_FILE;
  }
  return childEnv;
}

export function pruneFsModuleCache(root, maxBytes = FS_MODULE_CACHE_MAX_BYTES) {
  if (!root || !existsSync(root) || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return { beforeBytes: 0, afterBytes: 0, removedFiles: 0 };
  }

  const files = [];
  let totalBytes = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fileStat = statSync(filePath);
      totalBytes += fileStat.size;
      if (
        entry.name !== FS_MODULE_CACHE_METADATA_FILE &&
        entry.name !== FS_MODULE_CACHE_GENERATION_FILE
      ) {
        files.push({ filePath, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
      }
    }
  };
  visit(root);

  const beforeBytes = totalBytes;
  if (totalBytes <= maxBytes) {
    return { beforeBytes, afterBytes: totalBytes, removedFiles: 0 };
  }

  const targetBytes = Math.floor(maxBytes * FS_MODULE_CACHE_PRUNE_TARGET_RATIO);
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let removedFiles = 0;
  for (const file of files) {
    if (totalBytes <= targetBytes) {
      break;
    }
    unlinkSync(file.filePath);
    totalBytes -= file.size;
    removedFiles += 1;
  }
  return { beforeBytes, afterBytes: totalBytes, removedFiles };
}

export function clonePersistentCacheSlots(root, concurrency) {
  if (!root || concurrency <= 1) {
    return 0;
  }
  const seed = join(root, "vitest-cache-0");
  if (!existsSync(seed)) {
    return 0;
  }

  let clonedSlots = 0;
  for (let cacheSlot = 1; cacheSlot < concurrency; cacheSlot += 1) {
    const destination = join(root, `vitest-cache-${cacheSlot}`);
    rmSync(destination, { force: true, recursive: true });
    // Clone before workers start. Reflinks make the common Linux path cheap;
    // unsupported filesystems transparently fall back to a regular copy.
    cpSync(seed, destination, {
      mode: constants.COPYFILE_FICLONE,
      recursive: true,
    });
    clonedSlots += 1;
  }
  return clonedSlots;
}

const MAX_PENDING_LINE_CHARS = 1_000_000;

function relayChildStream(stream, label) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const writeLine = (line) => {
    if (!process.stdout.write(`[shard:${label}] ${line}\n`)) {
      stream.pause();
      process.stdout.once("drain", () => stream.resume());
    }
  };
  stream.on("data", (chunk) => {
    pending += decoder.write(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      writeLine(line);
    }
    if (pending.length > MAX_PENDING_LINE_CHARS) {
      writeLine(pending);
      pending = "";
    }
  });
  return () => {
    pending += decoder.end();
    if (pending !== "") {
      writeLine(pending);
      pending = "";
    }
  };
}

export function resolveShardChildCommand(args, nodeExecPath = process.execPath) {
  return {
    command: nodeExecPath,
    args: ["scripts/test-projects.mjs", ...args],
  };
}

function runChild(args, childEnv, label) {
  return new Promise((resolve) => {
    // Use Node directly. `pnpm exec node` may reconcile the workspace before
    // tests, which destroys the sticky dependency fast path.
    const childCommand = resolveShardChildCommand(args);
    const child = spawn(childCommand.command, childCommand.args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Stream with a per-line label instead of buffering: children can run
    // whole suites for hours and verbose output must not accumulate on the
    // wrapper heap. Backpressure pauses the child stream while stdout drains,
    // and an oversized newline-free tail is force-flushed so the pending
    // partial line stays bounded too.
    const flushers = [child.stdout, child.stderr].map((stream) => relayChildStream(stream, label));
    process.stdout.write(`[shard:${label}] begin\n`);
    child.on("close", (code) => {
      for (const flush of flushers) {
        flush();
      }
      process.stdout.write(`[shard:${label}] end (exit ${code ?? 1})\n`);
      resolve(code ?? 1);
    });
    child.on("error", (error) => {
      process.stdout.write(`[shard:${label}] failed to spawn: ${error}\n`);
      resolve(1);
    });
  });
}

export async function runShardPlans(plans, options = {}) {
  const baseEnv = options.env ?? process.env;
  const vitestExtraArgs = parseJsonEnv(baseEnv, VITEST_EXTRA_ARGS_ENV_KEY, []);
  const concurrency = Math.max(1, options.concurrency ?? PLAN_CONCURRENCY);
  const runner = options.runChild ?? runChild;
  const scratchDir = options.scratchDir ?? mkdtempSync(join(tmpdir(), "openclaw-node-shard-"));
  const persistentCacheRoot = baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim();
  const nodeCompileCacheRoot = baseEnv[NODE_COMPILE_CACHE_PATH_ENV_KEY]?.trim();
  const clonedCacheSlots = clonePersistentCacheSlots(persistentCacheRoot, concurrency);
  if (clonedCacheSlots > 0) {
    process.stdout.write(
      `[shard:cache] cloned restored Vitest seed into ${clonedCacheSlots} isolated lane(s)\n`,
    );
  }

  let nextIndex = 0;
  let exitCode = 0;
  const workers = Array.from({ length: concurrency }, async (_, cacheSlot) => {
    while (nextIndex < plans.length && exitCode === 0) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = plans[index];
      const targetArgs = entry.kind === "target" ? [entry.target] : entry.plan.configs;
      if (!Array.isArray(targetArgs) || targetArgs.length === 0) {
        console.error(`Missing node test shard configs for ${entry.name}`);
        exitCode = exitCode || 1;
        return;
      }
      const args =
        Array.isArray(vitestExtraArgs) && vitestExtraArgs.length > 0
          ? [...targetArgs, "--", ...vitestExtraArgs]
          : targetArgs;
      const childEnv = buildChildEnv(entry, baseEnv, scratchDir, index, {
        serial: concurrency === 1,
        cacheSlot,
      });
      const code = await runner(args, childEnv, entry.name);
      if (code !== 0) {
        // Stop scheduling new plans after a failure; the in-flight sibling
        // finishes so its buffered output still lands in the job log.
        exitCode = exitCode || code;
      }
    }
  });
  await Promise.all(workers);
  if (persistentCacheRoot && baseEnv[FS_MODULE_CACHE_WRITER_ENV_KEY] === "1") {
    try {
      const pruned = pruneFsModuleCache(
        persistentCacheRoot,
        options.fsModuleCacheMaxBytes ?? FS_MODULE_CACHE_MAX_BYTES,
      );
      process.stdout.write(
        `[shard:cache] vitest ${pruned.beforeBytes} -> ${pruned.afterBytes} bytes; removed ${pruned.removedFiles} files\n`,
      );
    } catch (error) {
      console.warn(`[shard:cache] failed to prune Vitest cache: ${String(error)}`);
    }
  }
  if (nodeCompileCacheRoot && baseEnv[NODE_COMPILE_CACHE_WRITER_ENV_KEY] === "1") {
    try {
      const pruned = pruneFsModuleCache(
        nodeCompileCacheRoot,
        options.nodeCompileCacheMaxBytes ?? NODE_COMPILE_CACHE_MAX_BYTES,
      );
      process.stdout.write(
        `[shard:cache] node-compile ${pruned.beforeBytes} -> ${pruned.afterBytes} bytes; removed ${pruned.removedFiles} files\n`,
      );
    } catch (error) {
      console.warn(`[shard:cache] failed to prune Node compile cache: ${String(error)}`);
    }
  }
  return exitCode;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const plans = resolveShardPlans();
  // Bins holding spawn/signal-timing suites are marked planConcurrency 1 by
  // the planner; overlapping them with a sibling Vitest run causes flakes.
  const planConcurrency = Number(process.env.OPENCLAW_NODE_TEST_PLAN_CONCURRENCY) || undefined;
  const releaseLock = acquireLocalHeavyCheckLockSync({
    cwd: process.cwd(),
    env: process.env,
    toolName: "test",
  });
  try {
    process.exitCode = await runShardPlans(plans, { concurrency: planConcurrency });
  } finally {
    releaseLock();
  }
}
