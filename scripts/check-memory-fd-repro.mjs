#!/usr/bin/env node

// Reproduces memory-search file descriptor retention with a synthetic workspace.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mjs";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";

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
];

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
export const MEMORY_SEARCH_RESPONSE_MAX_BYTES = 256 * 1024;
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
Usage: node scripts/check-memory-fd-repro.mjs [options]

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

const NON_NEGATIVE_INTEGER_PATTERN = /^(0|[1-9]\d*)$/u;
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

function stripPackageManagerSeparatorForKnownFlags(argv) {
  return argv[0] === "--" && ARGUMENT_FLAGS.has(argv[1])
    ? stripLeadingPackageManagerSeparator(argv)
    : argv;
}

/**
 * Parses a safe non-negative integer option.
 */
export function readNumber(value, label) {
  const raw = String(value).trim();
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(raw)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return parsed;
}

/**
 * Parses a safe positive integer option.
 */
export function readPositiveNumber(value, label) {
  const parsed = readNumber(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be greater than 0`);
  }
  return parsed;
}

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : readNumber(raw, name);
}

function readPositiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : readPositiveNumber(raw, name);
}

/**
 * Parses memory FD repro CLI arguments and environment fallbacks.
 */
export function parseArgs(argv) {
  const args = stripPackageManagerSeparatorForKnownFlags(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const options = {
    fileCount: undefined,
    mode: process.env.OPENCLAW_MEMORY_FD_REPRO_MODE || "fixed",
    maxWorkspaceRegFds: undefined,
    minLeakedFds: undefined,
    invokeTimeoutMs: undefined,
    sampleDelayMs: undefined,
    settleDelayMs: undefined,
    outputDir: path.resolve(".artifacts", "memory-fd-repro", stamp),
    keep: process.env.OPENCLAW_MEMORY_FD_REPRO_KEEP === "1",
    allowNonDarwin: process.env.OPENCLAW_MEMORY_FD_REPRO_ALLOW_NON_DARWIN === "1",
  };

  parseArgv: for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    const readValue = () => {
      if (!next) {
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
        options.fileCount = ISSUE_MEMORY_FILE_COUNT;
        break;
      case "--files":
        options.fileCount = readPositiveNumber(readValue(), "--files");
        break;
      case "--mode":
        options.mode = readValue();
        break;
      case "--expect-leak":
        options.mode = "leak";
        break;
      case "--report-only":
        options.mode = "report";
        break;
      case "--max-workspace-reg-fds":
        options.maxWorkspaceRegFds = readNumber(readValue(), "--max-workspace-reg-fds");
        break;
      case "--min-leaked-fds":
        options.minLeakedFds = readPositiveNumber(readValue(), "--min-leaked-fds");
        break;
      case "--invoke-timeout-ms":
        options.invokeTimeoutMs = readPositiveNumber(readValue(), "--invoke-timeout-ms");
        break;
      case "--sample-delay-ms":
        options.sampleDelayMs = readNumber(readValue(), "--sample-delay-ms");
        break;
      case "--settle-delay-ms":
        options.settleDelayMs = readNumber(readValue(), "--settle-delay-ms");
        break;
      case "--output-dir":
        options.outputDir = path.resolve(readValue());
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--allow-non-darwin":
        options.allowNonDarwin = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["fixed", "leak", "report"].includes(options.mode)) {
    throw new Error('--mode must be "fixed", "leak", or "report"');
  }
  options.fileCount ??= readPositiveNumberEnv("OPENCLAW_MEMORY_FD_REPRO_FILES", DEFAULT_FILE_COUNT);
  options.maxWorkspaceRegFds ??= readNumberEnv(
    "OPENCLAW_MEMORY_FD_REPRO_MAX_WORKSPACE_REG_FDS",
    DEFAULT_MAX_WORKSPACE_REG_FDS,
  );
  options.invokeTimeoutMs ??= readPositiveNumberEnv("OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS", 30_000);
  options.sampleDelayMs ??= readNumberEnv("OPENCLAW_MEMORY_FD_REPRO_SAMPLE_DELAY_MS", 1_000);
  options.settleDelayMs ??= readNumberEnv("OPENCLAW_MEMORY_FD_REPRO_SETTLE_DELAY_MS", 5_000);
  if (!Number.isFinite(options.fileCount) || options.fileCount <= 0) {
    throw new Error("file count must be greater than 0");
  }
  if (!Number.isFinite(options.maxWorkspaceRegFds) || options.maxWorkspaceRegFds < 0) {
    throw new Error("max workspace REG FD threshold must be non-negative");
  }
  if (options.minLeakedFds === undefined) {
    options.minLeakedFds = Math.min(options.fileCount, 64);
  }
  return options;
}

function logStep(message) {
  console.log(`[memory-fd-repro] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
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

function distributeFileCounts(total) {
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
  return exact.filter((entry) => entry.count > 0).map(({ dir, count }) => [dir, count]);
}

function writeSyntheticWorkspace(workspaceDir, fileCount) {
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
export function writeConfig({ homeDir, workspaceDir, port, token }) {
  const configDir = path.join(homeDir, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  const indexPath = path.join(configDir, "memory", "main.sqlite");
  const config = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "none",
          model: "",
          store: {
            path: indexPath,
            vector: { enabled: false },
          },
          sync: {
            watch: true,
            onSessionStart: false,
            onSearch: false,
          },
        },
      },
      list: [
        {
          id: "main",
          default: true,
          tools: { allow: ["memory_search"] },
        },
      ],
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

function formatTail(text, maxChars = 4096) {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function preindexSyntheticMemory(env) {
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
  state,
  chunk,
  maxChars = GATEWAY_READY_OUTPUT_MAX_CHARS,
) {
  const text = String(chunk);
  const combined = `${state.tail ?? ""}${text}`;
  return {
    tail: combined.length > maxChars ? combined.slice(-maxChars) : combined,
    readySeen: Boolean(state.readySeen || combined.includes("[gateway] ready")),
  };
}

function runLsofForPid(pid) {
  const result = spawnSync("lsof", ["-nP", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`lsof failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function findGatewayPid(port) {
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

function sampleFds({ label, pid, workspaceRealPath }) {
  const output = runLsofForPid(pid);
  const workspacePrefix = `${workspaceRealPath}${path.sep}`;
  const workspaceMarkdownPaths = [];
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
export function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Waits until gateway output and listener state both indicate readiness.
 */
export async function waitForGatewayReady({ child, port, logPath, timeoutMs }) {
  const startedAt = Date.now();
  let outputState = { tail: "", readySeen: false };
  const append = (chunk) => {
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
export async function stopGateway({ child, port }) {
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
export { readBoundedResponseText };

function signalChild(child, signal) {
  try {
    child.kill(signal);
  } catch {}
}

async function waitForChildExit(child, { intervalMs, polls }) {
  for (let i = 0; i < polls; i += 1) {
    if (hasChildExited(child)) {
      return true;
    }
    await sleep(intervalMs);
  }
  return hasChildExited(child);
}

function parseJsonValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readStringProperty(record, key) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseToolTextContent(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const entry of content) {
    const text = entry?.type === "text" && typeof entry.text === "string" ? entry.text : null;
    if (!text) {
      continue;
    }
    const parsed = asRecord(parseJsonValue(text));
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

/**
 * Classifies the memory_search HTTP response into success/error details.
 */
export function classifyMemorySearchInvokeResponse({ httpOk, status, bodyText }) {
  const parsedBody = parseJsonValue(bodyText);
  const body = asRecord(parsedBody);
  if (!httpOk) {
    const errorRecord = asRecord(body?.error);
    return {
      ok: false,
      httpOk,
      status,
      gatewayOk: body?.ok === true ? true : body?.ok === false ? false : undefined,
      error:
        readStringProperty(errorRecord, "message") ??
        readStringProperty(body, "error") ??
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
        readStringProperty(errorRecord, "message") ??
        readStringProperty(body, "error") ??
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
  const toolError = readStringProperty(payload, "error");
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

async function invokeMemorySearch({ port, token, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      aborted: error?.name === "AbortError",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatFailure({ invokePassed, options, peak }) {
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
  let child;

  const summary = {
    generatedAt: new Date().toISOString(),
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
    samples: [],
    invoke: null,
  };

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
    summary.gatewayPid = pid;
    summary.samples.push(sampleFds({ label: "baseline", pid, workspaceRealPath }));

    const invokePromise = invokeMemorySearch({ port, token, timeoutMs: options.invokeTimeoutMs });
    await sleep(options.sampleDelayMs);
    summary.samples.push(sampleFds({ label: "during", pid, workspaceRealPath }));
    summary.invoke = await invokePromise;
    logStep(`invoke=${JSON.stringify(summary.invoke)}`);
    await sleep(options.settleDelayMs);
    summary.samples.push(sampleFds({ label: "settled", pid, workspaceRealPath }));

    const peak = Math.max(...summary.samples.map((sample) => sample.uniqueWorkspaceMarkdownRegFds));
    summary.peakUniqueWorkspaceMarkdownRegFds = peak;
    const invokePassed = Boolean(summary.invoke?.ok);
    const passed =
      options.mode === "report" ||
      (options.mode === "fixed" && invokePassed && peak <= options.maxWorkspaceRegFds) ||
      (options.mode === "leak" && peak >= options.minLeakedFds);
    summary.passed = passed;
    summary.failure = passed ? undefined : formatFailure({ invokePassed, options, peak });

    fs.writeFileSync(
      path.join(options.outputDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    logStep(`summary=${path.join(options.outputDir, "summary.json")}`);
    if (!passed) {
      throw new Error(summary.failure);
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
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(
        `[memory-fd-repro] failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
