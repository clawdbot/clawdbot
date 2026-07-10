// Qa Lab plugin module implements gateway child behavior.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  createQaBundledPluginsDir,
  resolveQaBundledPluginSourceDir,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaRuntimeHostVersion,
} from "./bundled-plugin-staging.js";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  formatQaChildOutputTail,
  readQaChildOutput,
} from "./child-output.js";
import { assertRepoBoundPath, ensureRepoBoundDirectory } from "./cli-paths.js";
import { QaSuiteInfraError, toQaErrorObject } from "./errors.js";
import { formatQaGatewayLogsForError, redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import {
  createQaGatewayProcessBoundaryController,
  type QaGatewayProcessBoundaryConfig,
  type QaGatewayVerifiedProcessIdentity,
} from "./gateway-process-boundary.js";
import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";
import { splitQaModelRef, type QaProviderMode } from "./model-selection.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import { readProcessTreeCpuMs, readProcessTreeRssBytes } from "./process-tree-cpu.js";
import {
  normalizeQaProviderModeEnv,
  QA_LIVE_PROVIDER_CONFIG_PATH_ENV,
  resolveQaLiveCliAuthEnv,
  resolveQaLiveProviderConfigPath,
  type QaCliBackendAuthMode,
} from "./providers/env.js";
import { DEFAULT_QA_PROVIDER_MODE, getQaProvider } from "./providers/index.js";
import {
  assertQaLiveCodexAuthAvailable,
  QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV,
  QA_LIVE_SETUP_TOKEN_VALUE_ENV,
  stageQaLiveApiKeyProfiles,
  stageQaLiveAnthropicSetupToken,
} from "./providers/live-frontier/auth.js";
import { stageQaMockAuthProfiles } from "./providers/shared/mock-auth.js";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";
import { buildQaGatewayConfig, type QaThinkingLevel } from "./qa-gateway-config.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { resolveQaWindowsSystem32ExePath } from "./windows-system-tools.js";

export type { QaCliBackendAuthMode } from "./providers/env.js";
const QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS = 5;
const QA_GATEWAY_CHILD_RPC_STARTUP_TIMEOUT_MS = 30_000;
const QA_GATEWAY_CHILD_RPC_RETRY_HEALTH_TIMEOUT_MS = 60_000;
const QA_GATEWAY_CHILD_RESTART_BOUNDARY_TIMEOUT_MS = 90_000;
const QA_GATEWAY_CHILD_BLOCKED_SECRET_ENV_VARS = Object.freeze([
  "OPENCLAW_QA_CONVEX_SECRET_CI",
  "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER",
  "OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL",
  "OPENCLAW_QA_TELEGRAM_GROUP_ID",
  "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
]);

export type QaGatewayChildStateMutationContext = {
  configPath: string;
  runtimeEnv: NodeJS.ProcessEnv;
  stateDir: string;
  tempRoot: string;
};

type QaGatewayChildDirectCommand = {
  executablePath: string;
  argsPrefix?: string[];
  argsSuffix?: string[];
  cwd?: string;
  usePackagedPlugins?: boolean;
  processBoundary?: undefined;
};

type QaGatewayChildVerifiedCommand = Omit<QaGatewayChildDirectCommand, "processBoundary"> & {
  processBoundary: QaGatewayProcessBoundaryConfig;
};

export type QaGatewayChildCommand = QaGatewayChildDirectCommand | QaGatewayChildVerifiedCommand;
export type QaGatewayChildListeningContext = {
  attempt: number;
  baseUrl: string;
  wsUrl: string;
  token: string;
  configPath: string;
  runtimeEnv: NodeJS.ProcessEnv;
};

function scrubQaGatewayChildSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const envKey of QA_GATEWAY_CHILD_BLOCKED_SECRET_ENV_VARS) {
    delete env[envKey];
  }
  return env;
}

function createQaGatewayEmptyTransport() {
  return {
    requiredPluginIds: [] as const,
    createGatewayConfig: () => ({}),
  } satisfies Pick<QaTransportAdapter, "requiredPluginIds" | "createGatewayConfig">;
}

function resolveQaGatewayChildCommand(repoRoot: string): QaGatewayChildCommand {
  for (const relativePath of ["dist/index.mjs", "dist/index.js"]) {
    const entryPath = path.join(repoRoot, relativePath);
    if (existsSync(entryPath)) {
      return {
        executablePath: process.execPath,
        argsPrefix: [entryPath],
        cwd: repoRoot,
        usePackagedPlugins: true,
      };
    }
  }

  const sourceEntryPath = path.join(repoRoot, "src/entry.ts");
  if (existsSync(sourceEntryPath)) {
    return {
      executablePath: process.execPath,
      argsPrefix: ["--import", "tsx", sourceEntryPath],
      cwd: repoRoot,
    };
  }

  throw new Error("OpenClaw CLI entry not found: expected dist/index.(m)js or src/entry.ts");
}

async function runQaGatewayCliCommand(params: {
  executablePath: string;
  argsPrefix: readonly string[];
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const child = spawn(params.executablePath, [...params.argsPrefix, ...params.args], {
    cwd: params.cwd,
    env: { ...params.env, OPENCLAW_CLI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return await readQaGatewayCliCommand(child);
}

type QaChildFailure = {
  source: "process" | "stdout" | "stderr";
  error: unknown;
};

function monitorQaChildFailure(child: ChildProcess, onFailure: (failure: QaChildFailure) => void) {
  let reported = false;
  const report = (source: QaChildFailure["source"]) => (error: unknown) => {
    if (reported) {
      return;
    }
    reported = true;
    onFailure({ source, error });
  };
  child.once("error", report("process"));
  child.stdout?.once("error", report("stdout"));
  child.stderr?.once("error", report("stderr"));
}

async function readQaGatewayCliCommand(child: ChildProcess): Promise<string> {
  const stdout = createQaChildOutputCapture();
  const stderr = createQaChildOutputTail();
  child.stdout?.on("data", (chunk) => appendQaChildOutput(stdout, chunk));
  child.stderr?.on("data", (chunk) => appendQaChildOutputTail(stderr, chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    monitorQaChildFailure(child, (failure) => {
      if (failure.source === "process") {
        reject(toQaErrorObject(failure.error, "OpenClaw CLI process failed"));
        return;
      }
      if (!hasChildExited(child) && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child exited between the state check and signal.
        }
      }
      reject(
        new Error(
          `qa gateway cli ${failure.source} stream failed: ${formatErrorMessage(failure.error)}`,
          { cause: failure.error },
        ),
      );
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
  const stdoutText = readQaChildOutput(stdout);
  if (exitCode !== 0) {
    const stderrText = formatQaChildOutputTail(stderr, "stderr");
    throw new Error(`OpenClaw CLI exited ${exitCode}: ${stderrText || stdoutText}`);
  }
  return stdoutText;
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => reject(error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function closeWriteStream(stream: WriteStream) {
  await new Promise<void>((resolve) => {
    stream.end(() => resolve());
  });
}

async function writeSanitizedQaGatewayDebugLog(params: { sourcePath: string; targetPath: string }) {
  const contents = await fs.readFile(params.sourcePath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  await fs.writeFile(params.targetPath, redactQaGatewayDebugText(contents), "utf8");
}

async function assertQaArtifactDirWithinRepo(repoRoot: string, artifactDir: string) {
  return await assertRepoBoundPath(repoRoot, artifactDir, "QA gateway artifact directory");
}

async function clearQaGatewayArtifactDir(dir: string) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function cleanupQaGatewayTempRoots(params: {
  tempRoot: string;
  stagedBundledPluginsRoot?: string | null;
}) {
  await fs.rm(params.tempRoot, { recursive: true, force: true }).catch(() => {});
  if (params.stagedBundledPluginsRoot) {
    await fs.rm(params.stagedBundledPluginsRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function preserveQaGatewayDebugArtifacts(params: {
  preserveToDir: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  tempRoot: string;
  repoRoot?: string;
}) {
  const preserveToDir = params.repoRoot
    ? await ensureRepoBoundDirectory(
        params.repoRoot,
        params.preserveToDir,
        "QA gateway artifact directory",
        {
          mode: 0o700,
        },
      )
    : params.preserveToDir;
  await fs.mkdir(preserveToDir, { recursive: true, mode: 0o700 });
  await clearQaGatewayArtifactDir(preserveToDir);
  await Promise.all([
    writeSanitizedQaGatewayDebugLog({
      sourcePath: params.stdoutLogPath,
      targetPath: path.join(preserveToDir, "gateway.stdout.log"),
    }),
    writeSanitizedQaGatewayDebugLog({
      sourcePath: params.stderrLogPath,
      targetPath: path.join(preserveToDir, "gateway.stderr.log"),
    }),
  ]);
  await fs.writeFile(
    path.join(preserveToDir, "README.txt"),
    [
      "Only sanitized gateway debug artifacts are preserved here.",
      "The full QA gateway runtime was not copied because it may contain credentials or auth tokens.",
      "Original runtime temp root omitted because local temp paths can identify the runner.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function isRetryableGatewayStartupError(details: string) {
  return (
    details.includes("another gateway instance is already listening on ws://") ||
    details.includes("failed to bind gateway socket on ws://") ||
    details.includes("EADDRINUSE") ||
    details.includes("address already in use")
  );
}

function appendQaGatewayTempRoot(details: string, tempRoot: string) {
  return details.includes(tempRoot)
    ? details
    : `${details}\nQA gateway temp root preserved at ${tempRoot}`;
}

export function resolveQaGatewayChildProviderMode(providerMode?: QaProviderMode): QaProviderMode {
  return providerMode ?? DEFAULT_QA_PROVIDER_MODE;
}

export function buildQaRuntimeEnv(params: {
  configPath: string;
  gatewayToken: string;
  homeDir: string;
  forwardHostHome?: boolean;
  stateDir: string;
  tempRoot: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgCacheHome: string;
  bundledPluginsDir?: string;
  stagedBundledPluginsRoot?: string | null;
  compatibilityHostVersion?: string;
  providerMode?: QaProviderMode;
  baseEnv?: NodeJS.ProcessEnv;
  runtimeEnvPatch?: NodeJS.ProcessEnv;
  forwardHostHomeForClaudeCli?: boolean;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const baseEnv = params.baseEnv ?? process.env;
  const provider = params.providerMode ? getQaProvider(params.providerMode) : null;
  const forwardedHostHome = params.forwardHostHome
    ? baseEnv.HOME?.trim() || os.homedir()
    : undefined;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: forwardedHostHome ?? params.homeDir,
    ...(provider?.appliesLiveEnvAliases
      ? resolveQaLiveCliAuthEnv(baseEnv, {
          forwardHostHomeForClaudeCli: params.forwardHostHomeForClaudeCli,
          claudeCliAuthMode: params.claudeCliAuthMode,
        })
      : {}),
    OPENCLAW_HOME: params.homeDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_OAUTH_DIR: path.join(params.stateDir, "credentials"),
    OPENCLAW_GATEWAY_TOKEN: params.gatewayToken,
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_TEST_FAST: "1",
    OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS: "2000",
    OPENCLAW_QA_PARENT_PID: String(process.pid),
    OPENCLAW_QA_TEMP_ROOT: params.tempRoot,
    ...(params.stagedBundledPluginsRoot
      ? { OPENCLAW_QA_STAGED_RUNTIME_ROOT: params.stagedBundledPluginsRoot }
      : {}),
    OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER: "1",
    // QA uses the fast runtime envelope for speed, but it still exercises
    // normal config-driven heartbeats and runtime config writes.
    OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
    XDG_CONFIG_HOME: params.xdgConfigHome,
    XDG_DATA_HOME: params.xdgDataHome,
    XDG_CACHE_HOME: params.xdgCacheHome,
    ...(params.bundledPluginsDir ? { OPENCLAW_BUNDLED_PLUGINS_DIR: params.bundledPluginsDir } : {}),
    ...(params.compatibilityHostVersion
      ? { OPENCLAW_COMPATIBILITY_HOST_VERSION: params.compatibilityHostVersion }
      : {}),
  };
  const normalizedEnv = normalizeQaProviderModeEnv(env, params.providerMode);
  Object.assign(normalizedEnv, params.runtimeEnvPatch);
  delete normalizedEnv[QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV];
  delete normalizedEnv[QA_LIVE_SETUP_TOKEN_VALUE_ENV];
  return scrubQaGatewayChildSecretEnv(normalizedEnv);
}

function isRetryableGatewayCallError(details: string): boolean {
  return (
    details.includes("handshake timeout") ||
    details.includes("gateway closed (1000") ||
    details.includes("gateway closed (1012)") ||
    details.includes("gateway closed (1006") ||
    details.includes("abnormal closure") ||
    details.includes("service restart")
  );
}

function createQaGatewayChildLogCollector() {
  const chunks: Buffer[] = [];
  return {
    push(chunk: Buffer) {
      chunks.push(Buffer.from(chunk));
    },
    text() {
      return Buffer.concat(chunks).toString("utf8").trim();
    },
  };
}

function formatQaGatewayChildFailure(failure: QaChildFailure) {
  return failure.source === "process"
    ? `gateway failed to spawn: ${formatErrorMessage(failure.error)}`
    : `gateway child ${failure.source} stream failed: ${formatErrorMessage(failure.error)}`;
}

function throwQaGatewayChildFailure(
  getChildFailure: (() => QaChildFailure | null) | undefined,
  logs: () => string,
) {
  const failure = getChildFailure?.();
  if (!failure) {
    return;
  }
  throw new QaSuiteInfraError(
    "gateway_startup_unhealthy",
    `${formatQaGatewayChildFailure(failure)}\n${logs()}`,
    { cause: failure.error },
  );
}

function monitorQaGatewayChildFailure(child: ChildProcess, output: { push(chunk: Buffer): void }) {
  let childFailure: QaChildFailure | null = null;
  monitorQaChildFailure(child, (failure) => {
    childFailure = failure;
    const description =
      failure.source === "process"
        ? `gateway child process error: ${formatErrorMessage(failure.error)}`
        : formatQaGatewayChildFailure(failure);
    output.push(Buffer.from(`[qa-lab] ${description}\n`));
    if (failure.source !== "process" && !hasChildExited(child)) {
      // A broken parent-side pipe means QA can no longer observe the Gateway.
      // Stop the detached process tree so the existing lifecycle reports the failure.
      signalQaGatewayChildProcessTree(child, "SIGTERM");
    }
  });
  return () => childFailure;
}

async function fetchLocalGatewayHealth(params: {
  baseUrl: string;
  healthPath: "/readyz" | "/healthz";
}): Promise<boolean> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${params.baseUrl}${params.healthPath}`,
    init: {
      method: "HEAD",
      headers: {
        connection: "close",
      },
      signal: AbortSignal.timeout(2_000),
    },
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-gateway-child-health",
  });
  try {
    return response.ok;
  } finally {
    await release();
  }
}

async function fetchLocalGatewayListening(baseUrl: string): Promise<boolean> {
  const { release } = await fetchWithSsrFGuard({
    url: `${baseUrl}/healthz`,
    init: {
      method: "HEAD",
      headers: {
        connection: "close",
      },
      signal: AbortSignal.timeout(2_000),
    },
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-gateway-child-listening",
  });
  await release();
  return true;
}

async function waitForQaGatewayRestartBoundary(params: {
  logs: () => string;
  offset: number;
  pollMs?: number;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? QA_GATEWAY_CHILD_RESTART_BOUNDARY_TIMEOUT_MS;
  const pollMs = resolveTimerTimeoutMs(params.pollMs ?? 100, 100, 0);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (params.logs().slice(params.offset).includes("restart mode:")) {
      return;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollMs, remainingMs));
  }
  throw new Error(`qa gateway child did not reach restart boundary within ${timeoutMs}ms`);
}

export const testing = {
  assertQaArtifactDirWithinRepo,
  buildQaRuntimeEnv,
  cleanupQaGatewayTempRoots,
  fetchLocalGatewayHealth,
  isRetryableGatewayCallError,
  isRetryableRpcStartupError,
  isRetryableGatewayStartupError,
  preserveQaGatewayDebugArtifacts,
  redactQaGatewayDebugText,
  readQaLiveProviderConfigOverrides,
  resolveQaGatewayChildProviderMode,
  resolveQaGatewayChildCommand,
  createQaGatewayEmptyTransport,
  assertQaLiveCodexAuthAvailable,
  stageQaLiveApiKeyProfiles,
  stageQaLiveAnthropicSetupToken,
  stageQaMockAuthProfiles,
  resolveQaLiveCliAuthEnv,
  waitForQaGatewayRestartBoundary,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaBundledPluginSourceDir,
  resolveQaRuntimeHostVersion,
  runQaGatewayCliCommand,
  readQaGatewayCliCommand,
  createQaGatewayChildLogCollector,
  monitorQaGatewayChildFailure,
  throwQaGatewayChildFailure,
  createQaBundledPluginsDir,
  signalQaGatewayChildProcessTree,
  stopQaGatewayChildProcessTree,
};

function hasChildExited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

function isProcessAlreadyExitedError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
}

function isQaGatewayChildProcessTreeAlive(child: ChildProcess) {
  if (!child.pid) {
    return false;
  }
  if (process.platform === "win32") {
    return !hasChildExited(child);
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (!isProcessAlreadyExitedError(error) && !hasChildExited(child)) {
      return true;
    }
  }
  return false;
}

type QaGatewayTaskkillRunner = typeof spawnSync;

function signalQaGatewayWindowsProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  runTaskkill: QaGatewayTaskkillRunner = spawnSync,
) {
  const taskkillPath = resolveQaWindowsSystem32ExePath("taskkill.exe");
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  const result = runTaskkill(taskkillPath, args, {
    stdio: "ignore",
    windowsHide: true,
  });
  if (!result.error && result.status === 0) {
    return true;
  }
  if (signal !== "SIGKILL") {
    const forceResult = runTaskkill(taskkillPath, [...args, "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !forceResult.error && forceResult.status === 0;
  }
  return false;
}

function signalQaGatewayChildProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  runTaskkill: QaGatewayTaskkillRunner = spawnSync,
) {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      if (signalQaGatewayWindowsProcessTree(child.pid, signal, runTaskkill)) {
        return;
      }
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
}

async function waitForQaGatewayChildExit(child: ChildProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isQaGatewayChildProcessTreeAlive(child)) {
      return true;
    }
    await sleep(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  return !isQaGatewayChildProcessTreeAlive(child);
}

async function stopQaGatewayChildProcessTree(
  child: ChildProcess,
  opts?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number },
) {
  if (!isQaGatewayChildProcessTreeAlive(child)) {
    return;
  }
  signalQaGatewayChildProcessTree(child, "SIGTERM");
  if (await waitForQaGatewayChildExit(child, opts?.gracefulTimeoutMs ?? 5_000)) {
    return;
  }
  signalQaGatewayChildProcessTree(child, "SIGKILL");
  const stopped = await waitForQaGatewayChildExit(child, opts?.forceTimeoutMs ?? 2_000);
  if (!stopped) {
    throw new Error("qa gateway process tree remained alive after forced shutdown");
  }
}

type QaGatewayProcessBoundaryController = Awaited<
  ReturnType<typeof createQaGatewayProcessBoundaryController>
>;

async function stopQaGatewayChildWithBoundary(params: {
  child: ChildProcess;
  controller: QaGatewayProcessBoundaryController | null;
  identity: QaGatewayVerifiedProcessIdentity | null;
  opts?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number };
}) {
  const errors: unknown[] = [];
  if (params.controller && params.identity) {
    try {
      await params.controller.markExited(params.identity);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await stopQaGatewayChildProcessTree(params.child, params.opts);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "qa gateway process-boundary cleanup failed");
  }
}

function isQaModelProviderConfig(value: unknown): value is ModelProviderConfig {
  return isRecord(value) && typeof value.baseUrl === "string" && Array.isArray(value.models);
}

function normalizeQaLiveProviderConfig(value: unknown): ModelProviderConfig | null {
  if (isQaModelProviderConfig(value)) {
    return value;
  }
  if (!isRecord(value) || !Object.hasOwn(value, "apiKey")) {
    return null;
  }
  return {
    ...value,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    models: Array.isArray(value.models) ? value.models : [],
  } as ModelProviderConfig;
}

async function readQaLiveProviderConfigOverrides(params: {
  providerIds: readonly string[];
  env?: NodeJS.ProcessEnv;
}) {
  const providerIds = uniqueStrings(normalizeStringEntries(params.providerIds));
  if (providerIds.length === 0) {
    return {};
  }
  const configPath = resolveQaLiveProviderConfigPath(params.env);
  if (!existsSync(configPath.path)) {
    return {};
  }
  try {
    const raw = await fs.readFile(configPath.path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const providers = isRecord(parsed)
      ? isRecord(parsed.models)
        ? isRecord(parsed.models.providers)
          ? parsed.models.providers
          : {}
        : {}
      : {};
    const selected: Record<string, ModelProviderConfig> = {};
    for (const providerId of providerIds) {
      const providerConfig = normalizeQaLiveProviderConfig(providers[providerId]);
      if (providerConfig) {
        selected[providerId] = providerConfig;
      }
    }
    return selected;
  } catch (error) {
    if (configPath.explicit) {
      throw new Error(
        `failed to read ${QA_LIVE_PROVIDER_CONFIG_PATH_ENV} provider config: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    return {};
  }
}

async function waitForGatewayReady(params: {
  baseUrl: string;
  logs: () => string;
  child: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  getChildFailure?: () => QaChildFailure | null;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < (params.timeoutMs ?? 60_000)) {
    throwQaGatewayChildFailure(params.getChildFailure, params.logs);
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new QaSuiteInfraError(
        "gateway_startup_unhealthy",
        `gateway exited before becoming healthy (exitCode=${String(params.child.exitCode)}, signal=${String(params.child.signalCode)}):\n${params.logs()}`,
      );
    }
    for (const healthPath of ["/readyz", "/healthz"] as const) {
      try {
        if (await fetchLocalGatewayHealth({ baseUrl: params.baseUrl, healthPath })) {
          return;
        }
      } catch {
        // retry until timeout
      }
    }
    await sleep(250);
  }
  throw new QaSuiteInfraError(
    "gateway_startup_unhealthy",
    `gateway failed to become healthy:\n${params.logs()}`,
  );
}

async function waitForGatewayListening(params: {
  baseUrl: string;
  logs: () => string;
  child: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  getChildFailure?: () => QaChildFailure | null;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < (params.timeoutMs ?? 60_000)) {
    throwQaGatewayChildFailure(params.getChildFailure, params.logs);
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new QaSuiteInfraError(
        "gateway_startup_unhealthy",
        `gateway exited before listening (exitCode=${String(params.child.exitCode)}, signal=${String(params.child.signalCode)}):\n${params.logs()}`,
      );
    }
    try {
      if (await fetchLocalGatewayListening(params.baseUrl)) {
        return;
      }
    } catch {
      // retry until the HTTP listener accepts requests
    }
    await sleep(100);
  }
  throw new QaSuiteInfraError(
    "gateway_startup_unhealthy",
    `gateway failed to listen before timeout:\n${params.logs()}`,
  );
}

function isRetryableRpcStartupError(error: unknown) {
  const details = formatErrorMessage(error);
  return (
    details.includes("gateway timeout after") ||
    details.includes("handshake timeout") ||
    details.includes("gateway token mismatch") ||
    details.includes("token mismatch") ||
    details.includes("gateway closed (1000") ||
    details.includes("gateway closed (1006") ||
    details.includes("gateway closed (1012)")
  );
}

export function resolveQaControlUiRoot(params: { repoRoot: string; controlUiEnabled?: boolean }) {
  if (params.controlUiEnabled === false) {
    return undefined;
  }
  const controlUiRoot = path.join(params.repoRoot, "dist", "control-ui");
  const indexPath = path.join(controlUiRoot, "index.html");
  return existsSync(indexPath) ? controlUiRoot : undefined;
}

export async function startQaGatewayChild(params: {
  repoRoot: string;
  command?: QaGatewayChildCommand;
  useRepoCli?: boolean;
  providerBaseUrl?: string;
  transport?: Pick<QaTransportAdapter, "requiredPluginIds" | "createGatewayConfig">;
  transportBaseUrl: string;
  controlUiAllowedOrigins?: string[];
  providerMode?: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  controlUiEnabled?: boolean;
  enabledPluginIds?: string[];
  forwardHostHome?: boolean;
  mockAuthAgentIds?: readonly string[];
  onListening?: (context: QaGatewayChildListeningContext) => Promise<void> | void;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
  runtimeEnvPatch?: NodeJS.ProcessEnv;
}) {
  const tempRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-qa-suite-"),
  );
  const runtimeCwd = tempRoot;
  const distEntryPath = path.join(params.repoRoot, "dist", "index.js");
  const gatewayCommand =
    params.command ??
    (params.useRepoCli ? resolveQaGatewayChildCommand(params.repoRoot) : undefined);
  const gatewayExecutablePath = gatewayCommand?.executablePath;
  const gatewayArgsPrefix = gatewayCommand?.argsPrefix ?? [];
  const gatewayArgsSuffix = gatewayCommand?.argsSuffix ?? [];
  const gatewayCwd = gatewayCommand?.cwd ?? runtimeCwd;
  const workspaceDir = path.join(tempRoot, "workspace");
  const stateDir = path.join(tempRoot, "state");
  const homeDir = path.join(tempRoot, "home");
  const xdgConfigHome = path.join(tempRoot, "xdg-config");
  const xdgDataHome = path.join(tempRoot, "xdg-data");
  const xdgCacheHome = path.join(tempRoot, "xdg-cache");
  const configPath = path.join(tempRoot, "openclaw.json");
  const gatewayToken = `qa-suite-${randomUUID()}`;
  const transport = params.transport ?? createQaGatewayEmptyTransport();
  await seedQaAgentWorkspace({
    workspaceDir,
    repoRoot: params.repoRoot,
  });
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(homeDir, { recursive: true }),
    fs.mkdir(xdgConfigHome, { recursive: true }),
    fs.mkdir(xdgDataHome, { recursive: true }),
    fs.mkdir(xdgCacheHome, { recursive: true }),
  ]);
  const providerMode = resolveQaGatewayChildProviderMode(params.providerMode);
  const resolvedProvider = getQaProvider(providerMode);
  const liveProviderIds = resolvedProvider.usesModelProviderPlugins
    ? [params.primaryModel, params.alternateModel]
        .map((modelRef) =>
          typeof modelRef === "string" ? splitQaModelRef(modelRef)?.provider : undefined,
        )
        .filter((providerId): providerId is string => Boolean(providerId))
    : [];
  const liveProviderConfigs = await readQaLiveProviderConfigOverrides({
    providerIds: liveProviderIds,
  });
  const liveOwnerPluginIds =
    liveProviderIds.length > 0
      ? await resolveQaOwnerPluginIdsForProviderIds({
          repoRoot: params.repoRoot,
          providerIds: liveProviderIds,
          providerConfigs: liveProviderConfigs,
        })
      : [];
  const enabledPluginIds = [
    ...new Set([...(liveOwnerPluginIds ?? []), ...(params.enabledPluginIds ?? [])]),
  ];
  const buildGatewayConfig = (gatewayPort: number) =>
    buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort,
      gatewayToken,
      providerBaseUrl: params.providerBaseUrl,
      workspaceDir,
      controlUiRoot: resolveQaControlUiRoot({
        repoRoot: params.repoRoot,
        controlUiEnabled: params.controlUiEnabled,
      }),
      controlUiAllowedOrigins: params.controlUiAllowedOrigins,
      providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      enabledPluginIds,
      transportPluginIds: transport.requiredPluginIds,
      transportConfig: transport.createGatewayConfig({
        baseUrl: params.transportBaseUrl,
      }),
      liveProviderConfigs,
      fastMode: params.fastMode,
      thinkingDefault: params.thinkingDefault,
      controlUiEnabled: params.controlUiEnabled,
    });
  const buildStagedGatewayConfig = async (gatewayPort: number) => {
    let cfg = buildGatewayConfig(gatewayPort);
    cfg = await stageQaLiveApiKeyProfiles({
      cfg,
      stateDir,
      providerIds: liveProviderIds,
    });
    cfg = await stageQaLiveAnthropicSetupToken({
      cfg,
      stateDir,
    });
    const mockAuthProviders = getQaProvider(providerMode).mockAuthProviders;
    if (mockAuthProviders && mockAuthProviders.length > 0) {
      cfg = await stageQaMockAuthProfiles({
        cfg,
        stateDir,
        agentIds: params.mockAuthAgentIds,
        providers: mockAuthProviders,
      });
    }
    return params.mutateConfig ? params.mutateConfig(cfg) : cfg;
  };
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const output = createQaGatewayChildLogCollector();
  const stdoutLogPath = path.join(tempRoot, "gateway.stdout.log");
  const stderrLogPath = path.join(tempRoot, "gateway.stderr.log");
  const stdoutLog = createWriteStream(stdoutLogPath, { flags: "a" });
  const stderrLog = createWriteStream(stderrLogPath, { flags: "a" });

  const logs = () => redactQaGatewayDebugText(output.text());
  const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1";
  let gatewayPort = 0;
  let baseUrl = "";
  let wsUrl = "";
  let child: ReturnType<typeof spawn> | null = null;
  let childIdentity: QaGatewayVerifiedProcessIdentity | null = null;
  let processBoundaryController: Awaited<
    ReturnType<typeof createQaGatewayProcessBoundaryController>
  > | null = null;
  let cfg!: OpenClawConfig;
  let rpcClient: Awaited<ReturnType<typeof startQaGatewayRpcClient>> | null = null;
  let getChildFailure: (() => QaChildFailure | null) | null = null;
  let stagedBundledPluginsRoot: string | null = null;
  let env: NodeJS.ProcessEnv | null = null;

  try {
    const nodeExecPath = gatewayExecutablePath ?? (await resolveQaNodeExecPath());
    const cliArgsPrefix = gatewayExecutablePath
      ? gatewayArgsPrefix
      : [distEntryPath, ...gatewayArgsPrefix];
    const buildGatewayArgs = () => [
      ...cliArgsPrefix,
      "gateway",
      "run",
      "--port",
      String(gatewayPort),
      "--bind",
      "loopback",
      "--allow-unconfigured",
      ...gatewayArgsSuffix,
    ];
    processBoundaryController = gatewayCommand?.processBoundary
      ? await createQaGatewayProcessBoundaryController({
          config: gatewayCommand.processBoundary,
          launcherPath: nodeExecPath,
          tempRoot,
        })
      : null;
    const spawnGatewayProcess = async (runtimeEnv: NodeJS.ProcessEnv) => {
      const gatewayArgs = buildGatewayArgs();
      const preparedBoundary = processBoundaryController
        ? await processBoundaryController.prepare({
            args: gatewayArgs,
            cwd: gatewayCwd,
            env: runtimeEnv,
          })
        : null;
      const spawnedChild = spawn(nodeExecPath, gatewayArgs, {
        cwd: gatewayCwd,
        env: preparedBoundary?.env ?? runtimeEnv,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawnedChild.stdout.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stdout.push(buffer);
        output.push(buffer);
        stdoutLog.write(buffer);
      });
      spawnedChild.stderr.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stderr.push(buffer);
        output.push(buffer);
        stderrLog.write(buffer);
      });
      const getSpawnedChildFailure = monitorQaGatewayChildFailure(spawnedChild, output);
      let identity: QaGatewayVerifiedProcessIdentity | null = null;
      try {
        identity =
          preparedBoundary && processBoundaryController
            ? await processBoundaryController.accept({
                child: spawnedChild,
                prepared: preparedBoundary,
              })
            : null;
        if (identity && processBoundaryController) {
          await processBoundaryController.signal(identity, "SIGCONT");
        }
        return {
          child: spawnedChild,
          getChildFailure: getSpawnedChildFailure,
          identity,
        };
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (identity) {
          try {
            await stopQaGatewayChildWithBoundary({
              child: spawnedChild,
              controller: processBoundaryController,
              identity,
              opts: {
                gracefulTimeoutMs: 1_500,
                forceTimeoutMs: 1_500,
              },
            });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        } else {
          if (preparedBoundary && processBoundaryController) {
            try {
              await processBoundaryController.abort({
                child: spawnedChild,
                prepared: preparedBoundary,
              });
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
          }
          try {
            await stopQaGatewayChildProcessTree(spawnedChild, {
              gracefulTimeoutMs: 1_500,
              forceTimeoutMs: 1_500,
            });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          const cleanupFailure = new AggregateError(
            [error, ...cleanupErrors],
            "qa gateway failed before verified process cleanup completed",
            { cause: error },
          );
          throw cleanupFailure;
        }
        throw error;
      }
    };
    for (let attempt = 1; attempt <= QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS; attempt += 1) {
      gatewayPort = await getFreePort();
      baseUrl = `http://127.0.0.1:${gatewayPort}`;
      wsUrl = `ws://127.0.0.1:${gatewayPort}`;
      cfg = await buildStagedGatewayConfig(gatewayPort);
      if (!env) {
        const allowedPluginIds = uniqueStrings(
          [...(cfg.plugins?.allow ?? []), "openai"].filter(
            (pluginId): pluginId is string => typeof pluginId === "string" && pluginId.length > 0,
          ),
        );
        const stagedPluginRuntime = gatewayCommand?.usePackagedPlugins
          ? { bundledPluginsDir: undefined, runtimeHostVersion: undefined }
          : {
              ...(await createQaBundledPluginsDir({
                repoRoot: params.repoRoot,
                tempRoot,
                allowedPluginIds,
              })),
              runtimeHostVersion: await resolveQaRuntimeHostVersion({
                repoRoot: params.repoRoot,
                allowedPluginIds,
              }),
            };
        if ("stagedRoot" in stagedPluginRuntime) {
          stagedBundledPluginsRoot = stagedPluginRuntime.stagedRoot;
        }
        env = buildQaRuntimeEnv({
          configPath,
          gatewayToken,
          homeDir,
          forwardHostHome: params.forwardHostHome,
          stateDir,
          tempRoot,
          xdgConfigHome,
          xdgDataHome,
          xdgCacheHome,
          bundledPluginsDir: stagedPluginRuntime.bundledPluginsDir,
          stagedBundledPluginsRoot,
          compatibilityHostVersion: stagedPluginRuntime.runtimeHostVersion,
          providerMode,
          runtimeEnvPatch: params.runtimeEnvPatch,
          forwardHostHomeForClaudeCli: liveProviderIds.includes("claude-cli"),
          claudeCliAuthMode: params.claudeCliAuthMode,
        });
      }
      if (!env) {
        throw new Error("qa gateway runtime env not initialized");
      }
      assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: liveProviderIds,
        env,
      });
      await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      const spawnedAttempt = await spawnGatewayProcess(env);
      const attemptChild = spawnedAttempt.child;
      child = attemptChild;
      childIdentity = spawnedAttempt.identity;
      const getAttemptChildFailure = spawnedAttempt.getChildFailure;

      try {
        await waitForGatewayListening({
          baseUrl,
          logs,
          child: attemptChild,
          getChildFailure: getAttemptChildFailure,
          timeoutMs: 120_000,
        });
        await params.onListening?.({
          attempt,
          baseUrl,
          wsUrl,
          token: gatewayToken,
          configPath,
          runtimeEnv: env,
        });
        await waitForGatewayReady({
          baseUrl,
          logs,
          child: attemptChild,
          getChildFailure: getAttemptChildFailure,
          timeoutMs: 120_000,
        });
        const attemptRpcClient = await startQaGatewayRpcClient({
          wsUrl,
          token: gatewayToken,
          logs,
        });
        try {
          let rpcReady = false;
          let lastRpcStartupError: unknown = null;
          for (let rpcAttempt = 1; rpcAttempt <= 4; rpcAttempt += 1) {
            try {
              await attemptRpcClient.request(
                "config.get",
                {},
                {
                  timeoutMs: QA_GATEWAY_CHILD_RPC_STARTUP_TIMEOUT_MS,
                },
              );
              rpcReady = true;
              break;
            } catch (error) {
              lastRpcStartupError = error;
              if (rpcAttempt >= 4 || !isRetryableRpcStartupError(error)) {
                throw error;
              }
              await sleep(500 * rpcAttempt);
              await waitForGatewayReady({
                baseUrl,
                logs,
                child: attemptChild,
                getChildFailure: getAttemptChildFailure,
                timeoutMs: QA_GATEWAY_CHILD_RPC_RETRY_HEALTH_TIMEOUT_MS,
              });
            }
          }
          if (!rpcReady) {
            throw toQaErrorObject(
              lastRpcStartupError ?? new Error("qa gateway rpc client failed to start"),
              "Non-Error thrown",
            );
          }
          throwQaGatewayChildFailure(getAttemptChildFailure, logs);
        } catch (error) {
          await attemptRpcClient.stop().catch(() => {});
          throw error;
        }
        rpcClient = attemptRpcClient;
        getChildFailure = getAttemptChildFailure;
        if (childIdentity && processBoundaryController) {
          await processBoundaryController.markReady(childIdentity);
        }
        break;
      } catch (error) {
        const details = formatErrorMessage(error);
        const retryable =
          attempt < QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS &&
          (isRetryableGatewayStartupError(`${details}\n${logs()}`) ||
            isRetryableRpcStartupError(error));
        if (rpcClient) {
          await rpcClient.stop().catch(() => {});
          rpcClient = null;
        }
        await stopQaGatewayChildWithBoundary({
          child: attemptChild,
          controller: processBoundaryController,
          identity: childIdentity,
          opts: {
            gracefulTimeoutMs: 1_500,
            forceTimeoutMs: 1_500,
          },
        });
        child = null;
        childIdentity = null;
        if (!retryable) {
          throw error;
        }
        stdoutLog.write(
          `[qa-lab] gateway child startup attempt ${attempt}/${QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS} hit a transient startup race on port ${gatewayPort}; retrying with a new port\n`,
        );
      }
    }

    if (!child || !cfg || !baseUrl || !wsUrl || !rpcClient || !getChildFailure || !env) {
      throw new Error("qa gateway child failed to start");
    }
    if (processBoundaryController && !childIdentity) {
      throw new Error("qa gateway child started without verified process identity");
    }
    let activeChild = child;
    let activeIdentity = childIdentity;
    let activeRpcClient = rpcClient;
    let activeGetChildFailure = getChildFailure;
    const runningEnv = env;
    const throwActiveChildFailure = () => throwQaGatewayChildFailure(activeGetChildFailure, logs);

    const spawnReplacementGatewayChild = async () => {
      const spawnedReplacement = await spawnGatewayProcess(runningEnv);
      const nextChild = spawnedReplacement.child;
      const nextIdentity = spawnedReplacement.identity;
      const getNextChildFailure = spawnedReplacement.getChildFailure;

      try {
        await waitForGatewayReady({
          baseUrl,
          logs,
          child: nextChild,
          getChildFailure: getNextChildFailure,
          timeoutMs: 120_000,
        });
        const nextRpcClient = await startQaGatewayRpcClient({
          wsUrl,
          token: gatewayToken,
          logs,
        });
        try {
          let rpcReady = false;
          let lastRpcStartupError: unknown = null;
          for (let rpcAttempt = 1; rpcAttempt <= 4; rpcAttempt += 1) {
            try {
              await nextRpcClient.request(
                "config.get",
                {},
                {
                  timeoutMs: QA_GATEWAY_CHILD_RPC_STARTUP_TIMEOUT_MS,
                },
              );
              rpcReady = true;
              break;
            } catch (error) {
              lastRpcStartupError = error;
              if (rpcAttempt >= 4 || !isRetryableRpcStartupError(error)) {
                throw error;
              }
              await sleep(500 * rpcAttempt);
              await waitForGatewayReady({
                baseUrl,
                logs,
                child: nextChild,
                getChildFailure: getNextChildFailure,
                timeoutMs: 15_000,
              });
            }
          }
          if (!rpcReady) {
            throw toQaErrorObject(
              lastRpcStartupError ?? new Error("qa gateway rpc client failed to start"),
              "Non-Error thrown",
            );
          }
          throwQaGatewayChildFailure(getNextChildFailure, logs);
        } catch (error) {
          await nextRpcClient.stop().catch(() => {});
          throw error;
        }
        if (nextIdentity && processBoundaryController) {
          await processBoundaryController.markReady(nextIdentity);
        }
        return {
          child: nextChild,
          identity: nextIdentity,
          rpcClient: nextRpcClient,
          getChildFailure: getNextChildFailure,
        };
      } catch (error) {
        await stopQaGatewayChildWithBoundary({
          child: nextChild,
          controller: processBoundaryController,
          identity: nextIdentity,
          opts: {
            gracefulTimeoutMs: 1_500,
            forceTimeoutMs: 1_500,
          },
        });
        throw error;
      }
    };

    const signalActiveProcess = async (signal: NodeJS.Signals) => {
      if (activeIdentity && processBoundaryController) {
        if (signal !== "SIGUSR1" && signal !== "SIGUSR2") {
          throw new Error(`unsupported verified gateway signal: ${signal}`);
        }
        await processBoundaryController.signal(activeIdentity, signal);
        return;
      }
      if (!activeChild.pid) {
        throw new Error("qa gateway child has no pid");
      }
      process.kill(activeChild.pid, signal);
    };

    return {
      cfg,
      baseUrl,
      wsUrl,
      get pid() {
        return activeIdentity?.pid ?? activeChild.pid ?? null;
      },
      getProcessCpuMs: () => readProcessTreeCpuMs(activeIdentity?.pid ?? activeChild.pid ?? null),
      getProcessRssBytes: () =>
        readProcessTreeRssBytes(activeIdentity?.pid ?? activeChild.pid ?? null),
      token: gatewayToken,
      workspaceDir,
      tempRoot,
      configPath,
      runtimeEnv: runningEnv,
      logs,
      runCli(args: readonly string[]) {
        throwActiveChildFailure();
        return runQaGatewayCliCommand({
          executablePath: nodeExecPath,
          argsPrefix: cliArgsPrefix,
          args,
          cwd: gatewayCwd,
          env: runningEnv,
        });
      },
      async signalProcess(signal: NodeJS.Signals) {
        throwActiveChildFailure();
        await signalActiveProcess(signal);
      },
      async restart(signal: NodeJS.Signals = "SIGUSR1") {
        throwActiveChildFailure();
        const restartLogOffset = logs().length;
        await signalActiveProcess(signal);
        if (signal === "SIGUSR1") {
          await waitForQaGatewayRestartBoundary({
            logs,
            offset: restartLogOffset,
          });
          await waitForGatewayReady({
            baseUrl,
            logs,
            child: activeChild,
            getChildFailure: activeGetChildFailure,
            timeoutMs: 120_000,
          });
        }
      },
      async restartAfterStateMutation(
        mutateState: (context: QaGatewayChildStateMutationContext) => Promise<void>,
      ) {
        throwActiveChildFailure();
        await activeRpcClient.stop().catch(() => {});
        await stopQaGatewayChildWithBoundary({
          child: activeChild,
          controller: processBoundaryController,
          identity: activeIdentity,
        });
        await mutateState({
          configPath,
          runtimeEnv: runningEnv,
          stateDir,
          tempRoot,
        });
        const restarted = await spawnReplacementGatewayChild();
        activeChild = restarted.child;
        activeIdentity = restarted.identity;
        activeRpcClient = restarted.rpcClient;
        activeGetChildFailure = restarted.getChildFailure;
        child = activeChild;
        childIdentity = activeIdentity;
        rpcClient = activeRpcClient;
      },
      async call(
        method: string,
        rpcParams?: unknown,
        opts?: { expectFinal?: boolean; timeoutMs?: number },
      ) {
        const timeoutMs = opts?.timeoutMs ?? 20_000;
        let lastDetails = "";
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          throwActiveChildFailure();
          try {
            return await activeRpcClient.request(method, rpcParams, {
              ...opts,
              timeoutMs,
            });
          } catch (error) {
            throwActiveChildFailure();
            const details = formatErrorMessage(error);
            lastDetails = details;
            if (attempt >= 3 || !isRetryableGatewayCallError(details)) {
              throw new Error(`${details}${formatQaGatewayLogsForError(logs())}`, { cause: error });
            }
            await waitForGatewayReady({
              baseUrl,
              logs,
              child: activeChild,
              getChildFailure: activeGetChildFailure,
              timeoutMs: Math.max(10_000, timeoutMs),
            });
          }
        }
        throw new Error(`${lastDetails}${formatQaGatewayLogsForError(logs())}`);
      },
      async stop(opts?: { keepTemp?: boolean; preserveToDir?: string }) {
        await activeRpcClient.stop().catch(() => {});
        await stopQaGatewayChildWithBoundary({
          child: activeChild,
          controller: processBoundaryController,
          identity: activeIdentity,
        });
        await closeWriteStream(stdoutLog);
        await closeWriteStream(stderrLog);
        if (opts?.preserveToDir && !(opts?.keepTemp ?? keepTemp)) {
          await preserveQaGatewayDebugArtifacts({
            preserveToDir: opts.preserveToDir,
            stdoutLogPath,
            stderrLogPath,
            tempRoot,
            repoRoot: params.repoRoot,
          });
        }
        if (!(opts?.keepTemp ?? keepTemp)) {
          await cleanupQaGatewayTempRoots({
            tempRoot,
            stagedBundledPluginsRoot,
          });
        }
        throwActiveChildFailure();
      },
    };
  } catch (error) {
    await rpcClient?.stop().catch(() => {});
    if (child) {
      await stopQaGatewayChildWithBoundary({
        child,
        controller: processBoundaryController,
        identity: childIdentity,
        opts: {
          gracefulTimeoutMs: 1_500,
          forceTimeoutMs: 1_500,
        },
      });
    }
    await closeWriteStream(stdoutLog);
    await closeWriteStream(stderrLog);
    if (!keepTemp) {
      await cleanupQaGatewayTempRoots({
        tempRoot,
        stagedBundledPluginsRoot,
      });
    }
    const message = keepTemp
      ? appendQaGatewayTempRoot(formatErrorMessage(error), tempRoot)
      : formatErrorMessage(error);
    if (error instanceof QaSuiteInfraError) {
      throw new QaSuiteInfraError(error.code, message, { cause: error });
    }
    throw new Error(message, { cause: error });
  }
}
export { testing as __testing };
