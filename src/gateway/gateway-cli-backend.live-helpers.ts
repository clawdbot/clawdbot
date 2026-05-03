import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCliBackendLiveTest } from "../agents/cli-backends.js";
import { migrateLegacyRuntimeModelRef } from "../agents/model-runtime-aliases.js";
import { parseModelRef } from "../agents/model-selection.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";

// Aggregate docker live runs can contend on startup enough that the gateway
// websocket handshake needs a wider budget than the single-provider reruns.
const CLI_GATEWAY_CONNECT_TIMEOUT_MS = 60_000;

export type BootstrapWorkspaceContext = {
  expectedInjectedFiles: string[];
  workspaceDir: string;
  workspaceRootDir: string;
};

export type SystemPromptReport = {
  injectedWorkspaceFiles?: Array<{ name?: string }>;
};

export type CliBackendLiveModelSelection = {
  providerId: string;
  cliModelKey: string;
  configModelKey: string;
  configModelSwitchTarget: string | undefined;
  agentRuntime: { id: string };
};

export type CliBackendLiveEnvSnapshot = {
  configPath?: string;
  stateDir?: string;
  token?: string;
  skipChannels?: string;
  skipProviders?: string;
  skipGmail?: string;
  skipCron?: string;
  skipCanvas?: string;
  skipBrowserControl?: string;
  bundledPluginsDir?: string;
  minimalGateway?: string;
  anthropicApiKey?: string;
  anthropicApiKeyOld?: string;
};

export function resolveCliBackendLiveModelSelection(params: {
  rawModel: string;
  defaultProvider: string;
  modelSwitchTarget?: string;
}): CliBackendLiveModelSelection {
  const parsed = parseModelRef(params.rawModel, params.defaultProvider);
  if (!parsed) {
    throw new Error(
      `OPENCLAW_LIVE_CLI_BACKEND_MODEL must resolve to a CLI backend model. Got: ${params.rawModel}`,
    );
  }

  const migrated = migrateLegacyRuntimeModelRef(params.rawModel);
  if (migrated?.cli) {
    return {
      providerId: migrated.runtime,
      cliModelKey: `${migrated.runtime}/${migrated.model}`,
      configModelKey: migrated.ref,
      configModelSwitchTarget: params.modelSwitchTarget
        ? (migrateLegacyRuntimeModelRef(params.modelSwitchTarget)?.ref ?? params.modelSwitchTarget)
        : undefined,
      agentRuntime: { id: migrated.runtime },
    };
  }

  const modelKey = `${parsed.provider}/${parsed.model}`;
  return {
    providerId: parsed.provider,
    cliModelKey: modelKey,
    configModelKey: modelKey,
    configModelSwitchTarget: params.modelSwitchTarget,
    agentRuntime: { id: "pi" },
  };
}

export function parseJsonStringArray(name: string, raw?: string): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return parsed;
}

export function parseImageMode(raw?: string): "list" | "repeat" | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "list" || trimmed === "repeat") {
    return trimmed;
  }
  throw new Error("OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE must be 'list' or 'repeat'.");
}

export function shouldRunCliImageProbe(providerId: string): boolean {
  const raw = process.env.OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE?.trim();
  if (raw) {
    return isTruthyEnvValue(raw);
  }
  return resolveCliBackendLiveTest(providerId)?.defaultImageProbe === true;
}

export function shouldRunCliMcpProbe(providerId: string): boolean {
  const raw = process.env.OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE?.trim();
  if (raw) {
    return isTruthyEnvValue(raw);
  }
  return resolveCliBackendLiveTest(providerId)?.defaultMcpProbe === true;
}

export function resolveCliBackendLiveArgs(params: {
  providerId: string;
  defaultArgs?: string[];
  defaultResumeArgs?: string[];
}): { args: string[]; resumeArgs?: string[] } {
  const args =
    parseJsonStringArray(
      "OPENCLAW_LIVE_CLI_BACKEND_ARGS",
      process.env.OPENCLAW_LIVE_CLI_BACKEND_ARGS,
    ) ?? params.defaultArgs;
  if (!args || args.length === 0) {
    throw new Error(
      `OPENCLAW_LIVE_CLI_BACKEND_ARGS is required for provider "${params.providerId}".`,
    );
  }
  const resumeArgs =
    parseJsonStringArray(
      "OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS",
      process.env.OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS,
    ) ?? params.defaultResumeArgs;
  return { args, resumeArgs };
}

export function resolveCliModelSwitchProbeTarget(
  providerId: string,
  modelRef: string,
): string | undefined {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(providerId);
  const normalizedModelRef = normalizeLowercaseStringOrEmpty(modelRef);
  if (normalizedProvider !== "claude-cli") {
    return undefined;
  }
  if (normalizedModelRef !== "claude-cli/claude-sonnet-4-6") {
    return undefined;
  }
  return "claude-cli/claude-opus-4-6";
}

export function shouldRunCliModelSwitchProbe(providerId: string, modelRef: string): boolean {
  const raw = process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE?.trim();
  if (raw) {
    return isTruthyEnvValue(raw);
  }
  return typeof resolveCliModelSwitchProbeTarget(providerId, modelRef) === "string";
}

export function matchesCliBackendReply(text: string, expected: string): boolean {
  const normalized = text.trim();
  const target = expected.trim();
  const targetWithoutPeriod = target.slice(0, -1);
  return (
    normalized === target ||
    normalized === targetWithoutPeriod ||
    normalized.includes(target) ||
    normalized.includes(targetWithoutPeriod)
  );
}

export function withClaudeMcpConfigOverrides(args: string[], mcpConfigPath: string): string[] {
  const next = [...args];
  if (!next.includes("--strict-mcp-config")) {
    next.push("--strict-mcp-config");
  }
  if (!next.includes("--mcp-config")) {
    next.push("--mcp-config", mcpConfigPath);
  }
  return next;
}

export async function getFreeGatewayPort(): Promise<number> {
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 40_000,
  });
}

export async function createBootstrapWorkspace(
  tempDir: string,
): Promise<BootstrapWorkspaceContext> {
  const workspaceRootDir = path.join(tempDir, "workspace");
  const workspaceDir = path.join(workspaceRootDir, "dev");
  const expectedInjectedFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "Follow exact reply instructions from the user.",
      "Do not add extra punctuation when the user asks for an exact response.",
    ].join("\n"),
  );
  await fs.writeFile(path.join(workspaceDir, "SOUL.md"), `SOUL-${randomUUID()}\n`);
  await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), `IDENTITY-${randomUUID()}\n`);
  await fs.writeFile(path.join(workspaceDir, "USER.md"), `USER-${randomUUID()}\n`);
  return { expectedInjectedFiles, workspaceDir, workspaceRootDir };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetryCliCronMcpProbeReply(text: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(text);
  if (!normalized) {
    return true;
  }
  const mentionsCancellation =
    normalized.includes("tool call was cancelled") ||
    normalized.includes("tool call was canceled") ||
    normalized.includes("tool call was cancelled before completion") ||
    normalized.includes("tool call was canceled before completion") ||
    normalized.includes("attempts were cancelled") ||
    normalized.includes("attempts were canceled") ||
    normalized.includes("cancelled by the environment") ||
    normalized.includes("canceled by the environment") ||
    normalized.includes("mcp call was cancelled") ||
    normalized.includes("mcp call was canceled");
  const mentionsUserCancellation =
    normalized.includes("user cancelled mcp tool call") ||
    normalized.includes("user canceled mcp tool call");
  const mentionsCreateFailure =
    normalized.includes("could not create ") ||
    normalized.includes("couldn't create ") ||
    normalized.includes("couldn’t create ") ||
    normalized.includes("could not create the job") ||
    normalized.includes("couldn't create the job") ||
    normalized.includes("couldn’t create the job") ||
    normalized.includes("could not create job") ||
    normalized.includes("couldn't create job") ||
    normalized.includes("couldn’t create job");
  const mentionsRetryRequest =
    normalized.includes("please retry") ||
    normalized.includes("i can try again") ||
    normalized.includes("i'll retry") ||
    normalized.includes("i’ll retry") ||
    normalized.includes("send the same request again");
  const mentionsMissingJob =
    normalized.includes("job was not created") ||
    normalized.includes("job still was not created") ||
    normalized.includes("nothing was created") ||
    normalized.includes("verify the cron job was created") ||
    normalized.includes("was not created");
  if (mentionsUserCancellation) {
    return true;
  }
  return (
    mentionsCancellation && (mentionsMissingJob || mentionsCreateFailure || mentionsRetryRequest)
  );
}

export async function connectTestGatewayClient(params: {
  url: string;
  token: string;
  deviceIdentity?: DeviceIdentity;
  timeoutMs?: number;
  maxAttemptTimeoutMs?: number;
  clientDisplayName?: string | null;
  requestTimeoutMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
}): Promise<GatewayClient> {
  const timeoutMs = params.timeoutMs ?? CLI_GATEWAY_CONNECT_TIMEOUT_MS;
  const maxAttemptTimeoutMs = params.maxAttemptTimeoutMs ?? 45_000;
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: Error | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    try {
      return await connectClientOnce({
        ...params,
        timeoutMs: Math.min(remainingMs, maxAttemptTimeoutMs),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableGatewayConnectError(lastError) || remainingMs <= 5_000) {
        throw lastError;
      }
      params.onRetry?.(attempt, lastError);
      await sleep(Math.min(1_000 * attempt, 5_000));
    }
  }

  throw lastError ?? new Error("gateway connect timeout");
}

async function connectClientOnce(params: {
  url: string;
  token: string;
  timeoutMs: number;
  deviceIdentity?: DeviceIdentity;
  clientDisplayName?: string | null;
  requestTimeoutMs?: number;
}): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let done = false;
    let client: GatewayClient | undefined;
    const abortStart = new AbortController();
    const finish = (result: { client?: GatewayClient; error?: Error }) => {
      if (done) {
        return;
      }
      done = true;
      abortStart.abort();
      clearTimeout(connectTimeout);
      if (result.error) {
        if (client) {
          void client.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        }
        reject(result.error);
        return;
      }
      resolve(result.client as GatewayClient);
    };

    const failWithClose = (code: number, reason: string) =>
      finish({ error: new Error(`gateway closed during connect (${code}): ${reason}`) });

    const clientOptions: GatewayClientOptions = {
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      connectChallengeTimeoutMs: params.timeoutMs,
      deviceIdentity: params.deviceIdentity,
      onHelloOk: () => finish({ client }),
      onConnectError: (error) => finish({ error }),
      onClose: failWithClose,
    };
    if (params.clientDisplayName !== null) {
      clientOptions.clientDisplayName = params.clientDisplayName ?? "vitest-live";
    }
    if (params.requestTimeoutMs !== undefined) {
      clientOptions.requestTimeoutMs = params.requestTimeoutMs;
    }

    client = new GatewayClient(clientOptions);

    const connectTimeout = setTimeout(
      () => finish({ error: new Error("gateway connect timeout") }),
      params.timeoutMs,
    );
    connectTimeout.unref();
    void startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: params.timeoutMs,
      signal: abortStart.signal,
    }).then(
      (readiness) => {
        if (!readiness.ready && !readiness.aborted) {
          finish({ error: new Error("gateway event loop readiness timeout") });
        }
      },
      (error) => {
        finish({ error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
  });
}

function isRetryableGatewayConnectError(error: Error): boolean {
  const message = normalizeLowercaseStringOrEmpty(error.message);
  return (
    message.includes("gateway closed during connect (1000)") ||
    message.includes("gateway connect timeout") ||
    message.includes("gateway connect challenge timeout") ||
    message.includes("gateway request timeout for connect") ||
    message.includes("gateway client stopped")
  );
}

export function snapshotCliBackendLiveEnv(): CliBackendLiveEnvSnapshot {
  return {
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipProviders: process.env.OPENCLAW_SKIP_PROVIDERS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    skipBrowserControl: process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER,
    bundledPluginsDir: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
    minimalGateway: process.env.OPENCLAW_TEST_MINIMAL_GATEWAY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicApiKeyOld: process.env.ANTHROPIC_API_KEY_OLD,
  };
}

export function applyCliBackendLiveEnv(preservedEnv: ReadonlySet<string>): void {
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_PROVIDERS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
  if (!preservedEnv.has("ANTHROPIC_API_KEY")) {
    delete process.env.ANTHROPIC_API_KEY;
  }
  if (!preservedEnv.has("ANTHROPIC_API_KEY_OLD")) {
    delete process.env.ANTHROPIC_API_KEY_OLD;
  }
}

export function restoreCliBackendLiveEnv(snapshot: CliBackendLiveEnvSnapshot): void {
  restoreEnvVar("OPENCLAW_CONFIG_PATH", snapshot.configPath);
  restoreEnvVar("OPENCLAW_STATE_DIR", snapshot.stateDir);
  restoreEnvVar("OPENCLAW_GATEWAY_TOKEN", snapshot.token);
  restoreEnvVar("OPENCLAW_SKIP_CHANNELS", snapshot.skipChannels);
  restoreEnvVar("OPENCLAW_SKIP_PROVIDERS", snapshot.skipProviders);
  restoreEnvVar("OPENCLAW_SKIP_GMAIL_WATCHER", snapshot.skipGmail);
  restoreEnvVar("OPENCLAW_SKIP_CRON", snapshot.skipCron);
  restoreEnvVar("OPENCLAW_SKIP_CANVAS_HOST", snapshot.skipCanvas);
  restoreEnvVar("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", snapshot.skipBrowserControl);
  restoreEnvVar("OPENCLAW_BUNDLED_PLUGINS_DIR", snapshot.bundledPluginsDir);
  restoreEnvVar("OPENCLAW_TEST_MINIMAL_GATEWAY", snapshot.minimalGateway);
  restoreEnvVar("ANTHROPIC_API_KEY", snapshot.anthropicApiKey);
  restoreEnvVar("ANTHROPIC_API_KEY_OLD", snapshot.anthropicApiKeyOld);
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export async function ensurePairedTestGatewayClientIdentity(params?: {
  displayName?: string;
}): Promise<DeviceIdentity> {
  const identity = loadOrCreateDeviceIdentity();
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const requiredScopes = ["operator.admin"];
  const paired = await getPairedDevice(identity.deviceId);
  const pairedScopes = Array.isArray(paired?.approvedScopes)
    ? paired.approvedScopes
    : Array.isArray(paired?.scopes)
      ? paired.scopes
      : [];
  if (
    paired?.publicKey === publicKey &&
    requiredScopes.every((scope) => pairedScopes.includes(scope))
  ) {
    return identity;
  }
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey,
    displayName: params?.displayName ?? "vitest",
    platform: process.platform,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
    role: "operator",
    scopes: requiredScopes,
    silent: true,
  });
  const approved = await approveDevicePairing(pairing.request.requestId, {
    callerScopes: requiredScopes,
  });
  if (approved?.status !== "approved") {
    throw new Error(
      `failed to pre-pair live test device: ${approved?.status ?? "missing-approval-result"}`,
    );
  }
  return identity;
}
