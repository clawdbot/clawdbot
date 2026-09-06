#!/usr/bin/env node

// Profiles peak RSS for built bundled plugin entrypoints and emits a JSON
// report suitable for extension memory budget review.
import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import pMap from "p-map";
import {
  ensureExtensionMemoryBuild,
  findBuiltExtensionMemoryEntries,
} from "./ensure-extension-memory-build.mts";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mts";
import { appendBoundedTail } from "./lib/bounded-output-tail.mjs";
import { formatErrorMessage } from "./lib/error-format.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_COMBINED_TIMEOUT_MS = 180_000;
const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_TOP = 10;
const OUTPUT_CAPTURE_MAX_CHARS = 128 * 1024;
const STDERR_PREVIEW_MAX_CHARS = 8 * 1024;
const RSS_MARKER = "__OPENCLAW_MAX_RSS_KB__=";
type ParentSignal = "SIGHUP" | "SIGINT" | "SIGTERM";
type OutputCapture = { text: string; truncatedChars: number };
type RunCaseResult = {
  code: number | null;
  error: string | null;
  maxRssMb: number | null;
  name: string;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};
type CaseChild = ChildProcessByStdio<null, Readable, Readable>;

const PARENT_SIGNAL_EXIT_CODES = new Map<ParentSignal, number>([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
const activeCaseChildren = new Map<CaseChild, number>();
const parentSignalHandlers = new Map<ParentSignal, () => void>();
let parentSignalHandlersInstalled = false;
let parentSignalShutdownStarted = false;

function defaultJsonReportPath(): string {
  return path.join(
    os.tmpdir(),
    `openclaw-extension-memory-${process.pid}-${Date.now()}-${randomUUID()}.json`,
  );
}

function printHelp(): void {
  console.log(`Usage: node --import tsx scripts/profile-extension-memory.mts [options]

Profiles peak RSS for built bundled plugin entrypoints.
Run pnpm build first if you want stats for the latest source changes.

Options:
  --extension, -e <id>     Limit profiling to one or more extension ids (repeatable)
  --concurrency <n>        Number of per-extension workers (default: ${DEFAULT_CONCURRENCY})
  --timeout-ms <ms>        Per-extension timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --combined-timeout-ms <ms>
                           Combined-import timeout in milliseconds (default: ${DEFAULT_COMBINED_TIMEOUT_MS})
  --top <n>                Show top N entries by delta from baseline (default: ${DEFAULT_TOP})
  --json <path>            Write full JSON report to this path
  --skip-combined          Skip the combined all-imports measurement
  --help                   Show this help

Examples:
  pnpm test:extensions:memory
  pnpm test:extensions:memory -- --extension discord
  pnpm test:extensions:memory -- --extension discord --extension telegram --skip-combined
`);
}

/**
 * Parses extension memory profiler options after pnpm's optional separator.
 */
export function parseArgs(argv: string[]): {
  extensions: string[];
  concurrency: number;
  timeoutMs: number;
  combinedTimeoutMs: number;
  top: number;
  jsonPath: string | null;
  skipCombined: boolean;
} {
  const args = stripLeadingPackageManagerSeparator(argv);
  const options: ReturnType<typeof parseArgs> = {
    extensions: [],
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    combinedTimeoutMs: DEFAULT_COMBINED_TIMEOUT_MS,
    top: DEFAULT_TOP,
    jsonPath: null,
    skipCombined: false,
  };

  parseArgv: for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break parseArgv;
      case "--extension":
      case "-e": {
        const next = args[index + 1];
        if (!next || next.startsWith("-")) {
          throw new Error(`${arg} requires a value`);
        }
        options.extensions.push(next);
        index += 1;
        break;
      }
      case "--concurrency":
        options.concurrency = parsePositiveInt(args[index + 1] ?? "", arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(args[index + 1] ?? "", arg);
        index += 1;
        break;
      case "--combined-timeout-ms":
        options.combinedTimeoutMs = parsePositiveInt(args[index + 1] ?? "", arg);
        index += 1;
        break;
      case "--top":
        options.top = parsePositiveInt(args[index + 1] ?? "", arg);
        index += 1;
        break;
      case "--json": {
        const next = args[index + 1];
        if (!next || next.startsWith("-")) {
          throw new Error(`${arg} requires a value`);
        }
        options.jsonPath = path.resolve(next);
        index += 1;
        break;
      }
      case "--skip-combined":
        options.skipCombined = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseMaxRssMb(stderr: string): number | null {
  const matches = [...stderr.matchAll(new RegExp(`^${RSS_MARKER}(\\d+)\\s*$`, "gm"))];
  const last = matches.at(-1);
  return last ? Number(last[1]) / 1024 : null;
}

function createOutputCapture(): OutputCapture {
  return { text: "", truncatedChars: 0 };
}

function formatCapturedOutput(capture: OutputCapture): string {
  if (capture.truncatedChars === 0) {
    return capture.text;
  }
  return `[output truncated ${capture.truncatedChars} chars; showing tail]\n${capture.text}`;
}

function scanMaxRssMb(tail: string, chunk: unknown, current: number | null) {
  const text = `${tail}${String(chunk)}`;
  const parsed = parseMaxRssMb(text);
  const lineBreakIndex = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  const openLine = lineBreakIndex === -1 ? text : text.slice(lineBreakIndex + 1);
  return {
    maxRssMb: parsed ?? current,
    tail: openLine.slice(-(RSS_MARKER.length + 32)),
  };
}

function summarizeStderr(stderr: string, lines = 8, maxChars = STDERR_PREVIEW_MAX_CHARS): string {
  const text = stderr.trim().split("\n").filter(Boolean).slice(0, lines).join("\n");
  if (text.length <= maxChars) {
    return text;
  }
  const firstLine = text.split("\n", 1)[0] ?? "";
  const prefix = firstLine.startsWith("[output truncated") ? `${firstLine}\n` : "";
  return `${prefix}[stderr preview truncated ${text.length - maxChars} chars; showing tail]\n${text.slice(
    -maxChars,
  )}`;
}

/**
 * Runs one import scenario in a child process and captures bounded output plus RSS.
 */
export async function runCase({
  repoRoot,
  env,
  hookPath,
  name,
  body,
  timeoutMs,
  shutdownGraceMs = DEFAULT_CHILD_SHUTDOWN_GRACE_MS,
  spawnImpl = spawn,
}: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  hookPath: string;
  name: string;
  body: string;
  timeoutMs: number;
  shutdownGraceMs?: number | undefined;
  spawnImpl?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">,
  ) => CaseChild;
}): Promise<RunCaseResult> {
  return await new Promise<RunCaseResult>((resolve) => {
    const child = spawnImpl(
      process.execPath,
      ["--import", hookPath, "--input-type=module", "--eval", body],
      {
        cwd: repoRoot,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    trackActiveCaseChild(child, shutdownGraceMs);

    let stdout = createOutputCapture();
    let stderr = createOutputCapture();
    let stderrRssTail = "";
    let maxRssMb: number | null = null;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalChildProcessTree(child, "SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    function settle(result: RunCaseResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      untrackActiveCaseChild(child);
      resolve(result);
    }

    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedTail(stdout, chunk, OUTPUT_CAPTURE_MAX_CHARS);
    });
    child.stderr.on("data", (chunk) => {
      const rssScan = scanMaxRssMb(stderrRssTail, chunk, maxRssMb);
      stderrRssTail = rssScan.tail;
      maxRssMb = rssScan.maxRssMb;
      stderr = appendBoundedTail(stderr, chunk, OUTPUT_CAPTURE_MAX_CHARS);
    });
    child.on("error", (error) => {
      const stderrText = formatCapturedOutput(stderr);
      settle({
        name,
        code: null,
        signal: null,
        timedOut,
        error: formatErrorMessage(error),
        stdout: formatCapturedOutput(stdout),
        stderr: stderrText,
        maxRssMb: maxRssMb ?? parseMaxRssMb(stderrText),
      });
    });
    child.on("close", (code, signal) => {
      void (async () => {
        if (timedOut) {
          await waitForChildProcessTreeExit(child, shutdownGraceMs);
        }
        const stderrText = formatCapturedOutput(stderr);
        settle({
          name,
          code,
          signal,
          timedOut,
          error: null,
          stdout: formatCapturedOutput(stdout),
          stderr: stderrText,
          maxRssMb: maxRssMb ?? parseMaxRssMb(stderrText),
        });
      })();
    });
  });
}

function signalChildProcessTree(child: CaseChild, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  child.kill(signal);
}

async function waitForChildProcessTreeExit(child: CaseChild, timeoutMs: number): Promise<boolean> {
  if (process.platform === "win32" || typeof child.pid !== "number") {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!childProcessTreeIsAlive(child)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return !childProcessTreeIsAlive(child);
}

function childProcessTreeIsAlive(child: CaseChild): boolean {
  if (typeof child.pid !== "number") {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function trackActiveCaseChild(child: CaseChild, shutdownGraceMs: number): void {
  activeCaseChildren.set(child, shutdownGraceMs);
  installParentSignalHandlers();
}

function untrackActiveCaseChild(child: CaseChild): void {
  activeCaseChildren.delete(child);
  if (activeCaseChildren.size === 0) {
    removeParentSignalHandlers();
  }
}

function installParentSignalHandlers(): void {
  if (parentSignalHandlersInstalled) {
    return;
  }
  parentSignalHandlersInstalled = true;
  for (const signal of PARENT_SIGNAL_EXIT_CODES.keys()) {
    const handler = () => handleParentSignal(signal);
    parentSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeParentSignalHandlers(): void {
  if (!parentSignalHandlersInstalled || parentSignalShutdownStarted) {
    return;
  }
  removeInstalledParentSignalHandlers();
}

function removeInstalledParentSignalHandlers(): void {
  if (!parentSignalHandlersInstalled) {
    return;
  }
  parentSignalHandlersInstalled = false;
  for (const [signal, handler] of parentSignalHandlers) {
    process.off(signal, handler);
  }
  parentSignalHandlers.clear();
}

function handleParentSignal(signal: ParentSignal): void {
  if (parentSignalShutdownStarted) {
    for (const child of activeCaseChildren.keys()) {
      signalChildProcessTree(child, "SIGKILL");
    }
    return;
  }
  parentSignalShutdownStarted = true;
  void cleanupActiveCaseChildrenForParentSignal(signal);
}

async function cleanupActiveCaseChildrenForParentSignal(signal: ParentSignal): Promise<void> {
  const children = [...activeCaseChildren.entries()];
  for (const [child] of children) {
    signalChildProcessTree(child, signal);
  }
  await Promise.all(
    children.map(([child, shutdownGraceMs]) => waitForChildProcessTreeExit(child, shutdownGraceMs)),
  );
  for (const [child] of children) {
    if (childProcessTreeIsAlive(child)) {
      signalChildProcessTree(child, "SIGKILL");
    }
  }
  await Promise.all(
    children.map(([child, shutdownGraceMs]) => waitForChildProcessTreeExit(child, shutdownGraceMs)),
  );
  removeInstalledParentSignalHandlers();
  process.exit(PARENT_SIGNAL_EXIT_CODES.get(signal) ?? 1);
}

function buildImportBody(entryFiles: string[], label: string): string {
  const imports = entryFiles
    .map((filePath) => `await import(${JSON.stringify(filePath)});`)
    .join("\n");
  return `${imports}\nconsole.log(${JSON.stringify(label)});\nprocess.exit(0);\n`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  ensureExtensionMemoryBuild({
    rootDir: repoRoot,
    requiredExtensionIds: options.extensions,
  });
  const allEntries = findBuiltExtensionMemoryEntries(repoRoot);
  if (allEntries.length === 0) {
    throw new Error(
      "No built plugin entrypoints found in root or package-local output. Run pnpm build or build the plugin package first.",
    );
  }
  const selectedEntries =
    options.extensions.length === 0
      ? allEntries
      : allEntries.filter((entry) => options.extensions.includes(entry.dir));

  const missing = options.extensions.filter((id) => !allEntries.some((entry) => entry.dir === id));
  if (missing.length > 0) {
    throw new Error(`Unknown built extension ids: ${missing.join(", ")}`);
  }
  if (selectedEntries.length === 0) {
    throw new Error("No extensions selected for profiling");
  }

  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-memory-"));
  const hookPath = path.join(tmpHome, "measure-rss.mjs");
  const jsonPath = options.jsonPath ?? defaultJsonReportPath();

  writeFileSync(
    hookPath,
    [
      "import { writeSync } from 'node:fs';",
      "process.on('exit', () => {",
      "  const usage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;",
      `  if (usage && typeof usage.maxRSS === 'number') writeSync(2, '${RSS_MARKER}' + String(usage.maxRSS) + '\\n');`,
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const env = {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, ".config"),
    XDG_DATA_HOME: path.join(tmpHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(tmpHome, ".cache"),
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_NO_RESPAWN: "1",
    TERM: process.env.TERM ?? "dumb",
    LANG: process.env.LANG ?? "C.UTF-8",
  };

  try {
    const baseline = await runCase({
      repoRoot,
      env,
      hookPath,
      name: "baseline",
      body: "process.exit(0)",
      timeoutMs: options.timeoutMs,
    });

    const combined = options.skipCombined
      ? null
      : await runCase({
          repoRoot,
          env,
          hookPath,
          name: "combined",
          body: buildImportBody(
            selectedEntries.map((entry) => entry.file),
            "IMPORTED_ALL",
          ),
          timeoutMs: options.combinedTimeoutMs,
        });

    const results = await pMap(
      selectedEntries,
      async (next) => {
        const result = await runCase({
          repoRoot,
          env,
          hookPath,
          name: next.dir,
          body: buildImportBody([next.file], "IMPORTED"),
          timeoutMs: options.timeoutMs,
        });
        const entry = {
          dir: next.dir,
          file: next.file,
          status: result.timedOut ? "timeout" : result.code === 0 ? "ok" : "fail",
          maxRssMb: result.maxRssMb,
          deltaFromBaselineMb:
            result.maxRssMb !== null && baseline.maxRssMb !== null
              ? result.maxRssMb - baseline.maxRssMb
              : null,
          stderrPreview: summarizeStderr(result.stderr),
        };

        const status = result.timedOut ? "timeout" : result.code === 0 ? "ok" : "fail";
        const rss = result.maxRssMb === null ? "n/a" : `${result.maxRssMb.toFixed(1)} MB`;
        console.log(`[extension-memory] ${next.dir}: ${status} ${rss}`);
        return entry;
      },
      { concurrency: options.concurrency, stopOnError: true },
    );

    results.sort((a, b) => a.dir.localeCompare(b.dir));
    const top = results
      .filter((entry) => entry.status === "ok" && typeof entry.deltaFromBaselineMb === "number")
      .toSorted((a, b) => (b.deltaFromBaselineMb ?? 0) - (a.deltaFromBaselineMb ?? 0))
      .slice(0, options.top);

    const report = {
      generatedAt: new Date().toISOString(),
      repoRoot,
      selectedExtensions: selectedEntries.map((entry) => entry.dir),
      baseline: {
        status: baseline.timedOut ? "timeout" : baseline.code === 0 ? "ok" : "fail",
        maxRssMb: baseline.maxRssMb,
      },
      combined:
        combined === null
          ? null
          : {
              status: combined.timedOut ? "timeout" : combined.code === 0 ? "ok" : "fail",
              maxRssMb: combined.maxRssMb,
              stderrPreview: summarizeStderr(combined.stderr, 12),
            },
      counts: {
        totalEntries: selectedEntries.length,
        ok: results.filter((entry) => entry.status === "ok").length,
        fail: results.filter((entry) => entry.status === "fail").length,
        timeout: results.filter((entry) => entry.status === "timeout").length,
      },
      options: {
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        combinedTimeoutMs: options.combinedTimeoutMs,
        skipCombined: options.skipCombined,
      },
      topByDeltaMb: top,
      results,
    };

    mkdirSync(path.dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log(`[extension-memory] report: ${jsonPath}`);
    console.log(
      JSON.stringify(
        {
          baselineMb: report.baseline.maxRssMb,
          combinedMb: report.combined?.maxRssMb ?? null,
          counts: report.counts,
          topByDeltaMb: report.topByDeltaMb,
        },
        null,
        2,
      ),
    );

    const failures = [];
    if (report.baseline.status !== "ok") {
      failures.push(`baseline import ${report.baseline.status}`);
    }
    if (report.baseline.maxRssMb === null) {
      failures.push("baseline import did not report RSS");
    }
    if (report.combined !== null) {
      if (report.combined.status !== "ok") {
        failures.push(`combined import ${report.combined.status}`);
      }
      if (report.combined.maxRssMb === null) {
        failures.push("combined import did not report RSS");
      }
    }
    for (const result of report.results) {
      if (result.status !== "ok") {
        failures.push(`${result.dir} import ${result.status}`);
      }
      if (result.maxRssMb === null) {
        failures.push(`${result.dir} import did not report RSS`);
      }
    }
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`[extension-memory] ${failure}`);
      }
      process.exitCode = 1;
    }
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`[extension-memory] ${formatErrorMessage(error)}`);
    process.exit(1);
  }
}
