import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  applyAuthProfileConfig,
  upsertAuthProfile,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";
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
import { splitQaModelRef } from "./model-selection.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";
import { buildQaGatewayConfig, type QaThinkingLevel } from "./qa-gateway-config.js";
import type { QaTransportAdapter } from "./qa-transport.js";

const QA_LIVE_ENV_ALIASES = Object.freeze([
  {
    liveVar: "OPENCLAW_LIVE_OPENAI_KEY",
    providerVar: "OPENAI_API_KEY",
  },
  {
    liveVar: "OPENCLAW_LIVE_ANTHROPIC_KEY",
    providerVar: "ANTHROPIC_API_KEY",
  },
  {
    liveVar: "OPENCLAW_LIVE_GEMINI_KEY",
    providerVar: "GEMINI_API_KEY",
  },
]);

const QA_MOCK_BLOCKED_ENV_VARS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
  "OPENCLAW_LIVE_ANTHROPIC_KEY",
  "OPENCLAW_LIVE_ANTHROPIC_KEYS",
  "OPENCLAW_LIVE_GEMINI_KEY",
  "OPENCLAW_LIVE_OPENAI_KEY",
  "VOYAGE_API_KEY",
]);

const QA_MOCK_BLOCKED_ENV_KEY_PATTERNS = Object.freeze([
  /^DISCORD_/i,
  /^TELEGRAM_/i,
  /^SLACK_/i,
  /^MATRIX_/i,
  /^SIGNAL_/i,
  /^WHATSAPP_/i,
  /^IMESSAGE_/i,
  /^ZALO/i,
  /^TWILIO_/i,
  /^PLIVO_/i,
  /^NGROK_/i,
]);

const QA_LIVE_PROVIDER_CONFIG_PATH_ENV = "OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH";
const QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV = "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN";
const QA_LIVE_SETUP_TOKEN_VALUE_ENV = "OPENCLAW_LIVE_SETUP_TOKEN_VALUE";
const QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ENV = "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE";
const QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ID = "anthropic:qa-setup-token";
const QA_LIVE_CLI_BACKEND_PRESERVE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV";
const QA_LIVE_CLI_BACKEND_AUTH_MODE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_AUTH_MODE";
export type QaCliBackendAuthMode = "auto" | "api-key" | "subscription";
const QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS = 5;
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

export function normalizeQaProviderModeEnv(
  env: NodeJS.ProcessEnv,
  providerMode?: "mock-openai" | "live-frontier",
) {
  if (providerMode === "mock-openai") {
    for (const key of QA_MOCK_BLOCKED_ENV_VARS) {
      delete env[key];
    }
    for (const key of Object.keys(env)) {
      if (QA_MOCK_BLOCKED_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
        delete env[key];
      }
    }
    return env;
  }

  if (providerMode === "live-frontier") {
    for (const { liveVar, providerVar } of QA_LIVE_ENV_ALIASES) {
      const liveValue = env[liveVar]?.trim();
      if (!liveValue || env[providerVar]?.trim()) {
        continue;
      }
      env[providerVar] = liveValue;
    }
  }

  return env;
}

export function resolveQaGatewayChildProviderMode(
  providerMode?: "mock-openai" | "live-frontier",
): "mock-openai" | "live-frontier" {
  return providerMode ?? "mock-openai";
}

function resolveQaLiveCliAuthEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts?: {
    forwardHostHomeForClaudeCli?: boolean;
    claudeCliAuthMode?: QaCliBackendAuthMode;
  },
) {
  const parsePreservedCliEnv = () => {
    const raw = baseEnv[QA_LIVE_CLI_BACKEND_PRESERVE_ENV]?.trim();
    if (raw?.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === "string")
          : [];
      } catch {
        return [];
      }
    }
    return (raw ?? "").split(/[,\s]+/).filter((entry) => entry.length > 0);
  };
  const renderPreservedCliEnv = (values: string[]) => JSON.stringify([...new Set(values)]);
  const authMode = opts?.claudeCliAuthMode ?? "auto";
  const hasAnthropicKey = Boolean(
    baseEnv.ANTHROPIC_API_KEY?.trim() || baseEnv.OPENCLAW_LIVE_ANTHROPIC_KEY?.trim(),
  );
  if (opts?.forwardHostHomeForClaudeCli && authMode === "api-key" && !hasAnthropicKey) {
    throw new Error(
      "Claude CLI API-key QA mode requires ANTHROPIC_API_KEY or OPENCLAW_LIVE_ANTHROPIC_KEY",
    );
  }
  const preserveEnvValues = (() => {
    if (!opts?.forwardHostHomeForClaudeCli) {
      return undefined;
    }
    const values = parsePreservedCliEnv().filter((entry) => entry !== "ANTHROPIC_API_KEY");
    if (authMode === "api-key" || (authMode === "auto" && hasAnthropicKey)) {
      values.push("ANTHROPIC_API_KEY");
    }
    return renderPreservedCliEnv(values);
  })();
  const claudeCliEnv = opts?.forwardHostHomeForClaudeCli
    ? {
        [QA_LIVE_CLI_BACKEND_AUTH_MODE_ENV]: authMode,
        ...(preserveEnvValues ? { [QA_LIVE_CLI_BACKEND_PRESERVE_ENV]: preserveEnvValues } : {}),
      }
    : {};
  const configuredCodexHome = baseEnv.CODEX_HOME?.trim();
  if (configuredCodexHome) {
    return {
      CODEX_HOME: configuredCodexHome,
      ...claudeCliEnv,
      ...(opts?.forwardHostHomeForClaudeCli && baseEnv.HOME?.trim()
        ? { HOME: baseEnv.HOME.trim() }
        : {}),
    };
  }
  const hostHome = baseEnv.HOME?.trim();
  if (!hostHome) {
    return {};
  }
  const codexHome = path.join(hostHome, ".codex");
  return {
    ...(existsSync(codexHome) ? { CODEX_HOME: codexHome } : {}),
    ...claudeCliEnv,
    ...(opts?.forwardHostHomeForClaudeCli ? { HOME: hostHome } : {}),
  };
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
  providerMode?: "mock-openai" | "live-frontier";
  baseEnv?: NodeJS.ProcessEnv;
  forwardHostHomeForClaudeCli?: boolean;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const baseEnv = params.baseEnv ?? process.env;
  const forwardedHostHome = params.forwardHostHome
    ? baseEnv.HOME?.trim() || os.homedir()
    : undefined;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: forwardedHostHome ?? params.homeDir,
    ...(params.providerMode === "live-frontier"
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
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_TEST_FAST: "1",
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
  return normalizedEnv;
}

function resolveQaLiveAnthropicSetupToken(env: NodeJS.ProcessEnv = process.env) {
  const token = (
    env[QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV]?.trim() ||
    env[QA_LIVE_SETUP_TOKEN_VALUE_ENV]?.trim() ||
    ""
  ).replaceAll(/\s+/g, "");
  if (!token) {
    return null;
  }
  const tokenError = validateAnthropicSetupToken(token);
  if (tokenError) {
    throw new Error(`Invalid QA Anthropic setup-token: ${tokenError}`);
  }
  const profileId =
    env[QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ENV]?.trim() ||
    QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ID;
  return { token, profileId };
}

export async function stageQaLiveAnthropicSetupToken(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenClawConfig> {
  const resolved = resolveQaLiveAnthropicSetupToken(params.env);
  if (!resolved) {
    return params.cfg;
  }
  const agentDir = path.join(params.stateDir, "agents", "main", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  upsertAuthProfile({
    profileId: resolved.profileId,
    credential: {
      type: "token",
      provider: "anthropic",
      token: resolved.token,
    },
    agentDir,
  });
  return applyAuthProfileConfig(params.cfg, {
    profileId: resolved.profileId,
    provider: "anthropic",
    mode: "token",
    displayName: "QA setup-token",
  });
}

/** Providers the mock-openai harness stages placeholder credentials for. */
export const QA_MOCK_AUTH_PROVIDERS = Object.freeze(["openai", "anthropic"] as const);

/** Agent IDs the mock-openai harness stages credentials under. */
export const QA_MOCK_AUTH_AGENT_IDS = Object.freeze(["main", "qa"] as const);

export function buildQaMockProfileId(provider: string): string {
  return `qa-mock-${provider}`;
}

/**
 * In mock-openai mode the qa suite runs against the embedded mock server
 * instead of a real provider API. The mock does not validate credentials, but
 * the agent auth layer still needs a matching `api_key` auth profile in
 * `auth-profiles.json` before it will route the request through
 * `providerBaseUrl`. Without this staging step, every scenario fails with
 * `FailoverError: No API key found for provider "openai"` before the mock
 * server ever sees a request.
 *
 * Stages a placeholder `api_key` profile per provider in each of the agent
 * dirs the qa suite uses (`main` for the runtime config, `qa` for scenario
 * runs) and returns a config with matching `auth.profiles` entries so the
 * runtime accepts the profile on the first lookup.
 *
 * The placeholder value `qa-mock-not-a-real-key` is intentionally not
 * shaped like a real API key (no `sk-` prefix that would trip secret
 * scanners). It only needs to be non-empty to pass the credential
 * serializer; anything beyond that is ignored by the mock.
 */
export async function stageQaMockAuthProfiles(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  agentIds?: readonly string[];
  providers?: readonly string[];
}): Promise<OpenClawConfig> {
  const agentIds = [...new Set(params.agentIds ?? QA_MOCK_AUTH_AGENT_IDS)];
  const providers = [...new Set(params.providers ?? QA_MOCK_AUTH_PROVIDERS)];
  let next = params.cfg;
  for (const agentId of agentIds) {
    const agentDir = path.join(params.stateDir, "agents", agentId, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    for (const provider of providers) {
      const profileId = buildQaMockProfileId(provider);
      upsertAuthProfile({
        profileId,
        credential: {
          type: "api_key",
          provider,
          key: "qa-mock-not-a-real-key",
          displayName: `QA mock ${provider} credential`,
        },
        agentDir,
      });
    }
  }
  for (const provider of providers) {
    next = applyAuthProfileConfig(next, {
      profileId: buildQaMockProfileId(provider),
      provider,
      mode: "api_key",
      displayName: `QA mock ${provider} credential`,
    });
  }
  return next;
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
  resolveQaLiveAnthropicSetupToken,
  stageQaLiveAnthropicSetupToken,
  stageQaMockAuthProfiles,
  resolveQaLiveCliAuthEnv,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaBundledPluginSourceDir,
  resolveQaRuntimeHostVersion,
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

function resolveQaUserPath(value: string, env: NodeJS.ProcessEnv = process.env) {
  if (value === "~") {
    return env.HOME ?? os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(env.HOME ?? os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function resolveQaLiveProviderConfigPath(env: NodeJS.ProcessEnv = process.env) {
  const explicit =
    env[QA_LIVE_PROVIDER_CONFIG_PATH_ENV]?.trim() || env.OPENCLAW_CONFIG_PATH?.trim();
  return explicit
    ? { path: resolveQaUserPath(explicit, env), explicit: true }
    : { path: path.join(os.homedir(), ".openclaw", "openclaw.json"), explicit: false };
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
  providerBaseUrl?: string;
  transport: Pick<QaTransportAdapter, "requiredPluginIds" | "createGatewayConfig">;
  transportBaseUrl: string;
  controlUiAllowedOrigins?: string[];
  providerMode?: "mock-openai" | "live-frontier";
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
  const liveProviderIds =
    providerMode === "live-frontier"
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
    cfg = await stageQaLiveAnthropicSetupToken({
      cfg,
      stateDir,
    });
    if (providerMode === "mock-openai") {
      cfg = await stageQaMockAuthProfiles({
        cfg,
        stateDir,
      });
    }
    return params.mutateConfig ? params.mutateConfig(cfg) : cfg;
  };
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutLogPath = path.join(tempRoot, "gateway.stdout.log");
  const stderrLogPath = path.join(tempRoot, "gateway.stderr.log");
  const stdoutLog = createWriteStream(stdoutLogPath, { flags: "a" });
  const stderrLog = createWriteStream(stderrLogPath, { flags: "a" });

  const logs = () =>
    `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`.trim();
  const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1";
  let gatewayPort = 0;
  let baseUrl = "";
  let wsUrl = "";
  let child: ReturnType<typeof spawn> | null = null;
  let cfg: ReturnType<typeof buildQaGatewayConfig> | null = null;
  let rpcClient: Awaited<ReturnType<typeof startQaGatewayRpcClient>> | null = null;
  let stagedBundledPluginsRoot: string | null = null;
  let env: NodeJS.ProcessEnv | null = null;

  try {
    const nodeExecPath = await resolveQaNodeExecPath();
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
        const { bundledPluginsDir, stagedRoot } = await createQaBundledPluginsDir({
          repoRoot: params.repoRoot,
          tempRoot,
          allowedPluginIds,
        });
        stagedBundledPluginsRoot = stagedRoot;
        const runtimeHostVersion = await resolveQaRuntimeHostVersion({
          repoRoot: params.repoRoot,
          allowedPluginIds,
        });
        env = buildQaRuntimeEnv({
          configPath,
          gatewayToken,
          homeDir,
          forwardHostHome: params.forwardHostHome,
          stateDir,
          xdgConfigHome,
          xdgDataHome,
          xdgCacheHome,
          bundledPluginsDir,
          compatibilityHostVersion: runtimeHostVersion,
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

      const attemptChild = spawn(
        nodeExecPath,
        [
          distEntryPath,
          "gateway",
          "run",
          "--port",
          String(gatewayPort),
          "--bind",
          "loopback",
          "--allow-unconfigured",
        ],
        {
          cwd: runtimeCwd,
          env,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      attemptChild.stdout.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stdout.push(buffer);
        stdoutLog.write(buffer);
      });
      attemptChild.stderr.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stderr.push(buffer);
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
                timeoutMs: 15_000,
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
    const runningChild = child;
    const runningRpcClient = rpcClient;
    const runningEnv = env;

    return {
      cfg,
      baseUrl,
      wsUrl,
      pid: child.pid ?? null,
      token: gatewayToken,
      workspaceDir,
      tempRoot,
      configPath,
      runtimeEnv: runningEnv,
      logs,
      async restart(signal: NodeJS.Signals = "SIGUSR1") {
        if (!runningChild.pid) {
          throw new Error("qa gateway child has no pid");
        }
        process.kill(runningChild.pid, signal);
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
            return await runningRpcClient.request(method, rpcParams, {
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
              child: runningChild,
              timeoutMs: Math.max(10_000, timeoutMs),
            });
          }
        }
        throw new Error(`${lastDetails}${formatQaGatewayLogsForError(logs())}`);
      },
      async stop(opts?: { keepTemp?: boolean; preserveToDir?: string }) {
        await runningRpcClient.stop().catch(() => {});
        await stopQaGatewayChildProcessTree(runningChild);
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
