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
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { parsePositiveInt, readPositiveEnvInt } from "./lib/numeric-options.mjs";

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

export type ShardTargetPlan = { kind: "target"; name: string; target: string };
type ShardGroupConfig = {
  configs: string[];
  env?: Record<string, unknown> | null;
  includePatterns?: string[] | null;
  shard_name?: string;
};
export type ShardGroupPlan = { kind: "group"; name: string; plan: ShardGroupConfig };
export type ShardPlan = ShardTargetPlan | ShardGroupPlan;
type RunShardOptions = {
  concurrency?: number;
  continueOnFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  fsModuleCacheMaxBytes?: number;
  nodeCompileCacheMaxBytes?: number;
  runChild?: typeof runChild;
  scratchDir?: string;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isShardGroupConfig(value: unknown): value is ShardGroupConfig {
  return isRecord(value) && isStringArray(value.configs);
}

function parseJsonEnv(
  env: Record<string, unknown>,
  name: string,
  fallback: unknown = null,
): unknown {
  try {
    const value = env[name];
    return typeof value === "string" ? (JSON.parse(value) ?? fallback) : fallback;
  } catch {
    return fallback;
  }
}

export function resolveShardPlans(env: NodeJS.ProcessEnv = process.env): ShardPlan[] {
  const targets = parseJsonEnv(env, "OPENCLAW_NODE_TEST_TARGETS_JSON");
  if (isStringArray(targets) && targets.length > 0) {
    // One target per child process preserves the isolation boundaries encoded
    // by full-suite include-pattern shards while keeping one runner job.
    return targets.map((target) => ({ kind: "target", name: target, target }));
  }

  const groups = parseJsonEnv(env, "OPENCLAW_NODE_TEST_GROUPS_JSON");
  const groupPlans = Array.isArray(groups) ? groups.filter(isShardGroupConfig) : [];
  const configs = parseJsonEnv(env, "OPENCLAW_NODE_TEST_CONFIGS_JSON", []);
  const groupEnv = parseJsonEnv(env, "OPENCLAW_NODE_TEST_ENV_JSON");
  const includePatterns = parseJsonEnv(env, "OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON");
  const plans: ShardGroupConfig[] =
    groupPlans.length > 0
      ? groupPlans
      : [
          {
            configs: isStringArray(configs) ? configs : [],
            env: isRecord(groupEnv) ? groupEnv : null,
            includePatterns: isStringArray(includePatterns) ? includePatterns : null,
            shard_name: env.OPENCLAW_VITEST_SHARD_NAME,
          },
        ];
  return plans.map((plan) => ({
    kind: "group",
    name: plan.shard_name ?? plan.configs?.[0] ?? "group",
    plan,
  }));
}

export function buildChildEnv(
  entry: ShardPlan,
  baseEnv: NodeJS.ProcessEnv,
  scratchDir: string,
  index: number,
  options: { serial?: boolean; cacheSlot?: number } = {},
) {
  const persistentCacheRoot = baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim();
  const cacheDirectory = persistentCacheRoot
    ? `vitest-cache-${options.cacheSlot ?? index}`
    : options.serial
      ? "vitest-cache-shared"
      : `vitest-cache-${index}`;
  const childEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    // Never give concurrent Vitest processes the same live directory. A
    // persistent backend is cloned per CI job, then split into stable worker
    // slots so serial plans on one worker reuse transforms without ENOTEMPTY
    // races. The scratch fallback preserves per-plan isolation.
    [FS_MODULE_CACHE_PATH_ENV_KEY]: join(persistentCacheRoot || scratchDir, cacheDirectory),
    OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
  };
  if (entry.kind === "group") {
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
  }
  return childEnv;
}

export function pruneFsModuleCache(root: string, maxBytes = FS_MODULE_CACHE_MAX_BYTES) {
  if (!root || !existsSync(root) || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return { beforeBytes: 0, afterBytes: 0, removedFiles: 0 };
  }

  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
  let totalBytes = 0;
  const visit = (directory: string) => {
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

export function clonePersistentCacheSlots(root: string | undefined, concurrency: number) {
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

function relayChildStream(stream: Readable, label: string) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const writeLine = (line: string) => {
    if (!process.stdout.write(`[shard:${label}] ${line}\n`)) {
      stream.pause();
      process.stdout.once("drain", () => stream.resume());
    }
  };
  stream.on("data", (chunk: Buffer | string) => {
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

const TEST_PROJECTS_ENTRYPOINTS = ["scripts/test-projects.mts", "scripts/test-projects.mjs"];

export function resolveTestProjectsEntrypoint(
  fileExists: (path: string) => boolean = existsSync,
): string {
  const entrypoint = TEST_PROJECTS_ENTRYPOINTS.find((candidate) => fileExists(candidate));
  if (!entrypoint) {
    throw new Error("CI target does not provide scripts/test-projects.mts or .mjs");
  }
  return entrypoint;
}

export function resolveShardChildCommand(
  args: string[],
  nodeExecPath = process.execPath,
  testProjectsEntrypoint = resolveTestProjectsEntrypoint(),
) {
  const loaderArgs = testProjectsEntrypoint.endsWith(".mts") ? ["--import", "tsx"] : [];
  return {
    command: nodeExecPath,
    args: [...loaderArgs, testProjectsEntrypoint, ...args],
  };
}

function runChild(args: string[], childEnv: NodeJS.ProcessEnv, label: string) {
  return new Promise<number>((resolve) => {
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

export async function runShardPlans(plans: ShardPlan[], options: RunShardOptions = {}) {
  const baseEnv = options.env ?? process.env;
  // Respect serial timing-sensitive bins and never clone cache slots that
  // cannot receive a plan.
  const concurrency = Math.min(
    plans.length,
    options.concurrency === undefined
      ? readPositiveEnvInt("OPENCLAW_NODE_TEST_PLAN_CONCURRENCY", baseEnv, PLAN_CONCURRENCY)
      : parsePositiveInt(options.concurrency, "Shard plan concurrency"),
  );
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
    while (nextIndex < plans.length && (exitCode === 0 || options.continueOnFailure)) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = plans[index];
      if (!entry) {
        return;
      }
      const targetArgs = entry.kind === "target" ? [entry.target] : entry.plan.configs;
      if (!Array.isArray(targetArgs) || targetArgs.length === 0) {
        console.error(`Missing node test shard configs for ${entry.name}`);
        exitCode = exitCode || 1;
        if (!options.continueOnFailure) {
          return;
        }
        continue;
      }
      const vitestExtraArgs = [
        baseEnv,
        entry.kind === "group" ? entry.plan.env : undefined,
      ].flatMap((env) => {
        const value = parseJsonEnv(env ?? {}, VITEST_EXTRA_ARGS_ENV_KEY, []);
        return isStringArray(value) ? value : [];
      });
      const args =
        vitestExtraArgs.length > 0 ? [...targetArgs, "--", ...vitestExtraArgs] : targetArgs;
      const childEnv = buildChildEnv(entry, baseEnv, scratchDir, index, {
        serial: concurrency === 1,
        cacheSlot,
      });
      const code = await runner(args, childEnv, entry.name);
      if (code !== 0) {
        // Ordinary CI stops scheduling after failure; cache warmers explicitly
        // continue so later groups still seed their independent transforms.
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
  process.exitCode = await runShardPlans(plans, {
    continueOnFailure: process.env.OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE === "1",
  });
}
