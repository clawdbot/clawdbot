// Local declaration ownership is disjoint from packaged tsdown declarations.
import fs from "node:fs";
import path, { resolve } from "node:path";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "../packages/normalization-core/src/number-coercion.ts";
import {
  listCacheFiles,
  portableRelativePath,
  readArtifactRecord,
  writeArtifactRecord,
} from "./lib/build-artifact-cache.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import {
  BOUNDARY_CACHE_ROOT,
  BOUNDARY_PLUGIN_UNITS,
  LOCAL_PLUGIN_ROOT,
  LOCAL_SDK_ROOT,
  BoundaryInputSnapshot,
} from "./lib/extension-boundary-inputs.mts";
import { ensureRepoNodeModulesLink, isLocalCheckEnabled } from "./lib/local-check-runtime.mts";
import { runManagedCommand, signalExitCode } from "./lib/managed-child-process.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { pluginSdkEntrypoints } from "./lib/plugin-sdk-entries.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { prepareTsgoCommand } from "./run-tsgo.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const runTsgoScript = path.join(repoRoot, "scripts/run-tsgo.mts");
const DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS = 1_000;
type NodeStepParams = {
  bin?: string;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
  abortController?: AbortController;
  abortKillGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => boolean;
};
type NodeStep = Omit<NodeStepParams, "abortController"> & {
  args: string[];
  label: string;
  timeoutMs: number;
};
const activeNodeSteps = new Set<Promise<number>>();
let nodeStepParentSignal: NodeJS.Signals | undefined;
export function parseMode(argv: string[] = process.argv.slice(2)) {
  const mode = argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ?? "all";
  if (mode !== "all" && mode !== "package-boundary") {
    throw new Error(`Unknown mode: ${mode}`);
  }
  return mode;
}
export function resolveBoundaryRootShimsTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS?.trim();
  return raw
    ? parsePositiveInt(raw, "OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS")
    : 300_000;
}
/**
 * Prefixes streamed child output line-by-line without breaking partial chunks.
 */
export function createPrefixedOutputWriter(
  label: string,
  target: { write(chunk: string): void },
  onLine?: (line: string) => boolean,
) {
  let buffered = "";
  const prefix = `[${label}] `;

  return {
    write(chunk: string) {
      buffered += chunk;
      while (true) {
        const newlineIndex = buffered.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const line = buffered.slice(0, newlineIndex + 1);
        buffered = buffered.slice(newlineIndex + 1);
        if (onLine?.(line) !== false) {
          target.write(`${prefix}${line}`);
        }
      }
    },
    flush() {
      if (!buffered) {
        return;
      }
      target.write(`${prefix}${buffered}`);
      buffered = "";
    },
  };
}

/** Runs a declaration step through the shared managed lifecycle with prefixed output. */
export async function runNodeStep(
  label: string,
  args: string[],
  timeoutMs: number,
  params: NodeStepParams = {},
) {
  if (params.abortController?.signal.aborted || nodeStepParentSignal) {
    throw new Error(`${label} canceled before starting`);
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, MAX_TIMER_TIMEOUT_MS);
  const stdoutWriter = createPrefixedOutputWriter(label, process.stdout, params.onStdoutLine);
  const stderrWriter = createPrefixedOutputWriter(label, process.stderr);
  const command = runManagedCommand({
    bin: params.bin ?? process.execPath,
    args,
    cwd: repoRoot,
    env: params.env ? { ...process.env, ...params.env } : process.env,
    shell: params.shell ?? false,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
    stdio: ["ignore", "pipe", "pipe"],
    // Artifact writers must finish before stamps, dependent readers, or lock release.
    requireProcessTreeExit: process.platform !== "win32",
    timeoutMs: resolvedTimeoutMs,
    signal: params.abortController?.signal,
    abortKillGraceMs: Math.max(
      0,
      Math.floor(params.abortKillGraceMs ?? DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS),
    ),
    onSignal(signal) {
      nodeStepParentSignal ??= signal;
    },
    onReady(child) {
      // This invocation explicitly requests both output pipes above.
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => stdoutWriter.write(chunk));
      child.stderr!.on("data", (chunk: string) => stderrWriter.write(chunk));
    },
  });
  activeNodeSteps.add(command);
  try {
    const code = await command;
    if (code !== 0) {
      throw new Error(`${label} failed with exit code ${code}`);
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const failure =
      code === "ETIMEDOUT"
        ? new Error(`${label} timed out after ${resolvedTimeoutMs}ms`, { cause: error })
        : code === "ABORT_ERR"
          ? new Error(`${label} canceled after sibling failure`, { cause: error })
          : error;
    if (nodeStepParentSignal && code === "EPROCESSGROUP_CLEANUP_FAILED") {
      console.error(failure);
    }
    if (params.abortController && !params.abortController.signal.aborted) {
      params.abortController.abort(failure);
    }
    throw failure;
  } finally {
    stdoutWriter.flush();
    stderrWriter.flush();
    activeNodeSteps.delete(command);
    // The last sibling exits only after all managed cancellation has joined.
    if (nodeStepParentSignal && activeNodeSteps.size === 0) {
      process.exit(signalExitCode(nodeStepParentSignal));
    }
  }
}

/**
 * Runs independent artifact steps together and aborts siblings on first failure.
 */
export async function runNodeStepsInParallel(steps: NodeStep[]) {
  const abortController = new AbortController();
  const results = await Promise.allSettled(
    steps.map((step) =>
      runNodeStep(step.label, step.args, step.timeoutMs, {
        ...step,
        abortController,
      }),
    ),
  );
  const failures: unknown[] = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    const primary = abortController.signal.reason ?? failures[0];
    const cleanupFailures = failures.filter(
      (error: unknown) =>
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPROCESSGROUP_CLEANUP_FAILED" &&
        error !== primary,
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primary, ...cleanupFailures],
        `${primary instanceof Error ? primary.message : String(primary)}; sibling cleanup could not be verified`,
      );
    }
    throw primary;
  }
}

/**
 * Chooses serial or parallel artifact execution based on local check policy.
 */
export async function runNodeSteps(steps: NodeStep[], env: NodeJS.ProcessEnv = process.env) {
  if (!isLocalCheckEnabled(env)) {
    await runNodeStepsInParallel(steps);
    return;
  }

  for (const step of steps) {
    await runNodeStep(step.label, step.args, step.timeoutMs, step);
  }
}

async function runTsgoSteps(steps: NodeStep[]) {
  const commands = steps.flatMap((step) => {
    const command = prepareTsgoCommand(step.args, step.env ?? process.env, repoRoot);
    return command
      ? [
          {
            ...step,
            ...command,
            timeoutMs: Math.min(step.timeoutMs, command.timeoutMs ?? step.timeoutMs),
          },
        ]
      : [];
  });
  // The native bin stays in this owner's group; no nested CLI supervisor can escape its join.
  await runNodeSteps(commands);
  return new Set(commands.map((command) => command.label));
}

async function prepareExtensionPackageBoundaryArtifacts(argv: string[] = process.argv.slice(2)) {
  const mode = parseMode(argv);
  const sdk = {
    id: "plugin-sdk",
    outDir: LOCAL_SDK_ROOT,
    config: "packages/plugin-sdk/tsconfig.json",
    rootDir: ".",
    required: pluginSdkEntrypoints.map((entry) => `${LOCAL_SDK_ROOT}/src/plugin-sdk/${entry}.d.ts`),
  };
  const plugins = BOUNDARY_PLUGIN_UNITS.map(([id, entry]) => ({
    id,
    outDir: `${LOCAL_PLUGIN_ROOT}/${id}`,
    config: `extensions/${id}/tsconfig.json`,
    rootDir: `extensions/${id}`,
    required: [`${LOCAL_PLUGIN_ROOT}/${id}/${entry}.d.ts`],
  }));
  const batches = [[sdk], mode === "all" ? plugins : []].map((batch) =>
    batch.map((unit) => {
      fs.mkdirSync(resolve(repoRoot, unit.outDir), { recursive: true });
      if (unit.id !== "plugin-sdk") {
        // Relocated declarations still resolve third-party types through their package owner.
        ensureRepoNodeModulesLink(resolve(repoRoot, unit.rootDir, "node_modules"), {
          cwd: resolve(repoRoot, unit.outDir),
        });
      }
      return { ...unit, outputRoot: fs.realpathSync.native(resolve(repoRoot, unit.outDir)) };
    }),
  );
  for (const batch of batches) {
    if (!batch.length) {
      continue;
    }
    // Upstream pruning changes consumer topology; snapshot after the preceding batch's cleanup.
    const before = new BoundaryInputSnapshot(repoRoot);
    const pending = batch
      .map((unit) => {
        const recordPath = resolve(repoRoot, BOUNDARY_CACHE_ROOT, `${unit.id}.json`);
        const buildInfo = `${unit.outDir}/.tsbuildinfo`;
        const args = [
          runTsgoScript,
          "-p",
          unit.config,
          "--declaration",
          "true",
          "--emitDeclarationOnly",
          "true",
          "--noEmit",
          "false",
          "--outDir",
          unit.outDir,
          "--rootDir",
          unit.rootDir,
          "--incremental",
          "--tsBuildInfoFile",
          buildInfo,
          "--listEmittedFiles",
        ];
        const previous = readArtifactRecord(recordPath);
        // Prime config/toolchain/topology before starting even an uncached owner.
        before.signature(unit.config, args, [], unit.outputRoot);
        if (
          before.matches(
            previous,
            unit.config,
            args,
            [...unit.required, buildInfo],
            unit.outputRoot,
          )
        ) {
          process.stdout.write(`[${unit.id} boundary dts] fresh; skipping\n`);
          return null;
        }
        fs.rmSync(recordPath, { force: true });
        // Historical Matrix/Slack repair: every stale owner gets a full native emit.
        // Output directories stay intact until a successful complete inventory exists.
        fs.rmSync(resolve(repoRoot, buildInfo), { force: true });
        const outputs = new Set<string>();
        return Object.assign(unit, { recordPath, buildInfo, args, outputs, startedAt: 0 });
      })
      .filter((unit) => unit !== null);
    const emitted = await runTsgoSteps(
      pending.map((unit) => {
        unit.startedAt = Date.now();
        return {
          label: `${unit.id} boundary dts`,
          args: unit.args.slice(1),
          timeoutMs: unit.id === "plugin-sdk" ? resolveBoundaryRootShimsTimeoutMs() : 300_000,
          onStdoutLine(line: string) {
            if (!line.startsWith("TSFILE: ")) {
              return true;
            }
            unit.outputs.add(portableRelativePath(repoRoot, line.slice(8).trim()));
            return false;
          },
        };
      }),
    );
    if (!pending.length) {
      continue;
    }
    const after = new BoundaryInputSnapshot(repoRoot);
    // Join and validate every owner before publishing any success in this batch.
    const completed = pending
      .filter((unit) => emitted.has(`${unit.id} boundary dts`))
      .map((unit) => {
        const outputs = [...unit.outputs].toSorted();
        if (
          [...unit.required, unit.buildInfo].some((file) => !unit.outputs.has(file)) ||
          outputs.some((file) => !file.startsWith(`${unit.outDir}/`))
        ) {
          throw new Error(`Incomplete ${unit.id} native declaration inventory`);
        }
        const record = after.record(
          unit.config,
          unit.args,
          unit.buildInfo,
          outputs,
          before,
          unit.startedAt,
          unit.outputRoot,
        );
        return Object.assign(unit, { record });
      });
    for (const unit of completed) {
      // Surviving files are cleanup candidates, never evidence of successful emit.
      for (const file of listCacheFiles(
        repoRoot,
        [{ path: unit.outDir, extensions: [".d.ts", ".d.mts", ".d.cts"] }],
        fs,
      )) {
        if (!unit.outputs.has(portableRelativePath(repoRoot, file))) {
          fs.rmSync(file);
        }
      }
      writeArtifactRecord(unit.recordPath, unit.record);
      process.stdout.write(`[${unit.id} boundary dts] emitted ${unit.outputs.size} files\n`);
    }
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  // The private entry must observe cleanup metadata before releasing its claim.
  await withDistArtifactOwnership(repoRoot, () => prepareExtensionPackageBoundaryArtifacts());
}
