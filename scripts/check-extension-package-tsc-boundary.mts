#!/usr/bin/env node

// Verifies extension packages compile through their package-local TypeScript boundary.
import { spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path, { dirname, join, resolve } from "node:path";
import pMap from "p-map";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "../packages/normalization-core/src/number-coercion.ts";
import { toErrorObject } from "./lib/error-format.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mts";

type BoundaryMode = "all" | "compile" | "canary";
type StepOutputCapture = { text: string; truncatedChars: number };
type CompileTiming = { extensionId: string; elapsedMs: number };
type SkippedCompileParams = { skippedCount?: number; totalCount?: number };
type SlowCompileParams = { compileTimings?: CompileTiming[]; limit?: number };
type BoundarySummaryParams = {
  mode?: BoundaryMode;
  compileCount?: number;
  skippedCompileCount?: number;
  canaryCount?: number;
  prepElapsedMs?: number;
  compileElapsedMs?: number;
  canaryElapsedMs?: number;
  elapsedMs?: number;
};
type CompileFreshnessParams = {
  rootDir?: string;
  extensionNewestInputMtimeMs?: number;
  sharedNewestInputMtimeMs?: number;
};
type StepFailureParams = {
  stdout?: string;
  stderr?: string;
  kind?: string;
  elapsedMs?: number;
  note?: string;
};
type StepResult = { stdout: string; stderr: string; elapsedMs: number };
type StepChildPipe = {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: unknown) => void): unknown;
};
type StepChild = {
  pid?: number;
  stdout: StepChildPipe | null;
  stderr: StepChildPipe | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
};
type StepSpawnOptions = NonNullable<Parameters<typeof spawn>[2]> & {
  stdio: ["ignore", "pipe", "pipe"];
};
type StepSpawn = (command: string, args: string[], options: StepSpawnOptions) => StepChild;
type RunNodeStepParams = {
  abortController?: AbortController;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  onFailure?: (error: ReturnType<typeof attachStepFailureMetadata>) => void;
  platform?: NodeJS.Platform;
  spawnImpl?: StepSpawn;
};
type BoundaryStep = {
  label: string;
  args: string[];
  timeoutMs: number;
  onStart?: () => void;
  onSuccess?: (result: StepResult) => void;
};
type BoundaryCheckParams = { rootDir?: string; processObject?: Pick<EventEmitter, "on" | "off"> };
type VitestProcessSignal = Exclude<
  Parameters<typeof forwardSignalToVitestProcessGroup>[0]["signal"],
  0
>;

const require = createRequire(import.meta.url);
const repoRoot = resolveRepoRoot(import.meta.url);
const tscBin = require.resolve("typescript/bin/tsc");
const nativePreviewPackageJsonPath = require.resolve("@typescript/native-preview/package.json");
const nativePreviewPackageJson = JSON.parse(readFileSync(nativePreviewPackageJsonPath, "utf8"));
const nativePreviewBin = nativePreviewPackageJson.bin?.tsgo;
if (typeof nativePreviewBin !== "string") {
  throw new Error("@typescript/native-preview does not declare the tsgo binary");
}
const tsgoBin = resolve(dirname(nativePreviewPackageJsonPath), nativePreviewBin);
const prepareBoundaryArtifactsArgs = [
  "--import",
  "tsx",
  resolve(repoRoot, "scripts/prepare-extension-package-boundary-artifacts.mts"),
];
const extensionPackageBoundaryBaseConfig = "../tsconfig.package-boundary.base.json";
const FAILURE_OUTPUT_TAIL_LINES = 40;
const STEP_OUTPUT_MAX_CHARS = 256 * 1024;
const STEP_PROCESS_GROUP_EXIT_POLL_MS = 25;
const STEP_POST_FORCE_KILL_WAIT_MS = 1_000;
const SLOW_COMPILE_SUMMARY_LIMIT = 10;
const COMPILE_INPUT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".json"]);
const ROOTDIR_BOUNDARY_CANARY_IMPORT_PATH =
  "../../src/plugins/contracts/rootdir-boundary-canary.ts";
const ROOTDIR_BOUNDARY_CANARY_OUTPUT_HINT = "src/plugins/contracts/rootdir-boundary-canary.ts";

function parseMode(argv: string[]): BoundaryMode {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "all";
  if (mode !== "all" && mode !== "compile" && mode !== "canary") {
    throw new Error(`Unknown mode: ${mode}`);
  }
  return mode;
}

/**
 * Resolves the compile worker count from CLI/env/default settings.
 */
export function resolveCompileConcurrency(
  env: NodeJS.ProcessEnv = process.env,
  availableParallelism = os.availableParallelism(),
) {
  const raw = env.OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY?.trim();
  if (raw) {
    return parsePositiveInt(raw, "OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY");
  }
  return Math.max(1, Math.min(6, Math.floor(availableParallelism / 2)));
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function summarizeOutputSection(name: string, output: string) {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split("\n");
  if (lines.length <= FAILURE_OUTPUT_TAIL_LINES) {
    return `${name}:\n${trimmed}`;
  }

  const omittedLineCount = lines.length - FAILURE_OUTPUT_TAIL_LINES;
  const tail = lines.slice(-FAILURE_OUTPUT_TAIL_LINES).join("\n");
  return `${name}:\n[... ${omittedLineCount} earlier lines omitted ...]\n${tail}`;
}

function formatFailureFooter(params: StepFailureParams = {}) {
  const footerLines: string[] = [];
  if (params.kind) {
    footerLines.push(`kind: ${params.kind}`);
  }
  if (Number.isFinite(params.elapsedMs)) {
    footerLines.push(`elapsed: ${params.elapsedMs}ms`);
  }
  if (params.note) {
    footerLines.push(params.note);
  }
  return footerLines.join("\n");
}

function createStepOutputCapture(): StepOutputCapture {
  return { text: "", truncatedChars: 0 };
}

/**
 * Appends child-process output while preserving only the diagnostic tail.
 */
export function appendBoundedStepOutput(
  buffer: StepOutputCapture,
  chunk: unknown,
  maxChars = STEP_OUTPUT_MAX_CHARS,
) {
  const nextText = buffer.text + String(chunk);
  if (nextText.length <= maxChars) {
    return { text: nextText, truncatedChars: buffer.truncatedChars };
  }
  const truncatedChars = buffer.truncatedChars + nextText.length - maxChars;
  return { text: nextText.slice(-maxChars), truncatedChars };
}

function formatCapturedStepOutput(buffer: StepOutputCapture) {
  if (buffer.truncatedChars === 0) {
    return buffer.text;
  }
  return `[output truncated ${buffer.truncatedChars} chars; showing tail]\n${buffer.text}`;
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Formats the successful boundary compile summary.
 */
export function formatBoundaryCheckSuccessSummary(params: BoundarySummaryParams = {}) {
  const lines = ["extension package boundary check passed"];
  if (params.mode) {
    lines.push(`mode: ${params.mode}`);
  }
  if (Number.isInteger(params.compileCount)) {
    lines.push(`compiled plugins: ${params.compileCount}`);
  }
  if (isPositiveInteger(params.skippedCompileCount)) {
    lines.push(`skipped plugins: ${params.skippedCompileCount}`);
  }
  if (Number.isInteger(params.canaryCount)) {
    lines.push(`canary plugins: ${params.canaryCount}`);
  }
  if (isPositiveFinite(params.prepElapsedMs)) {
    lines.push(`prep elapsed: ${params.prepElapsedMs}ms`);
  }
  if (isPositiveFinite(params.compileElapsedMs)) {
    lines.push(`compile elapsed: ${params.compileElapsedMs}ms`);
  }
  if (isPositiveFinite(params.canaryElapsedMs)) {
    lines.push(`canary elapsed: ${params.canaryElapsedMs}ms`);
  }
  if (Number.isFinite(params.elapsedMs)) {
    lines.push(`elapsed: ${params.elapsedMs}ms`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Formats skipped compile progress for fresh extension canaries.
 */
export function formatSkippedCompileProgress(params: SkippedCompileParams = {}) {
  const skippedCount = params.skippedCount ?? 0;
  const totalCount = params.totalCount ?? 0;
  if (!Number.isInteger(skippedCount) || skippedCount <= 0) {
    return "";
  }

  const staleCount = Math.max(0, totalCount - skippedCount);
  if (staleCount > 0) {
    return `skipped ${skippedCount} fresh plugin compiles before running ${staleCount} stale plugin checks\n`;
  }
  return `skipped ${skippedCount} fresh plugin compiles\n`;
}

/**
 * Formats slow extension compile diagnostics.
 */
export function formatSlowCompileSummary(params: SlowCompileParams = {}) {
  const compileTimings = Array.isArray(params.compileTimings) ? params.compileTimings : [];
  if (compileTimings.length === 0) {
    return "";
  }

  const limit = isPositiveInteger(params.limit) ? params.limit : SLOW_COMPILE_SUMMARY_LIMIT;
  const lines = ["slowest plugin compiles:"];
  for (const timing of [...compileTimings]
    .toSorted((left, right) => right.elapsedMs - left.elapsedMs)
    .slice(0, limit)) {
    lines.push(`- ${timing.extensionId}: ${timing.elapsedMs}ms`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Formats a failed boundary-check child process step.
 */
export function formatStepFailure(label: string, params: StepFailureParams = {}) {
  const stdoutSection = summarizeOutputSection("stdout", params.stdout ?? "");
  const stderrSection = summarizeOutputSection("stderr", params.stderr ?? "");
  const footer = formatFailureFooter(params);
  return [label, stdoutSection, stderrSection, footer].filter(Boolean).join("\n\n");
}

function attachStepFailureMetadata(error: Error, label: string, params: StepFailureParams = {}) {
  return Object.assign(error, {
    stepLabel: label,
    kind: params.kind ?? "unknown",
    elapsedMs: params.elapsedMs ?? null,
    fullOutput: [label, params.stdout ?? "", params.stderr ?? "", formatFailureFooter(params)]
      .filter(Boolean)
      .join("\n")
      .trim(),
  });
}

function collectBundledExtensionIds() {
  return readdirSync(join(repoRoot, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function resolveExtensionTsconfigPath(extensionId: string) {
  return join(repoRoot, "extensions", extensionId, "tsconfig.json");
}

function readExtensionTsconfig(extensionId: string) {
  const config = readJsonFile(resolveExtensionTsconfigPath(extensionId));
  return config && typeof config === "object" && "extends" in config
    ? { extends: config.extends }
    : {};
}

function collectOptInExtensionIds() {
  return collectBundledExtensionIds().filter((extensionId) => {
    const tsconfigPath = resolveExtensionTsconfigPath(extensionId);
    if (!existsSync(tsconfigPath)) {
      return false;
    }
    return readExtensionTsconfig(extensionId).extends === extensionPackageBoundaryBaseConfig;
  });
}

function collectCanaryExtensionIds(extensionIds: string[]) {
  return [
    ...new Map(
      extensionIds.map((extensionId) => [
        JSON.stringify(readExtensionTsconfig(extensionId)),
        extensionId,
      ]),
    ).values(),
  ];
}

function isRelevantCompileInput(filePath: string) {
  const basename = path.basename(filePath);
  if (
    basename === "__rootdir_boundary_canary__.ts" ||
    basename === "tsconfig.rootdir-canary.json"
  ) {
    return false;
  }
  if (basename.endsWith(".tsbuildinfo")) {
    return false;
  }
  return COMPILE_INPUT_EXTENSIONS.has(path.extname(filePath));
}

function collectNewestMtime(
  entryPath: string,
  params: { includeFile?: (filePath: string) => boolean; skipDistDirectories?: boolean } = {},
) {
  const includeFile = params.includeFile ?? (() => true);
  const skipDistDirectories = params.skipDistDirectories ?? true;
  let newestMtimeMs = 0;

  function visit(currentPath: string) {
    if (!existsSync(currentPath)) {
      return;
    }
    const stats = statSync(currentPath);
    if (stats.isDirectory()) {
      const basename = path.basename(currentPath);
      if ((skipDistDirectories && basename === "dist") || basename === "node_modules") {
        return;
      }
      for (const child of readdirSync(currentPath)) {
        visit(path.join(currentPath, child));
      }
      return;
    }
    if (!includeFile(currentPath)) {
      return;
    }
    newestMtimeMs = Math.max(newestMtimeMs, stats.mtimeMs);
  }

  visit(entryPath);
  return newestMtimeMs;
}

function collectOldestMtime(paths: string[]) {
  let oldestMtimeMs = Number.POSITIVE_INFINITY;

  for (const entryPath of paths) {
    if (!existsSync(entryPath)) {
      return null;
    }
    oldestMtimeMs = Math.min(oldestMtimeMs, statSync(entryPath).mtimeMs);
  }

  return Number.isFinite(oldestMtimeMs) ? oldestMtimeMs : null;
}

/**
 * Checks whether an extension boundary compile canary is still fresh.
 */
export function isBoundaryCompileFresh(extensionId: string, params: CompileFreshnessParams = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const extensionRoot = resolve(rootDir, "extensions", extensionId);
  const extensionNewestInputMtimeMs =
    params.extensionNewestInputMtimeMs ??
    collectNewestMtime(extensionRoot, { includeFile: isRelevantCompileInput });
  const sharedNewestInputMtimeMs =
    params.sharedNewestInputMtimeMs ??
    Math.max(
      collectNewestMtime(resolve(rootDir, "dist/plugin-sdk"), {
        skipDistDirectories: false,
      }),
      collectNewestMtime(resolve(rootDir, "packages/plugin-sdk/dist"), {
        skipDistDirectories: false,
      }),
    );
  const newestInputMtimeMs = Math.max(extensionNewestInputMtimeMs, sharedNewestInputMtimeMs);
  const oldestOutputMtimeMs = collectOldestMtime([
    resolveBoundaryTsStampPath(extensionId, rootDir),
  ]);
  return oldestOutputMtimeMs !== null && oldestOutputMtimeMs >= newestInputMtimeMs;
}

function writeStampFile(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${new Date().toISOString()}\n`, "utf8");
}

function runNodeStep(label: string, args: string[], timeoutMs: number) {
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, MAX_TIMER_TIMEOUT_MS);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: resolvedTimeoutMs,
  });

  if (result.status === 0 && !result.error) {
    return result;
  }

  const timeoutSuffix =
    result.error?.name === "Error" && result.error.message.includes("ETIMEDOUT")
      ? `${label} timed out after ${resolvedTimeoutMs}ms`
      : "";
  const errorSuffix = result.error ? result.error.message : "";
  const note = [timeoutSuffix, errorSuffix].filter(Boolean).join("\n");
  const elapsedMs = Date.now() - startedAt;
  const kind = timeoutSuffix ? "timeout" : result.error ? "spawn-error" : "nonzero-exit";
  const failure = attachStepFailureMetadata(
    new Error(
      formatStepFailure(label, {
        stdout: result.stdout,
        stderr: result.stderr,
        kind,
        elapsedMs,
        note,
      }),
    ),
    label,
    {
      stdout: result.stdout,
      stderr: result.stderr,
      kind,
      elapsedMs,
      note,
    },
  );
  throw Object.assign(failure, { status: result.status ?? 1 });
}

function abortSiblingSteps(abortController?: AbortController) {
  if (abortController && !abortController.signal.aborted) {
    abortController.abort();
  }
}

/**
 * Runs one node-based boundary check step with timeout and output capture.
 */
export function runNodeStepAsync(
  label: string,
  args: string[],
  timeoutMs: number,
  params: RunNodeStepParams = {},
) {
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, MAX_TIMER_TIMEOUT_MS);
  const abortController = params.abortController;
  const killProcess = params.killProcess ?? process.kill.bind(process);
  const onFailure = params.onFailure;
  const platform = params.platform ?? process.platform;
  const spawnImpl: StepSpawn = params.spawnImpl ?? spawn;
  const startedAt = Date.now();
  return new Promise<StepResult>((resolvePromise, rejectPromise) => {
    const child = spawnImpl(process.execPath, args, {
      cwd: repoRoot,
      detached: shouldUseDetachedVitestProcessGroup(platform),
      env: process.env,
      signal: abortController?.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      throw new Error(`${label} child process did not expose piped output`);
    }

    let stdout = createStepOutputCapture();
    let stderr = createStepOutputCapture();
    let settled = false;
    let forwardedSignal: VitestProcessSignal | null = null;
    const signalChild = (signal: VitestProcessSignal) => {
      if (
        !forwardSignalToVitestProcessGroup({
          child,
          kill: killProcess,
          platform,
          signal,
        })
      ) {
        child.kill(signal);
      }
    };
    const processGroupAlive = () => {
      if (platform === "win32" || typeof child.pid !== "number") {
        return false;
      }
      try {
        killProcess(-child.pid, 0);
        return true;
      } catch (error) {
        return Boolean(
          error && typeof error === "object" && "code" in error && error.code === "EPERM",
        );
      }
    };
    const waitForProcessGroupExit = async (ms: number) => {
      const deadlineAt = Date.now() + ms;
      while (Date.now() < deadlineAt) {
        if (!processGroupAlive()) {
          return true;
        }
        await new Promise((resolvePoll) => {
          setTimeout(resolvePoll, STEP_PROCESS_GROUP_EXIT_POLL_MS);
        });
      }
      return !processGroupAlive();
    };
    const waitAfterForceKill = async () => {
      if (processGroupAlive()) {
        await waitForProcessGroupExit(STEP_POST_FORCE_KILL_WAIT_MS);
      }
    };
    const rejectCanceledStep = async () => {
      signalChild("SIGKILL");
      await waitAfterForceKill();
      rejectPromise(
        toErrorObject(
          attachStepFailureMetadata(new Error(`${label} canceled after sibling failure`), label, {
            kind: "canceled",
            elapsedMs: Date.now() - startedAt,
            note: "canceled after sibling failure",
          }),
          "Step canceled after sibling failure",
        ),
      );
    };
    const abortSignal = abortController?.signal;
    const abortListener = () => {
      signalChild("SIGTERM");
    };
    abortSignal?.addEventListener("abort", abortListener, { once: true });
    const teardownProcessCleanup = installVitestProcessGroupCleanup({
      child,
      forceSignal: "SIGKILL",
      onSignal: (signal) => {
        forwardedSignal ??= signal;
      },
    });
    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abortListener);
      teardownProcessCleanup();
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      signalChild("SIGKILL");
      void (async () => {
        await waitAfterForceKill();
        const stdoutText = formatCapturedStepOutput(stdout);
        const stderrText = formatCapturedStepOutput(stderr);
        const error = attachStepFailureMetadata(
          new Error(
            formatStepFailure(label, {
              stdout: stdoutText,
              stderr: stderrText,
              kind: "timeout",
              elapsedMs: Date.now() - startedAt,
              note: `${label} timed out after ${resolvedTimeoutMs}ms`,
            }),
          ),
          label,
          {
            stdout: stdoutText,
            stderr: stderrText,
            kind: "timeout",
            elapsedMs: Date.now() - startedAt,
            note: `${label} timed out after ${resolvedTimeoutMs}ms`,
          },
        );
        onFailure?.(error);
        abortSiblingSteps(abortController);
        rejectPromise(toErrorObject(error, "Step timed out"));
      })();
    }, resolvedTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedStepOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBoundedStepOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      cleanup();
      settled = true;
      if (error.name === "AbortError" && abortController?.signal.aborted) {
        void rejectCanceledStep();
        return;
      }
      const stdoutText = formatCapturedStepOutput(stdout);
      const stderrText = formatCapturedStepOutput(stderr);
      const failure = attachStepFailureMetadata(
        new Error(
          formatStepFailure(label, {
            stdout: stdoutText,
            stderr: stderrText,
            kind: "spawn-error",
            elapsedMs: Date.now() - startedAt,
            note: error.message,
          }),
        ),
        label,
        {
          stdout: stdoutText,
          stderr: stderrText,
          kind: "spawn-error",
          elapsedMs: Date.now() - startedAt,
          note: error.message,
        },
      );
      onFailure?.(failure);
      abortSiblingSteps(abortController);
      rejectPromise(toErrorObject(failure, "Step spawn failed"));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      cleanup();
      settled = true;
      const signal = forwardedSignal;
      if (signal) {
        signalChild("SIGKILL");
        void waitAfterForceKill().finally(() => {
          process.kill(process.pid, signal);
        });
        return;
      }
      if (abortController?.signal.aborted) {
        void rejectCanceledStep();
        return;
      }
      if (code === 0) {
        resolvePromise({
          stdout: formatCapturedStepOutput(stdout),
          stderr: formatCapturedStepOutput(stderr),
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }
      const stdoutText = formatCapturedStepOutput(stdout);
      const stderrText = formatCapturedStepOutput(stderr);
      const error = attachStepFailureMetadata(
        new Error(
          formatStepFailure(label, {
            stdout: stdoutText,
            stderr: stderrText,
            kind: "nonzero-exit",
            elapsedMs: Date.now() - startedAt,
          }),
        ),
        label,
        {
          stdout: stdoutText,
          stderr: stderrText,
          kind: "nonzero-exit",
          elapsedMs: Date.now() - startedAt,
        },
      );
      onFailure?.(error);
      abortSiblingSteps(abortController);
      rejectPromise(toErrorObject(error, "Step failed"));
    });
  });
}

/**
 * Runs boundary check steps with bounded concurrency.
 */
export async function runNodeStepsWithConcurrency(steps: BoundaryStep[], concurrency: number) {
  const abortController = new AbortController();
  let firstFailure: unknown = null;
  await pMap(
    steps,
    async (step) => {
      if (abortController.signal.aborted) {
        return;
      }
      try {
        step.onStart?.();
        const result = await runNodeStepAsync(step.label, step.args, step.timeoutMs, {
          abortController,
          onFailure(error) {
            firstFailure ??= error;
          },
        });
        step.onSuccess?.(result);
      } catch (error) {
        // Keep the mapper fulfilled so pMap waits for active process-group cleanup.
        firstFailure ??= error;
        abortSiblingSteps(abortController);
      }
    },
    { concurrency, stopOnError: false },
  );
  if (firstFailure) {
    throw toErrorObject(firstFailure, "Non-Error thrown");
  }
}

/**
 * Resolves canary artifact paths for an extension boundary compile.
 */
export function resolveCanaryArtifactPaths(extensionId: string, rootDir = repoRoot) {
  const extensionRoot = resolve(rootDir, "extensions", extensionId);
  return {
    extensionRoot,
    canaryPath: resolve(extensionRoot, "__rootdir_boundary_canary__.ts"),
    tsconfigPath: resolve(extensionRoot, "tsconfig.rootdir-canary.json"),
  };
}

/**
 * Removes canary artifacts for one extension.
 */
function cleanupCanaryArtifacts(extensionId: string, rootDir = repoRoot) {
  const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(extensionId, rootDir);
  rmSync(canaryPath, { force: true });
  rmSync(tsconfigPath, { force: true });
}

/**
 * Removes canary artifacts for multiple extensions.
 */
export function cleanupCanaryArtifactsForExtensions(extensionIds: string[], rootDir = repoRoot) {
  for (const extensionId of extensionIds) {
    cleanupCanaryArtifacts(extensionId, rootDir);
  }
}

/**
 * Installs signal/exit cleanup for extension canary artifacts.
 */
export function installCanaryArtifactCleanup(
  extensionIds: string[],
  params: BoundaryCheckParams = {},
) {
  const rootDir = params.rootDir ?? repoRoot;
  const processObject = params.processObject ?? process;
  const exitHandler = () => {
    cleanupCanaryArtifactsForExtensions(extensionIds, rootDir);
  };
  processObject.on("exit", exitHandler);
  return () => {
    processObject.off("exit", exitHandler);
  };
}

function resolveBoundaryTsBuildInfoPath(extensionId: string) {
  return resolve(repoRoot, "extensions", extensionId, "dist", ".boundary-tsc.tsbuildinfo");
}

function resolveBoundaryTsStampPath(extensionId: string, rootDir = repoRoot) {
  return resolve(rootDir, "extensions", extensionId, "dist", ".boundary-tsc.stamp");
}

/**
 * Resolves the local lock path for extension boundary checks.
 */
export function resolveBoundaryCheckLockPath(rootDir = repoRoot) {
  return resolve(rootDir, "dist", ".extension-package-boundary.lock");
}

function resolveBoundaryCheckLockOwnerPath(lockPath: string) {
  return join(lockPath, "owner.json");
}

function isProcessAlive(pid: unknown) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function removeStaleBoundaryCheckLock(lockPath: string) {
  const ownerPath = resolveBoundaryCheckLockOwnerPath(lockPath);
  let owner: unknown;
  try {
    owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch {
    rmSync(lockPath, { force: true, recursive: true });
    return true;
  }

  const ownerPid = owner && typeof owner === "object" && "pid" in owner ? owner.pid : undefined;
  if (isProcessAlive(ownerPid)) {
    return false;
  }
  rmSync(lockPath, { force: true, recursive: true });
  return true;
}

/**
 * Acquires the single-process lock for extension boundary checks.
 */
export function acquireBoundaryCheckLock(params: BoundaryCheckParams = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const processObject = params.processObject ?? process;
  const lockPath = resolveBoundaryCheckLockPath(rootDir);
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      if (removeStaleBoundaryCheckLock(lockPath)) {
        mkdirSync(lockPath);
      } else {
        throw attachStepFailureMetadata(
          new Error(
            [
              "extension package boundary check",
              "kind: lock-contention",
              `lock: ${lockPath}`,
              "another extension package boundary check is already running in this checkout",
            ].join("\n\n"),
            { cause: error },
          ),
          "extension package boundary check",
          {
            kind: "lock-contention",
            note: `lock: ${lockPath}\nanother extension package boundary check is already running in this checkout`,
          },
        );
      }
    } else {
      throw error;
    }
  }

  writeFileSync(
    resolveBoundaryCheckLockOwnerPath(lockPath),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  const release = () => {
    rmSync(lockPath, { force: true, recursive: true });
  };
  processObject.on("exit", release);
  return () => {
    processObject.off("exit", release);
    release();
  };
}

async function runCompileCheck(extensionIds: string[]) {
  const prepStartedAt = Date.now();
  process.stdout.write(
    `preparing plugin-sdk boundary artifacts for ${extensionIds.length} plugins\n`,
  );
  runNodeStep("plugin-sdk boundary prep", prepareBoundaryArtifactsArgs, 420_000);
  const prepElapsedMs = Date.now() - prepStartedAt;
  const concurrency = resolveCompileConcurrency();
  const verboseFreshLogs = process.env.OPENCLAW_EXTENSION_BOUNDARY_VERBOSE_FRESH === "1";
  const sharedNewestInputMtimeMs = Math.max(
    collectNewestMtime(resolve(repoRoot, "dist/plugin-sdk"), {
      skipDistDirectories: false,
    }),
    collectNewestMtime(resolve(repoRoot, "packages/plugin-sdk/dist"), {
      skipDistDirectories: false,
    }),
  );
  process.stdout.write(`compile concurrency ${concurrency}\n`);
  const compileStartedAt = Date.now();
  let skippedCompileCount = 0;
  const compileTimings: CompileTiming[] = [];
  const steps = extensionIds
    .map((extensionId, index) => {
      const tsBuildInfoPath = resolveBoundaryTsBuildInfoPath(extensionId);
      const extensionNewestInputMtimeMs = collectNewestMtime(
        resolve(repoRoot, "extensions", extensionId),
        {
          includeFile: isRelevantCompileInput,
        },
      );
      mkdirSync(dirname(tsBuildInfoPath), { recursive: true });
      if (
        isBoundaryCompileFresh(extensionId, {
          extensionNewestInputMtimeMs,
          sharedNewestInputMtimeMs,
        })
      ) {
        skippedCompileCount += 1;
        if (verboseFreshLogs) {
          process.stdout.write(
            `[${index + 1}/${extensionIds.length}] ${extensionId} (fresh; skipping)\n`,
          );
        }
        return null;
      }
      return {
        label: extensionId,
        onStart() {
          process.stdout.write(`[${index + 1}/${extensionIds.length}] ${extensionId}\n`);
        },
        onSuccess(result) {
          writeStampFile(resolveBoundaryTsStampPath(extensionId));
          compileTimings.push({
            extensionId,
            elapsedMs: result.elapsedMs,
          });
        },
        args: [
          tsgoBin,
          "-p",
          resolve(repoRoot, "extensions", extensionId, "tsconfig.json"),
          "--noEmit",
          "--incremental",
          "--tsBuildInfoFile",
          tsBuildInfoPath,
        ],
        timeoutMs: 120_000,
      } satisfies BoundaryStep;
    })
    .filter((step) => step !== null);
  if (!verboseFreshLogs && skippedCompileCount > 0) {
    process.stdout.write(
      formatSkippedCompileProgress({
        skippedCount: skippedCompileCount,
        totalCount: extensionIds.length,
      }),
    );
  }
  if (steps.length > 0) {
    await runNodeStepsWithConcurrency(steps, concurrency);
  }
  return {
    prepElapsedMs,
    compileCount: steps.length,
    skippedCompileCount,
    compileElapsedMs: Date.now() - compileStartedAt,
    compileTimings,
  };
}

async function runCanaryCheck(extensionIds: string[]) {
  const startedAt = Date.now();
  await Promise.all(
    extensionIds.map(async (extensionId, index) => {
      const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(extensionId);

      cleanupCanaryArtifacts(extensionId);
      process.stdout.write(`[${index + 1}/${extensionIds.length}] ${extensionId} canary\n`);
      try {
        writeFileSync(
          canaryPath,
          [
            `import { ROOTDIR_BOUNDARY_CANARY } from "${ROOTDIR_BOUNDARY_CANARY_IMPORT_PATH}";`,
            "void ROOTDIR_BOUNDARY_CANARY;",
            "export {};",
            "",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          tsconfigPath,
          `${JSON.stringify(
            {
              extends: "./tsconfig.json",
              include: ["./__rootdir_boundary_canary__.ts"],
              exclude: [],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        const result = await runNodeStepAsync(
          `${extensionId} canary`,
          [tscBin, "-p", tsconfigPath, "--noEmit"],
          120_000,
        );
        throw new Error(
          `${extensionId} canary unexpectedly passed\n${result.stdout}${result.stderr}`,
        );
      } catch (error) {
        const output =
          error instanceof Error && "fullOutput" in error && typeof error.fullOutput === "string"
            ? error.fullOutput
            : String(error);
        if (!output.includes("TS6059") || !output.includes(ROOTDIR_BOUNDARY_CANARY_OUTPUT_HINT)) {
          throw error;
        }
      } finally {
        cleanupCanaryArtifacts(extensionId);
      }
    }),
  );
  return {
    canaryElapsedMs: Date.now() - startedAt,
  };
}

/**
 * Runs the extension package TypeScript boundary check.
 */
export async function main(argv: string[] = process.argv.slice(2)) {
  const startedAt = Date.now();
  const mode = parseMode(argv);
  const optInExtensionIds = collectOptInExtensionIds();
  const canaryExtensionIds = collectCanaryExtensionIds(optInExtensionIds);
  const cleanupExtensionIds = optInExtensionIds;
  const shouldRunCanary = mode === "all" || mode === "canary";
  const releaseBoundaryLock = acquireBoundaryCheckLock();
  const teardownCanaryCleanup = installCanaryArtifactCleanup(cleanupExtensionIds);
  let prepElapsedMs: number | undefined;
  let compileCount = 0;
  let skippedCompileCount = 0;
  let compileElapsedMs: number | undefined;
  let compileTimings: CompileTiming[] = [];
  let canaryElapsedMs: number | undefined;

  try {
    cleanupCanaryArtifactsForExtensions(cleanupExtensionIds);
    if (mode === "all" || mode === "compile") {
      ({ prepElapsedMs, compileCount, skippedCompileCount, compileElapsedMs, compileTimings } =
        await runCompileCheck(optInExtensionIds));
    }
    if (shouldRunCanary) {
      ({ canaryElapsedMs } = await runCanaryCheck(canaryExtensionIds));
    }
    process.stdout.write(
      formatBoundaryCheckSuccessSummary({
        mode,
        compileCount,
        skippedCompileCount,
        canaryCount: shouldRunCanary ? canaryExtensionIds.length : 0,
        prepElapsedMs,
        compileElapsedMs,
        canaryElapsedMs,
        elapsedMs: Date.now() - startedAt,
      }),
    );
    process.stdout.write(
      formatSlowCompileSummary({
        compileTimings,
      }),
    );
  } finally {
    releaseBoundaryLock?.();
    teardownCanaryCleanup?.();
    cleanupCanaryArtifactsForExtensions(cleanupExtensionIds);
  }
}

if (import.meta.main) {
  await main();
}
