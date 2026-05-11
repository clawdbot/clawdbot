import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  createQaBundledPluginsDir,
  resolveQaBundledPluginSourceDir,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaRuntimeHostVersion,
} from "./bundled-plugin-staging.js";
import { assertRepoBoundPath, ensureRepoBoundDirectory } from "./cli-paths.js";
import { formatQaGatewayLogsForError, redactQaGatewayDebugText } from "./gateway-log-redaction.js";
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
  QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV,
  QA_LIVE_SETUP_TOKEN_VALUE_ENV,
  stageQaLiveApiKeyProfiles,
  stageQaLiveAnthropicSetupToken,
} from "./providers/live-frontier/auth.js";
import { stageQaMockAuthProfiles } from "./providers/shared/mock-auth.js";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";
import { buildQaGatewayConfig, type QaThinkingLevel } from "./qa-gateway-config.js";
import type { QaTransportAdapter } from "./qa-transport.js";

export type { QaCliBackendAuthMode } from "./providers/env.js";
const QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS = 5;
const QA_GATEWAY_CHILD_RPC_RETRY_HEALTH_TIMEOUT_MS = 60_000;
const QA_GATEWAY_CHILD_RESTART_BOUNDARY_TIMEOUT_MS = 90_000;
const QA_GATEWAY_CHILD_BLOCKED_SECRET_ENV_VARS = Object.freeze([
  "OPENCLAW_QA_CONVEX_SECRET_CI",
  "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER",
]);

export type QaGatewayChildStateMutationContext = {
  configPath: string;
  runtimeEnv: NodeJS.ProcessEnv;
  stateDir: string;
  tempRoot: string;
};

export type QaGatewayChildCommand = {
  executablePath: string;
  argsPrefix?: string[];
  argsSuffix?: string[];
  cwd?: string;
  usePackagedPlugins?: boolean;
};

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
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
  const contents = await fs.readFile(params.sourcePath, "utf8").catch((error) => {
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
      `Original runtime temp root: ${params.tempRoot}`,
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
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgCacheHome: string;
  bundledPluginsDir?: string;
  compatibilityHostVersion?: string;
  providerMode?: QaProviderMode;
  baseEnv?: NodeJS.ProcessEnv;
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
    OPENCLAW_QA_PARENT_PID: String(process.pid),
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
  delete normalizedEnv[QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV];
  delete normalizedEnv[QA_LIVE_SETUP_TOKEN_VALUE_ENV];
  for (const envKey of QA_GATEWAY_CHILD_BLOCKED_SECRET_ENV_VARS) {
    delete normalizedEnv[envKey];
  }
  return normalizedEnv;
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

async function waitForQaGatewayRestartBoundary(params: {
  logs: () => string;
  offset: number;
  pollMs?: number;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? QA_GATEWAY_CHILD_RESTART_BOUNDARY_TIMEOUT_MS;
  const pollMs = params.pollMs ?? 100;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (params.logs().slice(params.offset).includes("restart mode:")) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(`qa gateway child did not reach restart boundary within ${timeoutMs}ms`);
}

export const __testing = {
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
  stageQaLiveApiKeyProfiles,
  stageQaLiveAnthropicSetupToken,
  stageQaMockAuthProfiles,
  resolveQaLiveCliAuthEnv,
  waitForQaGatewayRestartBoundary,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaBundledPluginSourceDir,
  resolveQaRuntimeHostVersion,
  createQaGatewayChildLogCollector,
  createQaBundledPluginsDir,
  stopQaGatewayChildProcessTree,
};

function hasChildExited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalQaGatewayChildProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
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
  if (hasChildExited(child)) {
    return true;
  }
  return await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function stopQaGatewayChildProcessTree(
  child: ChildProcess,
  opts?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number },
) {
  if (hasChildExited(child)) {
    return;
  }
  signalQaGatewayChildProcessTree(child, "SIGTERM");
  if (await waitForQaGatewayChildExit(child, opts?.gracefulTimeoutMs ?? 5_000)) {
    return;
  }
  signalQaGatewayChildProcessTree(child, "SIGKILL");
  await waitForQaGatewayChildExit(child, opts?.forceTimeoutMs ?? 2_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isQaModelProviderConfig(value: unknown): value is ModelProviderConfig {
  return isRecord(value) && typeof value.baseUrl === "string" && Array.isArray(value.models);
}

async function readQaLiveProviderConfigOverrides(params: {
  providerIds: readonly string[];
  env?: NodeJS.ProcessEnv;
}) {
  const providerIds = [
    ...new Set(params.providerIds.map((providerId) => providerId.trim())),
  ].filter((providerId) => providerId.length > 0);
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
      const providerConfig = providers[providerId];
      if (isQaModelProviderConfig(providerConfig)) {
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
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < (params.timeoutMs ?? 60_000)) {
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error(
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
  throw new Error(`gateway failed to become healthy:\n${params.logs()}`);
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
  providerBaseUrl?: string;
  transport: Pick<QaTransportAdapter, "requiredPluginIds" | "createGatewayConfig">;
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
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}) {
  const tempRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-qa-suite-"),
  );
  const runtimeCwd = tempRoot;
  const distEntryPath = path.join(params.repoRoot, "dist", "index.js");
  const gatewayCommand = params.command;
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
      transportPluginIds: params.transport.requiredPluginIds,
      transportConfig: params.transport.createGatewayConfig({
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

  const logs = () => output.text();
  const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1";
  let gatewayPort = 0;
  let baseUrl = "";
  let wsUrl = "";
  let child: ReturnType<typeof spawn> | null = null;
  let cfg!: OpenClawConfig;
  let rpcClient: Awaited<ReturnType<typeof startQaGatewayRpcClient>> | null = null;
  let stagedBundledPluginsRoot: string | null = null;
  let env: NodeJS.ProcessEnv | null = null;

  try {
    const nodeExecPath = gatewayExecutablePath ?? (await resolveQaNodeExecPath());
    const buildGatewayArgs = () => [
      ...(gatewayExecutablePath ? gatewayArgsPrefix : [distEntryPath, ...gatewayArgsPrefix]),
      "gateway",
      "run",
      "--port",
      String(gatewayPort),
      "--bind",
      "loopback",
      "--allow-unconfigured",
      ...gatewayArgsSuffix,
    ];
    for (let attempt = 1; attempt <= QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS; attempt += 1) {
      gatewayPort = await getFreePort();
      baseUrl = `http://127.0.0.1:${gatewayPort}`;
      wsUrl = `ws://127.0.0.1:${gatewayPort}`;
      cfg = await buildStagedGatewayConfig(gatewayPort);
      if (!env) {
        const allowedPluginIds = [...(cfg.plugins?.allow ?? []), "openai"].filter(
          (pluginId, index, array): pluginId is string => {
            return (
              typeof pluginId === "string" &&
              pluginId.length > 0 &&
              array.indexOf(pluginId) === index
            );
          },
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
          xdgConfigHome,
          xdgDataHome,
          xdgCacheHome,
          bundledPluginsDir: stagedPluginRuntime.bundledPluginsDir,
          compatibilityHostVersion: stagedPluginRuntime.runtimeHostVersion,
          providerMode,
          forwardHostHomeForClaudeCli: liveProviderIds.includes("claude-cli"),
          claudeCliAuthMode: params.claudeCliAuthMode,
        });
      }
      await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (!env) {
        throw new Error("qa gateway runtime env not initialized");
      }

      const attemptChild = spawn(nodeExecPath, buildGatewayArgs(), {
        cwd: gatewayCwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      attemptChild.stdout.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stdout.push(buffer);
        output.push(buffer);
        stdoutLog.write(buffer);
      });
      attemptChild.stderr.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stderr.push(buffer);
        output.push(buffer);
        stderrLog.write(buffer);
      });
      child = attemptChild;

      try {
        await waitForGatewayReady({
          baseUrl,
          logs,
          child: attemptChild,
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
              await attemptRpcClient.request("config.get", {}, { timeoutMs: 10_000 });
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
                timeoutMs: QA_GATEWAY_CHILD_RPC_RETRY_HEALTH_TIMEOUT_MS,
              });
            }
          }
          if (!rpcReady) {
            throw lastRpcStartupError ?? new Error("qa gateway rpc client failed to start");
          }
        } catch (error) {
          await attemptRpcClient.stop().catch(() => {});
          throw error;
        }
        rpcClient = attemptRpcClient;
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
        await stopQaGatewayChildProcessTree(attemptChild, {
          gracefulTimeoutMs: 1_500,
          forceTimeoutMs: 1_500,
        });
        child = null;
        if (!retryable) {
          throw error;
        }
        stdoutLog.write(
          `[qa-lab] gateway child startup attempt ${attempt}/${QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS} hit a transient startup race on port ${gatewayPort}; retrying with a new port\n`,
        );
      }
    }

    if (!child || !cfg || !baseUrl || !wsUrl || !rpcClient || !env) {
      throw new Error("qa gateway child failed to start");
    }
    let activeChild = child;
    let activeRpcClient = rpcClient;
    const runningEnv = env;

    const spawnReplacementGatewayChild = async () => {
      const nextChild = spawn(nodeExecPath, buildGatewayArgs(), {
        cwd: gatewayCwd,
        env: runningEnv,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      nextChild.stdout.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stdout.push(buffer);
        output.push(buffer);
        stdoutLog.write(buffer);
      });
      nextChild.stderr.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stderr.push(buffer);
        output.push(buffer);
        stderrLog.write(buffer);
      });

      try {
        await waitForGatewayReady({
          baseUrl,
          logs,
          child: nextChild,
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
              await nextRpcClient.request("config.get", {}, { timeoutMs: 10_000 });
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
                timeoutMs: 15_000,
              });
            }
          }
          if (!rpcReady) {
            throw lastRpcStartupError ?? new Error("qa gateway rpc client failed to start");
          }
        } catch (error) {
          await nextRpcClient.stop().catch(() => {});
          throw error;
        }
        return {
          child: nextChild,
          rpcClient: nextRpcClient,
        };
      } catch (error) {
        await stopQaGatewayChildProcessTree(nextChild, {
          gracefulTimeoutMs: 1_500,
          forceTimeoutMs: 1_500,
        });
        throw error;
      }
    };

    return {
      cfg,
      baseUrl,
      wsUrl,
      pid: child.pid ?? null,
      getProcessCpuMs: () => readProcessTreeCpuMs(activeChild.pid ?? null),
      getProcessRssBytes: () => readProcessTreeRssBytes(activeChild.pid ?? null),
      token: gatewayToken,
      workspaceDir,
      tempRoot,
      configPath,
      runtimeEnv: runningEnv,
      logs,
      async restart(signal: NodeJS.Signals = "SIGUSR1") {
        if (!activeChild.pid) {
          throw new Error("qa gateway child has no pid");
        }
        const restartLogOffset = logs().length;
        process.kill(activeChild.pid, signal);
        if (signal === "SIGUSR1") {
          await waitForQaGatewayRestartBoundary({
            logs,
            offset: restartLogOffset,
          });
          await waitForGatewayReady({
            baseUrl,
            logs,
            child: activeChild,
            timeoutMs: 120_000,
          });
        }
      },
      async restartAfterStateMutation(
        mutateState: (context: QaGatewayChildStateMutationContext) => Promise<void>,
      ) {
        await activeRpcClient.stop().catch(() => {});
        await stopQaGatewayChildProcessTree(activeChild);
        await mutateState({
          configPath,
          runtimeEnv: runningEnv,
          stateDir,
          tempRoot,
        });
        const restarted = await spawnReplacementGatewayChild();
        activeChild = restarted.child;
        activeRpcClient = restarted.rpcClient;
        child = activeChild;
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
          try {
            return await activeRpcClient.request(method, rpcParams, {
              ...opts,
              timeoutMs,
            });
          } catch (error) {
            const details = formatErrorMessage(error);
            lastDetails = details;
            if (attempt >= 3 || !isRetryableGatewayCallError(details)) {
              throw new Error(`${details}${formatQaGatewayLogsForError(logs())}`, { cause: error });
            }
            await waitForGatewayReady({
              baseUrl,
              logs,
              child: activeChild,
              timeoutMs: Math.max(10_000, timeoutMs),
            });
          }
        }
        throw new Error(`${lastDetails}${formatQaGatewayLogsForError(logs())}`);
      },
      async stop(opts?: { keepTemp?: boolean; preserveToDir?: string }) {
        await activeRpcClient.stop().catch(() => {});
        await stopQaGatewayChildProcessTree(activeChild);
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
      },
    };
  } catch (error) {
    await rpcClient?.stop().catch(() => {});
    if (child) {
      await stopQaGatewayChildProcessTree(child, {
        gracefulTimeoutMs: 1_500,
        forceTimeoutMs: 1_500,
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
    throw new Error(
      keepTemp
        ? appendQaGatewayTempRoot(formatErrorMessage(error), tempRoot)
        : formatErrorMessage(error),
      {
        cause: error,
      },
    );
  }
}
