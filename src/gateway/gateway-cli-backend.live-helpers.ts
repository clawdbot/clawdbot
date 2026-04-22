import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCliBackendLiveTest } from "../agents/cli-backends.js";
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
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import {
  assertCronJobMatches,
  assertCronJobVisibleViaCli,
  assertLiveImageProbeReply,
  buildLiveCronProbeMessage,
  createLiveCronProbeSpec,
  runOpenClawCliJson,
  type CronListJob,
} from "./live-agent-probes.js";
import { renderCatFacePngBase64 } from "./live-image-probe.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.js";
import { resolveMcpLoopbackBearerToken } from "./mcp-http.loopback-runtime.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

// Aggregate docker live runs can contend on startup enough that the gateway
// websocket handshake needs a wider budget than the single-provider reruns.
const CLI_GATEWAY_CONNECT_TIMEOUT_MS = 60_000;
// CI Docker live lanes can see repeated cancelled cron tool calls before a job
// finally sticks, and the created job may take extra time to surface via the CLI.
const CLI_CRON_MCP_PROBE_MAX_ATTEMPTS = 10;
const CLI_CRON_MCP_PROBE_VERIFY_POLLS = 20;
const CLI_CRON_MCP_PROBE_VERIFY_POLL_MS = 2_000;

function shouldLogCliCronProbe(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG) ||
    isTruthyEnvValue(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT)
  );
}

function logCliCronProbe(step: string, details?: Record<string, unknown>): void {
  if (!shouldLogCliCronProbe()) {
    return;
  }
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  console.error(`[gateway-cli-live:cron] ${step}${suffix}`);
}

export type BootstrapWorkspaceContext = {
  expectedInjectedFiles: string[];
  workspaceDir: string;
  workspaceRootDir: string;
};

export type SystemPromptReport = {
  injectedWorkspaceFiles?: Array<{ name?: string }>;
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
  return normalized === target || normalized === target.slice(0, -1);
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

async function pollCliCronJobVisible(params: {
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
  expectedName: string;
  expectedMessage: string;
  polls?: number;
  pollMs?: number;
}): Promise<{ job?: CronListJob; pollsUsed: number }> {
  const polls = Math.max(1, params.polls ?? CLI_CRON_MCP_PROBE_VERIFY_POLLS);
  const pollMs = Math.max(0, params.pollMs ?? CLI_CRON_MCP_PROBE_VERIFY_POLL_MS);
  for (let verifyAttempt = 0; verifyAttempt < polls; verifyAttempt += 1) {
    const job = await assertCronJobVisibleViaCli({
      port: params.port,
      token: params.token,
      env: params.env,
      expectedName: params.expectedName,
      expectedMessage: params.expectedMessage,
    });
    if (job) {
      return { job, pollsUsed: verifyAttempt + 1 };
    }
    if (verifyAttempt < polls - 1) {
      await sleep(pollMs);
    }
  }
  return { pollsUsed: polls };
}

type LoopbackJsonRpcResponse = {
  result?: unknown;
  error?: { message?: string };
};

async function callLoopbackJsonRpc(params: {
  sessionKey: string;
  senderIsOwner: boolean;
  messageProvider?: string;
  accountId?: string;
  body: Record<string, unknown>;
}): Promise<LoopbackJsonRpcResponse> {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("mcp loopback runtime is not active");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolveMcpLoopbackBearerToken(runtime, params.senderIsOwner)}`,
    "Content-Type": "application/json",
    "x-session-key": params.sessionKey,
  };
  if (params.messageProvider) {
    headers["x-openclaw-message-channel"] = params.messageProvider;
  }
  if (params.accountId) {
    headers["x-openclaw-account-id"] = params.accountId;
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(params.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`mcp loopback http ${response.status}: ${text}`);
  }
  if (!text.trim()) {
    return {};
  }
  const parsed = JSON.parse(text) as LoopbackJsonRpcResponse;
  if (parsed.error?.message) {
    throw new Error(`mcp loopback json-rpc error: ${parsed.error.message}`);
  }
  return parsed;
}

export async function verifyCliCronMcpLoopbackPreflight(params: {
  sessionKey: string;
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
  senderIsOwner: boolean;
  messageProvider?: string;
  accountId?: string;
}): Promise<void> {
  const cronProbe = createLiveCronProbeSpec();
  logCliCronProbe("loopback-preflight:start", {
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    jobName: cronProbe.name,
  });

  await callLoopbackJsonRpc({
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
    body: {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vitest" } },
    },
  });
  await callLoopbackJsonRpc({
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  const toolsList = await callLoopbackJsonRpc({
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
    body: { jsonrpc: "2.0", id: "tools-list", method: "tools/list" },
  });
  const tools = Array.isArray((toolsList.result as { tools?: unknown[] } | undefined)?.tools)
    ? (((toolsList.result as { tools?: unknown[] }).tools ?? []) as Array<{ name?: string }>)
    : [];
  const toolNames = tools
    .map((tool) => (typeof tool.name === "string" ? tool.name : ""))
    .filter(Boolean);
  logCliCronProbe("loopback-preflight:tools", {
    senderIsOwner: params.senderIsOwner,
    toolCount: toolNames.length,
    cronVisible: toolNames.includes("cron"),
  });
  if (!toolNames.includes("cron")) {
    throw new Error(
      `mcp loopback tools/list did not expose cron (senderIsOwner=${String(params.senderIsOwner)})`,
    );
  }

  const toolCall = await callLoopbackJsonRpc({
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
    body: {
      jsonrpc: "2.0",
      id: "cron-add",
      method: "tools/call",
      params: {
        name: "cron",
        arguments: JSON.parse(cronProbe.argsJson) as Record<string, unknown>,
      },
    },
  });
  const toolCallError =
    (toolCall.result as { isError?: unknown } | undefined)?.isError === true ||
    !(toolCall.result as { content?: unknown } | undefined);
  logCliCronProbe("loopback-preflight:call", {
    isError: toolCallError,
    jobName: cronProbe.name,
  });
  if (toolCallError) {
    throw new Error(`mcp loopback cron tools/call returned isError for job ${cronProbe.name}`);
  }

  const { job: createdJob, pollsUsed } = await pollCliCronJobVisible({
    port: params.port,
    token: params.token,
    env: params.env,
    expectedName: cronProbe.name,
    expectedMessage: cronProbe.message,
  });
  logCliCronProbe("loopback-preflight:verify", {
    jobName: cronProbe.name,
    pollsUsed,
    createdJob: Boolean(createdJob),
  });
  if (!createdJob) {
    throw new Error(`mcp loopback cron tools/call did not create job ${cronProbe.name}`);
  }
  assertCronJobMatches({
    job: createdJob,
    expectedName: cronProbe.name,
    expectedMessage: cronProbe.message,
    expectedSessionKey: params.sessionKey,
  });
  if (createdJob.id) {
    await runOpenClawCliJson(
      [
        "cron",
        "rm",
        createdJob.id,
        "--json",
        "--url",
        `ws://127.0.0.1:${params.port}`,
        "--token",
        params.token,
      ],
      params.env,
    );
  }
  logCliCronProbe("loopback-preflight:done", { jobName: cronProbe.name });
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

function getCliBackendProbeThinking(providerId: string): "low" | undefined {
  return normalizeLowercaseStringOrEmpty(providerId) === "codex-cli" ? "low" : undefined;
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
    const finish = (result: { client?: GatewayClient; error?: Error }) => {
      if (done) {
        return;
      }
      done = true;
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
    client.start();
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

export async function verifyCliBackendImageProbe(params: {
  client: GatewayClient;
  providerId: string;
  sessionKey: string;
  tempDir: string;
  bootstrapWorkspace: BootstrapWorkspaceContext | null;
}): Promise<void> {
  const thinking = getCliBackendProbeThinking(params.providerId);
  const imageBase64 = renderCatFacePngBase64();
  const runIdImage = randomUUID();
  const imageProbe = await params.client.request(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${runIdImage}-image`,
      // Route all providers through the same attachment pipeline. Claude CLI
      // still receives a local file path, but now via the runner code we
      // actually want to validate instead of an ad hoc prompt-only shortcut.
      message:
        "Best match for the image: lobster, mouse, cat, horse. " +
        "Reply with one lowercase word only.",
      attachments: [
        {
          mimeType: "image/png",
          fileName: `probe-${runIdImage}.png`,
          content: imageBase64,
        },
      ],
      deliver: false,
      ...(thinking ? { thinking } : {}),
    },
    { expectFinal: true },
  );
  if (imageProbe?.status !== "ok") {
    throw new Error(`image probe failed: status=${String(imageProbe?.status)}`);
  }
  assertLiveImageProbeReply(extractPayloadText(imageProbe?.result));
}

export async function verifyCliCronMcpProbe(params: {
  client: GatewayClient;
  providerId: string;
  sessionKey: string;
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const cronProbe = createLiveCronProbeSpec();
  const thinking = getCliBackendProbeThinking(params.providerId);

  let createdJob: CronListJob | undefined;
  let lastCronText = "";

  for (let attempt = 0; attempt < CLI_CRON_MCP_PROBE_MAX_ATTEMPTS && !createdJob; attempt += 1) {
    logCliCronProbe("agent-attempt:start", {
      attempt,
      providerId: params.providerId,
      sessionKey: params.sessionKey,
      expectedJob: cronProbe.name,
    });
    const runIdMcp = randomUUID();
    const cronResult = await params.client.request(
      "agent",
      {
        sessionKey: params.sessionKey,
        idempotencyKey: `idem-${runIdMcp}-mcp-${attempt}`,
        message: buildLiveCronProbeMessage({
          agent: params.providerId,
          argsJson: cronProbe.argsJson,
          attempt,
          exactReply: cronProbe.name,
        }),
        deliver: false,
        ...(thinking ? { thinking } : {}),
      },
      { expectFinal: true },
    );
    if (cronResult?.status !== "ok") {
      throw new Error(`cron mcp probe failed: status=${String(cronResult?.status)}`);
    }
    lastCronText = extractPayloadText(cronResult?.result).trim();
    const retryableReply = shouldRetryCliCronMcpProbeReply(lastCronText);
    logCliCronProbe("agent-attempt:reply", {
      attempt,
      retryableReply,
      reply: lastCronText,
    });
    const verifyResult = await pollCliCronJobVisible({
      port: params.port,
      token: params.token,
      env: params.env,
      expectedName: cronProbe.name,
      expectedMessage: cronProbe.message,
    });
    createdJob = verifyResult.job;
    logCliCronProbe("agent-attempt:verify", {
      attempt,
      pollsUsed: verifyResult.pollsUsed,
      createdJob: Boolean(createdJob),
      retryableReply,
    });
    if (!createdJob && !retryableReply) {
      throw new Error(
        `cron cli verify could not find job ${cronProbe.name} after attempt ${attempt + 1}: reply=${JSON.stringify(lastCronText)}`,
      );
    }
  }

  if (!createdJob) {
    throw new Error(
      `cron cli verify did not create job ${cronProbe.name} after ${CLI_CRON_MCP_PROBE_MAX_ATTEMPTS} attempts: reply=${JSON.stringify(lastCronText)}`,
    );
  }
  assertCronJobMatches({
    job: createdJob,
    expectedName: cronProbe.name,
    expectedMessage: cronProbe.message,
    expectedSessionKey: params.sessionKey,
  });
  if (createdJob?.id) {
    await runOpenClawCliJson(
      [
        "cron",
        "rm",
        createdJob.id,
        "--json",
        "--url",
        `ws://127.0.0.1:${params.port}`,
        "--token",
        params.token,
      ],
      params.env,
    );
  }
}
