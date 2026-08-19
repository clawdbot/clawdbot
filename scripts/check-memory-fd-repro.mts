#!/usr/bin/env node

// Reproduces memory-search file descriptor retention with a synthetic workspace.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { safeParseJson } from "../packages/normalization-core/src/json-coercion.ts";
import { resolveTimerTimeoutMs } from "../packages/normalization-core/src/number-coercion.ts";
import { asNullableRecord as asRecord } from "../packages/normalization-core/src/record-coerce.ts";
import { readNonBlankString } from "../packages/normalization-core/src/string-coerce.ts";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mts";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import { parseStrictNonNegativeDecimal as parseNonNegativeInteger } from "./lib/numeric-options.mjs";

const ISSUE_FILE_COUNTS = [
  ["memory/transcripts", 9394],
  ["memory/transcripts.archived", 1695],
  ["memory/structured-md/lessons", 268],
  ["memory/structured-md/decisions", 215],
  ["memory/structured-md/lessons.archived", 214],
  ["memory/structured-md/procedures", 213],
  ["memory/structured-md/decisions.archived", 151],
  ["memory/structured-md/procedures.archived", 126],
  ["memory/structured-md/projects", 81],
  ["memory/structured-md/projects.archived", 34],
] satisfies Array<[string, number]>;

type ChildExitState = { exitCode: number | null; signalCode: string | null };
type GatewaySignal = "SIGINT" | "SIGKILL" | "SIGTERM";
type GatewayOutputStream = {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
};
type GatewayReadyChild = ChildExitState & {
  stderr: GatewayOutputStream;
  stdout: GatewayOutputStream;
};
type StoppableGatewayChild = ChildExitState & { kill(signal: GatewaySignal): unknown };
type GatewayChild = GatewayReadyChild & StoppableGatewayChild;
type GatewayReadyOutputState = { tail?: string; readySeen?: boolean };
type ConfigOptions = { homeDir: string; workspaceDir: string; port: number; token: string };
type FdSampleOptions = { label: string; pid: number; workspaceRealPath: string };
type GatewayReadyOptions = {
  child: GatewayReadyChild;
  port: number;
  logPath: string;
  timeoutMs: number;
};
type InvokeOptions = { port: number; token: string; timeoutMs: number };
type InvokeResponseOptions = { httpOk: boolean; status: number; bodyText: string };

const ISSUE_MEMORY_FILE_COUNT = ISSUE_FILE_COUNTS.reduce((sum, [, count]) => sum + count, 0);
const DEFAULT_FILE_COUNT = 512;
const DEFAULT_MAX_WORKSPACE_REG_FDS = process.platform === "darwin" ? 8 : 64;
/**
 * Maximum gateway-ready output tail retained while waiting for startup.
 */
export const GATEWAY_READY_OUTPUT_MAX_CHARS = 128 * 1024;
/**
 * Maximum bytes read from the memory_search HTTP response.
 */
const MEMORY_SEARCH_RESPONSE_MAX_BYTES = 256 * 1024;
/**
 * Probe query expected to hit the synthetic top-level memory file.
 */
export const MEMORY_SEARCH_PROBE_QUERY = "Top-level memory file";

const SKIP_GATEWAY_ENV = {
  NODE_ENV: "test",
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_SKIP_ACPX_RUNTIME: "1",
  OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
};

function usage() {
  return `
Usage: node --import tsx scripts/check-memory-fd-repro.mts [options]

Options:
  --full                         Use the issue-sized 12,391-file memory tree.
  --files <count>                Number of memory/**/*.md files to generate. Default: ${DEFAULT_FILE_COUNT}.
  --mode <fixed|leak|report>     fixed fails on FD fan-out; leak expects it; report never fails. Default: fixed.
  --max-workspace-reg-fds <n>    Fixed-mode maximum retained workspace Markdown REG FDs. Default: ${DEFAULT_MAX_WORKSPACE_REG_FDS}.
  --min-leaked-fds <n>           Leak-mode minimum retained workspace Markdown REG FDs. Default: min(files, 64).
  --invoke-timeout-ms <n>        Abort the memory_search HTTP call after this long. Default: 30000.
  --sample-delay-ms <n>          First post-invoke FD sample delay. Default: 1000.
  --settle-delay-ms <n>          Final FD sample delay after invoke settles. Default: 5000.
  --output-dir <path>            Artifact directory. Default: .artifacts/memory-fd-repro/<timestamp>.
  --keep                         Keep the synthetic OPENCLAW_HOME and workspace after the run.
  --allow-non-darwin             Run on non-macOS platforms. lsof REG counts are most meaningful on macOS.
  --help                         Show this help.
`.trim();
}

const ARGUMENT_FLAGS = new Set([
  "--allow-non-darwin",
  "--expect-leak",
  "--files",
  "--full",
  "--help",
  "--invoke-timeout-ms",
  "--keep",
  "--max-workspace-reg-fds",
  "--min-leaked-fds",
  "--mode",
  "--output-dir",
  "--report-only",
  "--sample-delay-ms",
  "--settle-delay-ms",
]);

function stripPackageManagerSeparatorForKnownFlags(argv: string[]) {
  return argv[0] === "--" && argv[1] !== undefined && ARGUMENT_FLAGS.has(argv[1])
    ? stripLeadingPackageManagerSeparator(argv)
    : argv;
}

/**
 * Parses a safe positive integer option.
 */
function readPositiveNumber(value: unknown, label: string) {
  const parsed = parseNonNegativeInteger(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be greater than 0`);
  }
  return parsed;
}

function readNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : parseNonNegativeInteger(raw, name);
}

function readPositiveNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : readPositiveNumber(raw, name);
}

function readTimerTimeoutNumber(value: unknown, label: string, minMs = 1) {
  const parsed =
    minMs > 0 ? readPositiveNumber(value, label) : parseNonNegativeInteger(value, label);
  return resolveTimerTimeoutMs(parsed, minMs, minMs);
}

function readTimerTimeoutNumberEnv(name: string, fallback: number, minMs = 1) {
  const raw = process.env[name];
  return raw == null || raw.trim() === ""
    ? resolveTimerTimeoutMs(fallback, minMs, minMs)
    : readTimerTimeoutNumber(raw, name, minMs);
}

/**
 * Parses memory FD repro CLI arguments and environment fallbacks.
 */
export function parseArgs(argv: string[]) {
  const args = stripPackageManagerSeparatorForKnownFlags(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let fileCount: number | undefined;
  let maxWorkspaceRegFds: number | undefined;
  let minLeakedFds: number | undefined;
  let invokeTimeoutMs: number | undefined;
  let sampleDelayMs: number | undefined;
  let settleDelayMs: number | undefined;
  let mode = process.env.OPENCLAW_MEMORY_FD_REPRO_MODE || "fixed";
  let outputDir = path.resolve(".artifacts", "memory-fd-repro", stamp);
  let keep = process.env.OPENCLAW_MEMORY_FD_REPRO_KEEP === "1";
  let allowNonDarwin = process.env.OPENCLAW_MEMORY_FD_REPRO_ALLOW_NON_DARWIN === "1";

  parseArgv: for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      break;
    }
    const next = args[i + 1];
    const readValue = () => {
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case "--":
        break parseArgv;
      case "--help":
        console.log(usage());
        process.exit(0);
      case "--full":
        fileCount = ISSUE_MEMORY_FILE_COUNT;
        break;
      case "--files":
        fileCount = readPositiveNumber(readValue(), "--files");
        break;
      case "--mode":
        mode = readValue();
        break;
      case "--expect-leak":
        mode = "leak";
        break;
      case "--report-only":
        mode = "report";
        break;
      case "--max-workspace-reg-fds":
        maxWorkspaceRegFds = parseNonNegativeInteger(readValue(), "--max-workspace-reg-fds");
        break;
      case "--min-leaked-fds":
        minLeakedFds = readPositiveNumber(readValue(), "--min-leaked-fds");
        break;
      case "--invoke-timeout-ms":
        invokeTimeoutMs = readTimerTimeoutNumber(readValue(), "--invoke-timeout-ms");
        break;
      case "--sample-delay-ms":
        sampleDelayMs = readTimerTimeoutNumber(readValue(), "--sample-delay-ms", 0);
        break;
      case "--settle-delay-ms":
        settleDelayMs = readTimerTimeoutNumber(readValue(), "--settle-delay-ms", 0);
        break;
      case "--output-dir":
        outputDir = path.resolve(readValue());
        break;
      case "--keep":
        keep = true;
        break;
      case "--allow-non-darwin":
        allowNonDarwin = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (mode !== "fixed" && mode !== "leak" && mode !== "report") {
    throw new Error('--mode must be "fixed", "leak", or "report"');
  }
  fileCount ??= readPositiveNumberEnv("OPENCLAW_MEMORY_FD_REPRO_FILES", DEFAULT_FILE_COUNT);
  maxWorkspaceRegFds ??= readNumberEnv(
    "OPENCLAW_MEMORY_FD_REPRO_MAX_WORKSPACE_REG_FDS",
    DEFAULT_MAX_WORKSPACE_REG_FDS,
  );
  invokeTimeoutMs ??= readTimerTimeoutNumberEnv("OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS", 30_000);
  sampleDelayMs ??= readTimerTimeoutNumberEnv("OPENCLAW_MEMORY_FD_REPRO_SAMPLE_DELAY_MS", 1_000, 0);
  settleDelayMs ??= readTimerTimeoutNumberEnv("OPENCLAW_MEMORY_FD_REPRO_SETTLE_DELAY_MS", 5_000, 0);
  if (!Number.isFinite(fileCount) || fileCount <= 0) {
    throw new Error("file count must be greater than 0");
  }
  if (!Number.isFinite(maxWorkspaceRegFds) || maxWorkspaceRegFds < 0) {
    throw new Error("max workspace REG FD threshold must be non-negative");
  }
  return {
    fileCount,
    mode,
    maxWorkspaceRegFds,
    minLeakedFds: minLeakedFds ?? Math.min(fileCount, 64),
    invokeTimeoutMs,
    sampleDelayMs,
    settleDelayMs,
    outputDir,
    keep,
    allowNonDarwin,
  };
}

function logStep(message: string) {
  console.log(`[memory-fd-repro] ${message}`);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, resolveTimerTimeoutMs(ms, 0, 0));
  });
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function distributeFileCounts(total: number) {
  const exact = ISSUE_FILE_COUNTS.map(([dir, count]) => ({
    dir,
    count: Math.floor((count / ISSUE_MEMORY_FILE_COUNT) * total),
    remainder: (count / ISSUE_MEMORY_FILE_COUNT) * total,
  }));
  let assigned = exact.reduce((sum, entry) => sum + entry.count, 0);
  for (const entry of exact.toSorted((a, b) => b.remainder - a.remainder)) {
    if (assigned >= total) {
      break;
    }
    entry.count += 1;
    assigned += 1;
  }
  return exact
    .filter((entry) => entry.count > 0)
    .map(({ dir, count }) => [dir, count] satisfies [string, number]);
}

function writeSyntheticWorkspace(workspaceDir: string, fileCount: number) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "MEMORY.md"),
    "# Memory\n\nTop-level memory file for FD repro.\n",
  );

  for (const [relativeDir, count] of distributeFileCounts(fileCount)) {
    const dir = path.join(workspaceDir, relativeDir);
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 1; index <= count; index += 1) {
      const name = `${String(index).padStart(5, "0")}.md`;
      fs.writeFileSync(
        path.join(dir, name),
        `# ${relativeDir} ${index}\n\nSynthetic memory note ${index}.\n`,
      );
    }
  }
}

/**
 * Writes isolated OpenClaw config for the synthetic memory workspace.
 */
export function writeConfig({ homeDir, workspaceDir, port, token }: ConfigOptions) {
  const configDir = path.join(homeDir, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  const config = {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
      entries: {
        main: {
          default: true,
          tools: { allow: ["memory_search"] },
        },
      },
    },
    memory: {
      search: {
        provider: "none",
        model: "",
        store: {
          vector: { enabled: false },
        },
      },
    },
    plugins: { allow: ["memory-core"] },
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function formatTail(text: string, maxChars = 4096) {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function preindexSyntheticMemory(env: NodeJS.ProcessEnv) {
  logStep("preindex start");
  const result = spawnSync(
    process.execPath,
    ["scripts/run-node.mjs", "memory", "index", "--force", "--agent", "main"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        `memory preindex failed with exit ${result.status ?? result.signal}`,
        formatTail(result.stdout || ""),
        formatTail(result.stderr || ""),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  logStep("preindex complete");
}

/**
 * Updates bounded gateway-ready output state from a stdout/stderr chunk.
 */
export function updateGatewayReadyOutputState(
  state: GatewayReadyOutputState,
  chunk: string,
  maxChars = GATEWAY_READY_OUTPUT_MAX_CHARS,
) {
  const combined = `${state.tail ?? ""}${chunk}`;
  return {
    tail: combined.length > maxChars ? combined.slice(-maxChars) : combined,
    readySeen: state.readySeen || combined.includes("[gateway] ready"),
  };
}

function runLsofForPid(pid: number) {
  const result = spawnSync("lsof", ["-nP", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`lsof failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function findGatewayPid(port: number) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && result.stdout.trim() === "") {
    return null;
  }
  const pid = Number(result.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function sampleFds({ label, pid, workspaceRealPath }: FdSampleOptions) {
  const output = runLsofForPid(pid);
  const workspacePrefix = `${workspaceRealPath}${path.sep}`;
  const workspaceMarkdownPaths: string[] = [];
  let total = 0;
  let reg = 0;

  for (const line of output.split("\n").slice(1)) {
    if (!line.trim()) {
      continue;
    }
    total += 1;
    const columns = line.trim().split(/\s+/);
    const type = columns[4];
    const filePath = columns[columns.length - 1];
    if (type === "REG") {
      reg += 1;
    }
    if (
      type === "REG" &&
      filePath?.startsWith(workspacePrefix) &&
      (filePath === path.join(workspaceRealPath, "MEMORY.md") ||
        (filePath.startsWith(path.join(workspaceRealPath, "memory") + path.sep) &&
          filePath.endsWith(".md")))
    ) {
      workspaceMarkdownPaths.push(filePath);
    }
  }

  const sample = {
    label,
    totalFds: total,
    regFds: reg,
    workspaceMarkdownRegFds: workspaceMarkdownPaths.length,
    uniqueWorkspaceMarkdownRegFds: new Set(workspaceMarkdownPaths).size,
    sampledAt: new Date().toISOString(),
  };
  logStep(
    `${label}: total=${sample.totalFds} reg=${sample.regFds} workspace_md_reg=${sample.workspaceMarkdownRegFds} unique_workspace_md_reg=${sample.uniqueWorkspaceMarkdownRegFds}`,
  );
  return sample;
}

/**
 * Reports whether a spawned child has already exited.
 */
export function hasChildExited(child: ChildExitState) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Waits until gateway output and listener state both indicate readiness.
 */
export async function waitForGatewayReady({
  child,
  port,
  logPath,
  timeoutMs,
}: GatewayReadyOptions) {
  const startedAt = Date.now();
  let outputState = { tail: "", readySeen: false };
  const append = (chunk: Uint8Array | string) => {
    const text = chunk.toString();
    outputState = updateGatewayReadyOutputState(outputState, text);
    fs.appendFileSync(logPath, text);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  while (Date.now() - startedAt < timeoutMs) {
    if (outputState.readySeen && findGatewayPid(port)) {
      return;
    }
    if (hasChildExited(child)) {
      throw new Error(`gateway exited before ready; see ${logPath}`);
    }
    await sleep(100);
  }
  throw new Error(`gateway did not become ready within ${timeoutMs}ms; see ${logPath}`);
}

/**
 * Stops the gateway child using the default process/runtime hooks.
 */
export async function stopGateway({ child, port }: { child: StoppableGatewayChild; port: number }) {
  return stopGatewayWithRuntime({
    child,
    port,
    findGatewayPidFn: findGatewayPid,
    killProcess: (pid, signal) => process.kill(pid, signal),
  });
}

/**
 * Stops the gateway child and any remaining listener process.
 */
export async function stopGatewayWithRuntime({
  child,
  childExitPollIntervalMs = 100,
  childExitPolls = 50,
  port,
  findGatewayPidFn,
  killProcess,
  listenerSettleDelayMs = 500,
}: {
  child: StoppableGatewayChild;
  childExitPollIntervalMs?: number;
  childExitPolls?: number;
  port: number;
  findGatewayPidFn: (port: number) => number | null;
  killProcess: (pid: number, signal: GatewaySignal) => unknown;
  listenerSettleDelayMs?: number;
}) {
  if (!hasChildExited(child)) {
    signalChild(child, "SIGINT");
    await waitForChildExit(child, { intervalMs: childExitPollIntervalMs, polls: childExitPolls });
  }
  const listenerPid = findGatewayPidFn(port);
  if (listenerPid) {
    try {
      killProcess(listenerPid, "SIGTERM");
    } catch {}
    await sleep(listenerSettleDelayMs);
    const stillListening = findGatewayPidFn(port);
    if (stillListening) {
      try {
        killProcess(stillListening, "SIGKILL");
      } catch {}
    }
  }
  if (!hasChildExited(child)) {
    signalChild(child, "SIGKILL");
    await waitForChildExit(child, { intervalMs: childExitPollIntervalMs, polls: childExitPolls });
  }
}

/**
 * Reads an HTTP response body up to a configured byte limit.
 */
function signalChild(child: StoppableGatewayChild, signal: GatewaySignal) {
  try {
    child.kill(signal);
  } catch {}
}

async function waitForChildExit(
  child: ChildExitState,
  { intervalMs, polls }: { intervalMs: number; polls: number },
) {
  for (let i = 0; i < polls; i += 1) {
    if (hasChildExited(child)) {
      return true;
    }
    await sleep(intervalMs);
  }
  return hasChildExited(child);
}

function parseToolTextContent(result: Record<string, unknown> | null) {
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const entry of content) {
    const record = asRecord(entry);
    const text = record?.type === "text" && typeof record.text === "string" ? record.text : null;
    if (!text) {
      continue;
    }
    const parsed = asRecord(safeParseJson(text));
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

/**
 * Classifies the memory_search HTTP response into success/error details.
 */
export function classifyMemorySearchInvokeResponse({
  httpOk,
  status,
  bodyText,
}: InvokeResponseOptions) {
  const parsedBody = safeParseJson(bodyText);
  const body = asRecord(parsedBody);
  if (!httpOk) {
    const errorRecord = asRecord(body?.error);
    return {
      ok: false,
      httpOk,
      status,
      gatewayOk: body?.ok === true ? true : body?.ok === false ? false : undefined,
      error:
        readNonBlankString(errorRecord?.message) ??
        readNonBlankString(body?.error) ??
        `memory_search HTTP request failed with status ${status}`,
    };
  }
  if (!body) {
    return {
      ok: false,
      httpOk,
      status,
      error: "memory_search response was not JSON",
    };
  }

  const gatewayOk = body.ok === true ? true : body.ok === false ? false : undefined;
  if (gatewayOk === false) {
    const errorRecord = asRecord(body.error);
    return {
      ok: false,
      httpOk,
      status,
      gatewayOk,
      error:
        readNonBlankString(errorRecord?.message) ??
        readNonBlankString(body.error) ??
        "memory_search gateway invocation failed",
    };
  }

  const result = asRecord(body.result);
  const details = asRecord(result?.details);
  const directResult = Array.isArray(result?.results) ? result : null;
  const directBody =
    Array.isArray(body.results) || body.disabled === true || body.unavailable === true
      ? body
      : null;
  const payload = details ?? parseToolTextContent(result) ?? directResult ?? directBody;
  if (!payload) {
    return {
      ok: false,
      httpOk,
      status,
      gatewayOk,
      error: "memory_search result payload missing or invalid",
    };
  }
  const resultCount = Array.isArray(payload.results) ? payload.results.length : undefined;
  const toolDisabled = payload.disabled === true;
  const toolUnavailable = payload.unavailable === true;
  const toolError = readNonBlankString(payload.error);
  const ok = gatewayOk === true && !toolDisabled && !toolUnavailable && !toolError;

  return {
    ok,
    httpOk,
    status,
    gatewayOk,
    resultCount,
    toolDisabled,
    toolUnavailable,
    ...(toolError ? { toolError } : {}),
    ...(ok
      ? {}
      : {
          error:
            toolError ??
            (toolDisabled || toolUnavailable
              ? "memory_search returned disabled/unavailable"
              : "memory_search result payload missing or invalid"),
        }),
  };
}

export async function invokeMemorySearch({ port, token, timeoutMs }: InvokeOptions) {
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tool: "memory_search",
        args: {
          query: MEMORY_SEARCH_PROBE_QUERY,
          maxResults: 1,
          corpus: "memory",
        },
        sessionKey: "main",
      }),
      signal: controller.signal,
    });
    const text = await readBoundedResponseText(
      res,
      "memory_search",
      MEMORY_SEARCH_RESPONSE_MAX_BYTES,
    );
    const result = classifyMemorySearchInvokeResponse({
      httpOk: res.ok,
      status: res.status,
      bodyText: text,
    });
    return {
      ...result,
      durationMs: Date.now() - startedAt,
      bodyPreview: text.slice(0, 500),
    };
  } catch (error) {
    return {
      ok: false,
      aborted: error instanceof Error && error.name === "AbortError",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

type FailureOptions = {
  invokePassed: boolean;
  options: ReturnType<typeof parseArgs>;
  peak: number;
};

function formatFailure({ invokePassed, options, peak }: FailureOptions) {
  if (options.mode === "fixed" && !invokePassed) {
    return `memory_search did not complete successfully; see summary invoke details`;
  }
  if (options.mode === "fixed") {
    return `workspace Markdown REG FDs peaked at ${peak}, above max ${options.maxWorkspaceRegFds}`;
  }
  if (options.mode === "leak") {
    return `workspace Markdown REG FDs peaked at ${peak}, below leak threshold ${options.minLeakedFds}`;
  }
  return "";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin" && !options.allowNonDarwin) {
    console.log(
      `[memory-fd-repro] skipped: lsof REG watcher counts are macOS-focused; pass --allow-non-darwin to run on ${process.platform}`,
    );
    return;
  }

  const lsofAvailable = spawnSync("lsof", ["-v"], { stdio: "ignore" }).status === 0;
  if (!lsofAvailable) {
    throw new Error("lsof is required for memory FD repro instrumentation");
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-fd-repro-"));
  const homeDir = path.join(rootDir, "home");
  const workspaceDir = path.join(rootDir, "workspace");
  fs.mkdirSync(options.outputDir, { recursive: true });

  const port = await getFreePort();
  const token = `memory-fd-repro-${process.pid}`;
  writeSyntheticWorkspace(workspaceDir, options.fileCount);
  const configPath = writeConfig({ homeDir, workspaceDir, port, token });
  const workspaceRealPath = fs.realpathSync.native(workspaceDir);
  const logPath = path.join(options.outputDir, "gateway.log");

  const env = {
    ...process.env,
    ...SKIP_GATEWAY_ENV,
    HOME: homeDir,
    OPENCLAW_STATE_DIR: path.join(homeDir, ".openclaw"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_TOKEN: token,
  };
  let child: GatewayChild | undefined;
  const generatedAt = new Date().toISOString();

  try {
    preindexSyntheticMemory(env);
    child = spawn(
      process.execPath,
      [
        "scripts/run-node.mjs",
        "gateway",
        "run",
        "--port",
        String(port),
        "--auth",
        "token",
        "--token",
        token,
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    logStep(`workspace=${workspaceDir}`);
    logStep(`files=${options.fileCount} mode=${options.mode} port=${port}`);
    await waitForGatewayReady({ child, port, logPath, timeoutMs: 60_000 });
    const pid = findGatewayPid(port);
    if (!pid) {
      throw new Error("gateway listener pid not found after ready");
    }
    const samples = [sampleFds({ label: "baseline", pid, workspaceRealPath })];

    const invokePromise = invokeMemorySearch({ port, token, timeoutMs: options.invokeTimeoutMs });
    await sleep(options.sampleDelayMs);
    samples.push(sampleFds({ label: "during", pid, workspaceRealPath }));
    const invoke = await invokePromise;
    logStep(`invoke=${JSON.stringify(invoke)}`);
    await sleep(options.settleDelayMs);
    samples.push(sampleFds({ label: "settled", pid, workspaceRealPath }));

    const peak = Math.max(...samples.map((sample) => sample.uniqueWorkspaceMarkdownRegFds));
    const invokePassed = invoke.ok;
    const passed =
      options.mode === "report" ||
      (options.mode === "fixed" && invokePassed && peak <= options.maxWorkspaceRegFds) ||
      (options.mode === "leak" && peak >= options.minLeakedFds);
    const failure = passed ? undefined : formatFailure({ invokePassed, options, peak });
    const summary = {
      generatedAt,
      platform: process.platform,
      mode: options.mode,
      fileCount: options.fileCount,
      expectedMarkdownFiles: options.fileCount + 1,
      thresholds: {
        maxWorkspaceRegFds: options.maxWorkspaceRegFds,
        minLeakedFds: options.minLeakedFds,
      },
      rootDir,
      outputDir: options.outputDir,
      samples,
      invoke,
      gatewayPid: pid,
      peakUniqueWorkspaceMarkdownRegFds: peak,
      passed,
      failure,
    };

    fs.writeFileSync(
      path.join(options.outputDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    logStep(`summary=${path.join(options.outputDir, "summary.json")}`);
    if (!passed) {
      throw new Error(failure);
    }
  } finally {
    if (child) {
      await stopGateway({ child, port });
    }
    if (!options.keep) {
      fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } else {
      logStep(`kept synthetic root=${rootDir}`);
    }
  }
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(
      `[memory-fd-repro] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
