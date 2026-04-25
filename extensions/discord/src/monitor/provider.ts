import { inspect } from "node:util";
import {
  Client,
  RateLimitError,
  type BaseCommand,
  type BaseMessageInteractiveComponent,
  type Modal,
} from "@buape/carbon";
import { GatewayCloseCodes, type GatewayPlugin } from "@buape/carbon/gateway";
import { Routes } from "discord-api-types/v10";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  listNativeCommandSpecsForConfig,
  listSkillCommandsForAgents,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/command-auth";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { createConnectedChannelStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import {
  danger,
  isVerbose,
  logVerbose,
  shouldLogVerbose,
  warn,
} from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  summarizeStringEntries,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordAccount } from "../accounts.js";
import { isDiscordExecApprovalClientEnabled } from "../exec-approvals.js";
import { fetchDiscordApplicationId } from "../probe.js";
import { resolveDiscordProxyFetchForAccount } from "../proxy-fetch.js";
import { normalizeDiscordToken } from "../token.js";
import { createDiscordVoiceCommand } from "../voice/command.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  createDiscordComponentButton,
  createDiscordComponentChannelSelect,
  createDiscordComponentMentionableSelect,
  createDiscordComponentModal,
  createDiscordComponentRoleSelect,
  createDiscordComponentStringSelect,
  createDiscordComponentUserSelect,
} from "./agent-components.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import {
  createExecApprovalButton,
  createDiscordExecApprovalButtonContext,
} from "./exec-approvals.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import { registerDiscordListener } from "./listeners.js";
import {
  createDiscordCommandArgFallbackButton,
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
  createDiscordNativeCommand,
} from "./native-command.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";
import { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";
import {
  createDiscordMonitorClient,
  fetchDiscordBotIdentity,
  registerDiscordMonitorListeners,
} from "./provider.startup.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";
import { formatDiscordStartupStatusMessage } from "./startup-status.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { formatThreadBindingDurationLabel } from "./thread-bindings.messages.js";

export type MonitorDiscordOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
  setStatus?: DiscordMonitorStatusSink;
};

const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;

type DiscordVoiceManager = import("../voice/manager.js").DiscordVoiceManager;

type DiscordVoiceRuntimeModule = typeof import("../voice/manager.runtime.js");
type DiscordProviderSessionRuntimeModule = typeof import("./provider-session.runtime.js");
type GetPluginCommandSpecs =
  typeof import("openclaw/plugin-sdk/plugin-runtime").getPluginCommandSpecs;

let discordVoiceRuntimePromise: Promise<DiscordVoiceRuntimeModule> | undefined;
let discordProviderSessionRuntimePromise: Promise<DiscordProviderSessionRuntimeModule> | undefined;
let pluginRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/plugin-runtime")> | undefined;

let fetchDiscordApplicationIdForTesting: typeof fetchDiscordApplicationId | undefined;
let createDiscordNativeCommandForTesting: typeof createDiscordNativeCommand | undefined;
let runDiscordGatewayLifecycleForTesting: typeof runDiscordGatewayLifecycle | undefined;
let createDiscordGatewayPluginForTesting: typeof createDiscordGatewayPlugin | undefined;
let createDiscordGatewaySupervisorForTesting: typeof createDiscordGatewaySupervisor | undefined;
let loadDiscordVoiceRuntimeForTesting: (() => Promise<DiscordVoiceRuntimeModule>) | undefined;
let loadDiscordProviderSessionRuntimeForTesting:
  | (() => Promise<DiscordProviderSessionRuntimeModule>)
  | undefined;
let createClientForTesting:
  | ((
      options: ConstructorParameters<typeof Client>[0],
      handlers: ConstructorParameters<typeof Client>[1],
      plugins: ConstructorParameters<typeof Client>[2],
    ) => Client)
  | undefined;
let getPluginCommandSpecsForTesting: GetPluginCommandSpecs | undefined;
let resolveDiscordAccountForTesting: typeof resolveDiscordAccount | undefined;
let resolveNativeCommandsEnabledForTesting: typeof resolveNativeCommandsEnabled | undefined;
let resolveNativeSkillsEnabledForTesting: typeof resolveNativeSkillsEnabled | undefined;
let listNativeCommandSpecsForConfigForTesting: typeof listNativeCommandSpecsForConfig | undefined;
let listSkillCommandsForAgentsForTesting: typeof listSkillCommandsForAgents | undefined;
let isVerboseForTesting: typeof isVerbose | undefined;
let shouldLogVerboseForTesting: typeof shouldLogVerbose | undefined;

async function loadDiscordVoiceRuntime(): Promise<DiscordVoiceRuntimeModule> {
  if (loadDiscordVoiceRuntimeForTesting) {
    return await loadDiscordVoiceRuntimeForTesting();
  }
  discordVoiceRuntimePromise ??= import("../voice/manager.runtime.js");
  return await discordVoiceRuntimePromise;
}

async function loadDiscordProviderSessionRuntime(): Promise<DiscordProviderSessionRuntimeModule> {
  if (loadDiscordProviderSessionRuntimeForTesting) {
    return await loadDiscordProviderSessionRuntimeForTesting();
  }
  discordProviderSessionRuntimePromise ??= import("./provider-session.runtime.js");
  return await discordProviderSessionRuntimePromise;
}

async function loadPluginRuntime() {
  pluginRuntimePromise ??= import("openclaw/plugin-sdk/plugin-runtime");
  return await pluginRuntimePromise;
}

function normalizeBooleanForTesting(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function resolveThreadBindingsEnabledForTesting(params: {
  channelEnabledRaw: unknown;
  sessionEnabledRaw: unknown;
}): boolean {
  return (
    normalizeBooleanForTesting(params.channelEnabledRaw) ??
    normalizeBooleanForTesting(params.sessionEnabledRaw) ??
    true
  );
}

function formatThreadBindingDurationForConfigLabel(durationMs: number): string {
  const label = formatThreadBindingDurationLabel(durationMs);
  return label === "disabled" ? "off" : label;
}

async function appendPluginCommandSpecs(params: {
  commandSpecs: NativeCommandSpec[];
  runtime: RuntimeEnv;
}): Promise<NativeCommandSpec[]> {
  const merged = [...params.commandSpecs];
  const existingNames = new Set(
    merged.map((spec) => normalizeLowercaseStringOrEmpty(spec.name)).filter(Boolean),
  );
  const getPluginCommandSpecs =
    getPluginCommandSpecsForTesting ?? (await loadPluginRuntime()).getPluginCommandSpecs;
  for (const pluginCommand of getPluginCommandSpecs("discord")) {
    const normalizedName = normalizeLowercaseStringOrEmpty(pluginCommand.name);
    if (!normalizedName) {
      continue;
    }
    if (existingNames.has(normalizedName)) {
      params.runtime.error?.(
        danger(
          `discord: plugin command "/${normalizedName}" duplicates an existing native command. Skipping.`,
        ),
      );
      continue;
    }
    existingNames.add(normalizedName);
    merged.push({
      name: pluginCommand.name,
      description: pluginCommand.description,
      acceptsArgs: pluginCommand.acceptsArgs,
    });
  }
  return merged;
}

const DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS = 8_000;
const DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS = 2 * 60 * 1000;

function isLegacyMissingSessionError(message: string): boolean {
  return (
    message.includes("Session is not ACP-enabled") ||
    message.includes("ACP session metadata missing")
  );
}

function classifyAcpStatusProbeError(params: {
  error: unknown;
  isStaleRunning: boolean;
  isAcpRuntimeError: DiscordProviderSessionRuntimeModule["isAcpRuntimeError"];
}): {
  status: "stale" | "uncertain";
  reason: string;
} {
  if (params.isAcpRuntimeError(params.error) && params.error.code === "ACP_SESSION_INIT_FAILED") {
    return { status: "stale", reason: "session-init-failed" };
  }

  const message = formatErrorMessage(params.error);
  if (isLegacyMissingSessionError(message)) {
    return { status: "stale", reason: "session-missing" };
  }

  return params.isStaleRunning
    ? { status: "stale", reason: "status-error-running-stale" }
    : { status: "uncertain", reason: "status-error" };
}

async function probeDiscordAcpBindingHealth(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storedState?: "idle" | "running" | "error";
  lastActivityAt?: number;
}): Promise<{ status: "healthy" | "stale" | "uncertain"; reason?: string }> {
  const { getAcpSessionManager, isAcpRuntimeError } = await loadDiscordProviderSessionRuntime();
  const manager = getAcpSessionManager();
  const statusProbeAbortController = new AbortController();
  const statusPromise = manager
    .getSessionStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      signal: statusProbeAbortController.signal,
    })
    .then((status) => ({ kind: "status" as const, status }))
    .catch((error: unknown) => ({ kind: "error" as const, error }));

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutTimer = setTimeout(
      () => resolve({ kind: "timeout" }),
      DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS,
    );
    timeoutTimer.unref?.();
  });
  const result = await Promise.race([statusPromise, timeoutPromise]);
  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
  }
  if (result.kind === "timeout") {
    statusProbeAbortController.abort();
  }
  const runningForMs =
    params.storedState === "running" && Number.isFinite(params.lastActivityAt)
      ? Date.now() - Math.max(0, Math.floor(params.lastActivityAt ?? 0))
      : 0;
  const isStaleRunning =
    params.storedState === "running" && runningForMs >= DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS;

  if (result.kind === "timeout") {
    return isStaleRunning
      ? { status: "stale", reason: "status-timeout-running-stale" }
      : { status: "uncertain", reason: "status-timeout" };
  }
  if (result.kind === "error") {
    return classifyAcpStatusProbeError({
      error: result.error,
      isStaleRunning,
      isAcpRuntimeError,
    });
  }
  if (result.status.state === "error") {
    // ACP error state is recoverable (next turn can clear it), so keep the
    // binding unless stronger stale signals exist.
    return { status: "uncertain", reason: "status-error-state" };
  }
  return { status: "healthy" };
}

async function deployDiscordCommands(params: {
  client: Client;
  runtime: RuntimeEnv;
  enabled: boolean;
  accountId?: string;
  startupStartedAt?: number;
}) {
  if (!params.enabled) {
    return;
  }
  const startupStartedAt = params.startupStartedAt ?? Date.now();
  const accountId = params.accountId ?? "default";
  const maxAttempts = 3;
  const maxRetryDelayMs = 15_000;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const isDailyCreateLimit = (err: unknown) =>
    err instanceof RateLimitError &&
    err.discordCode === 30034 &&
    /daily application command creates/i.test(err.message);
  const restClient = params.client.rest as {
    put: (path: string, data?: unknown, query?: unknown) => Promise<unknown>;
    options?: { queueRequests?: boolean };
  };
  const originalPut = restClient.put.bind(restClient);
  const previousQueueRequests = restClient.options?.queueRequests;
  restClient.put = async (path: string, data?: unknown, query?: unknown) => {
    const startedAt = Date.now();
    const body =
      data && typeof data === "object" && "body" in data
        ? (data as { body?: unknown }).body
        : undefined;
    const commandCount = Array.isArray(body) ? body.length : undefined;
    const bodyBytes =
      body === undefined
        ? undefined
        : Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    if ((shouldLogVerboseForTesting ?? shouldLogVerbose)()) {
      params.runtime.log?.(
        `discord startup [${accountId}] deploy-rest:put:start ${Math.max(0, Date.now() - startupStartedAt)}ms path=${path}${typeof commandCount === "number" ? ` commands=${commandCount}` : ""}${typeof bodyBytes === "number" ? ` bytes=${bodyBytes}` : ""}`,
      );
    }
    try {
      const result = await originalPut(path, data, query);
      if ((shouldLogVerboseForTesting ?? shouldLogVerbose)()) {
        params.runtime.log?.(
          `discord startup [${accountId}] deploy-rest:put:done ${Math.max(0, Date.now() - startupStartedAt)}ms path=${path} requestMs=${Date.now() - startedAt}`,
        );
      }
      return result;
    } catch (err) {
      attachDiscordDeployRequestBody(err, body);
      const details = formatDiscordDeployErrorDetails(err);
      params.runtime.error?.(
        `discord startup [${accountId}] deploy-rest:put:error ${Math.max(0, Date.now() - startupStartedAt)}ms path=${path} requestMs=${Date.now() - startedAt} error=${formatErrorMessage(err)}${details}`,
      );
      throw err;
    }
  };
  try {
    if (restClient.options) {
      // Carbon's request queue retries 429s internally and can block startup for
      // minutes before surfacing the real error. Disable it for deploy so quota
      // errors like Discord 30034 fail fast and don't wedge the provider.
      restClient.options.queueRequests = false;
    }
    logVerbose("discord: native commands using Carbon reconcile path");
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await params.client.handleDeployRequest();
        return;
      } catch (err) {
        if (isDailyCreateLimit(err)) {
          params.runtime.log?.(
            warn(
              `discord: native command deploy skipped for ${accountId}; daily application command create limit reached. Existing slash commands stay active until Discord resets the quota.`,
            ),
          );
          return;
        }
        if (!(err instanceof RateLimitError) || attempt >= maxAttempts) {
          throw err;
        }
        const retryAfterMs = Math.max(0, Math.ceil(err.retryAfter * 1000));
        if (retryAfterMs > maxRetryDelayMs) {
          params.runtime.log?.(
            warn(
              `discord: native command deploy skipped for ${accountId}; retry_after=${retryAfterMs}ms exceeds startup budget. Existing slash commands stay active.`,
            ),
          );
          return;
        }
        if ((shouldLogVerboseForTesting ?? shouldLogVerbose)()) {
          params.runtime.log?.(
            `discord startup [${accountId}] deploy-retry ${Math.max(0, Date.now() - startupStartedAt)}ms attempt=${attempt}/${maxAttempts - 1} retryAfterMs=${retryAfterMs} scope=${err.scope ?? "unknown"} code=${err.discordCode ?? "unknown"}`,
          );
        }
        await sleep(retryAfterMs);
      }
    }
  } catch (err) {
    const details = formatDiscordDeployErrorDetails(err);
    params.runtime.error?.(
      danger(`discord: failed to deploy native commands: ${formatErrorMessage(err)}${details}`),
    );
  } finally {
    if (restClient.options) {
      restClient.options.queueRequests = previousQueueRequests;
    }
    restClient.put = originalPut;
  }
}

function formatDiscordStartupGatewayState(gateway?: GatewayPlugin): string {
  if (!gateway) {
    return "gateway=missing";
  }
  const reconnectAttempts = (gateway as unknown as { reconnectAttempts?: unknown })
    .reconnectAttempts;
  return `gatewayConnected=${gateway.isConnected ? "true" : "false"} reconnectAttempts=${typeof reconnectAttempts === "number" ? reconnectAttempts : "na"}`;
}

function logDiscordStartupPhase(params: {
  runtime: RuntimeEnv;
  accountId: string;
  phase: string;
  startAt: number;
  gateway?: GatewayPlugin;
  details?: string;
}) {
  if (!(isVerboseForTesting ?? isVerbose)()) {
    return;
  }
  const elapsedMs = Math.max(0, Date.now() - params.startAt);
  const suffix = [params.details, formatDiscordStartupGatewayState(params.gateway)]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  params.runtime.log?.(
    `discord startup [${params.accountId}] ${params.phase} ${elapsedMs}ms${suffix ? ` ${suffix}` : ""}`,
  );
}

const DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT = 3;

type DiscordDeployErrorLike = {
  status?: unknown;
  discordCode?: unknown;
  rawBody?: unknown;
  deployRequestBody?: unknown;
};

function attachDiscordDeployRequestBody(err: unknown, body: unknown) {
  if (!err || typeof err !== "object" || body === undefined) {
    return;
  }
  const deployErr = err as DiscordDeployErrorLike;
  if (deployErr.deployRequestBody === undefined) {
    deployErr.deployRequestBody = body;
  }
}

function stringifyDiscordDeployField(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return inspect(value, { depth: 2, breakLength: 120 });
  }
}

function readDiscordDeployRejectedFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").slice(0, 6);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.keys(value).slice(0, 6);
}

function resolveDiscordRejectedDeployEntriesSource(
  rawBody: unknown,
): Record<string, unknown> | null {
  if (!rawBody || typeof rawBody !== "object") {
    return null;
  }
  const payload = rawBody as { errors?: unknown };
  const errors = payload.errors && typeof payload.errors === "object" ? payload.errors : undefined;
  const source = errors ?? rawBody;
  return source && typeof source === "object" ? (source as Record<string, unknown>) : null;
}

function formatDiscordRejectedDeployEntries(params: {
  rawBody: unknown;
  requestBody: unknown;
}): string[] {
  const requestBody = Array.isArray(params.requestBody) ? params.requestBody : null;
  const rejectedEntriesSource = resolveDiscordRejectedDeployEntriesSource(params.rawBody);
  if (!rejectedEntriesSource || !requestBody || requestBody.length === 0) {
    return [];
  }
  const rawEntries = Object.entries(rejectedEntriesSource).filter(([key]) => /^\d+$/.test(key));
  return rawEntries.slice(0, DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT).flatMap(([key, value]) => {
    const index = Number.parseInt(key, 10);
    if (!Number.isFinite(index) || index < 0 || index >= requestBody.length) {
      return [];
    }
    const command = requestBody[index];
    if (!command || typeof command !== "object") {
      return [`#${index} fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`];
    }
    const payload = command as {
      name?: unknown;
      description?: unknown;
      options?: unknown;
    };
    const parts = [
      `#${index}`,
      `fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`,
    ];
    if (typeof payload.name === "string" && payload.name.trim().length > 0) {
      parts.push(`name=${payload.name}`);
    }
    if (payload.description !== undefined) {
      parts.push(`description=${stringifyDiscordDeployField(payload.description)}`);
    }
    if (Array.isArray(payload.options) && payload.options.length > 0) {
      parts.push(`options=${payload.options.length}`);
    }
    return [parts.join(" ")];
  });
}

function formatDiscordDeployErrorDetails(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const status = (err as DiscordDeployErrorLike).status;
  const discordCode = (err as DiscordDeployErrorLike).discordCode;
  const rawBody = (err as DiscordDeployErrorLike).rawBody;
  const requestBody = (err as DiscordDeployErrorLike).deployRequestBody;
  const details: string[] = [];
  if (typeof status === "number") {
    details.push(`status=${status}`);
  }
  if (typeof discordCode === "number" || typeof discordCode === "string") {
    details.push(`code=${discordCode}`);
  }
  if (rawBody !== undefined) {
    let bodyText = "";
    try {
      bodyText = JSON.stringify(rawBody);
    } catch {
      bodyText =
        typeof rawBody === "string" ? rawBody : inspect(rawBody, { depth: 3, breakLength: 120 });
    }
    if (bodyText) {
      const maxLen = 800;
      const trimmed = bodyText.length > maxLen ? `${bodyText.slice(0, maxLen)}...` : bodyText;
      details.push(`body=${trimmed}`);
    }
  }
  const rejectedEntries = formatDiscordRejectedDeployEntries({ rawBody, requestBody });
  if (rejectedEntries.length > 0) {
    details.push(`rejected=${rejectedEntries.join("; ")}`);
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

const DISCORD_DISALLOWED_INTENTS_CODE = GatewayCloseCodes.DisallowedIntents;

function isDiscordDisallowedIntentsError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const message = formatErrorMessage(err);
  return message.includes(String(DISCORD_DISALLOWED_INTENTS_CODE));
}

export async function monitorDiscordProvider(opts: MonitorDiscordOpts = {}) {
  const startupStartedAt = Date.now();
  const cfg = opts.config ?? loadConfig();
  const account = (resolveDiscordAccountForTesting ?? resolveDiscordAccount)({
    cfg,
    accountId: opts.accountId,
  });
  const token =
    normalizeDiscordToken(opts.token ?? undefined, "channels.discord.token") ?? account.token;
  if (!token) {
    throw new Error(
      `Discord bot token missing for account "${account.accountId}" (set discord.accounts.${account.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const rawDiscordCfg = account.config;
  const discordRootThreadBindings = cfg.channels?.discord?.threadBindings;
  const discordAccountThreadBindings =
    cfg.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
  const discordRestFetch = resolveDiscordRestFetch(rawDiscordCfg.proxy, runtime);
  const discordProxyFetch = resolveDiscordProxyFetchForAccount(account, cfg, runtime);
  const dmConfig = rawDiscordCfg.dm;
  let guildEntries = rawDiscordCfg.guilds;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const providerConfigPresent = cfg.channels?.discord !== undefined;
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent,
    groupPolicy: rawDiscordCfg.groupPolicy,
    defaultGroupPolicy,
  });
  const discordCfg =
    rawDiscordCfg.groupPolicy === groupPolicy ? rawDiscordCfg : { ...rawDiscordCfg, groupPolicy };
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "discord",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.guild,
    log: (message) => runtime.log?.(warn(message)),
  });
  let allowFrom = discordCfg.allowFrom ?? dmConfig?.allowFrom;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? discordCfg.mediaMaxMb ?? DEFAULT_DISCORD_MEDIA_MAX_MB) * 1024 * 1024;
  const textLimit = resolveTextChunkLimit(cfg, "discord", account.accountId, {
    fallbackLimit: 2000,
  });
  const historyLimit = Math.max(
    0,
    opts.historyLimit ?? discordCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 20,
  );
  const replyToMode = opts.replyToMode ?? discordCfg.replyToMode ?? "off";
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = discordCfg.dmPolicy ?? dmConfig?.policy ?? "pairing";
  const discordProviderSessionRuntime = await loadDiscordProviderSessionRuntime();
  const threadBindingIdleTimeoutMs =
    discordProviderSessionRuntime.resolveThreadBindingIdleTimeoutMs({
      channelIdleHoursRaw:
        discordAccountThreadBindings?.idleHours ?? discordRootThreadBindings?.idleHours,
      sessionIdleHoursRaw: cfg.session?.threadBindings?.idleHours,
    });
  const threadBindingMaxAgeMs = discordProviderSessionRuntime.resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw:
      discordAccountThreadBindings?.maxAgeHours ?? discordRootThreadBindings?.maxAgeHours,
    sessionMaxAgeHoursRaw: cfg.session?.threadBindings?.maxAgeHours,
  });
  const threadBindingsEnabled = discordProviderSessionRuntime.resolveThreadBindingsEnabled({
    channelEnabledRaw: discordAccountThreadBindings?.enabled ?? discordRootThreadBindings?.enabled,
    sessionEnabledRaw: cfg.session?.threadBindings?.enabled,
  });
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  const nativeEnabled = (resolveNativeCommandsEnabledForTesting ?? resolveNativeCommandsEnabled)({
    providerId: "discord",
    providerSetting: discordCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = (resolveNativeSkillsEnabledForTesting ?? resolveNativeSkillsEnabled)({
    providerId: "discord",
    providerSetting: discordCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: discordCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const slashCommand = resolveDiscordSlashCommandConfig(discordCfg.slashCommand);
  const sessionPrefix = "discord:slash";
  const ephemeralDefault = slashCommand.ephemeral;
  const voiceEnabled = discordCfg.voice?.enabled !== false;

  const allowlistResolved = await resolveDiscordAllowlistConfig({
    token,
    guildEntries,
    allowFrom,
    fetcher: discordRestFetch,
    runtime,
  });
  guildEntries = allowlistResolved.guildEntries;
  allowFrom = allowlistResolved.allowFrom;

  if ((shouldLogVerboseForTesting ?? shouldLogVerbose)()) {
    const allowFromSummary = summarizeStringEntries({
      entries: allowFrom ?? [],
      limit: 4,
      emptyText: "any",
    });
    const groupDmChannelSummary = summarizeStringEntries({
      entries: groupDmChannels ?? [],
      limit: 4,
      emptyText: "any",
    });
    const guildSummary = summarizeStringEntries({
      entries: Object.keys(guildEntries ?? {}),
      limit: 4,
      emptyText: "any",
    });
    logVerbose(
      `discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${allowFromSummary} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${groupDmChannelSummary} groupPolicy=${groupPolicy} guilds=${guildSummary} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))} native=${nativeEnabled ? "on" : "off"} nativeSkills=${nativeSkillsEnabled ? "on" : "off"} accessGroups=${useAccessGroups ? "on" : "off"} threadBindings=${threadBindingsEnabled ? "on" : "off"} threadIdleTimeout=${formatThreadBindingDurationForConfigLabel(threadBindingIdleTimeoutMs)} threadMaxAge=${formatThreadBindingDurationForConfigLabel(threadBindingMaxAgeMs)}`,
    );
  }

  logDiscordStartupPhase({
    runtime,
    accountId: account.accountId,
    phase: "fetch-application-id:start",
    startAt: startupStartedAt,
  });
  const applicationId = await (fetchDiscordApplicationIdForTesting ?? fetchDiscordApplicationId)(
    token,
    4000,
    discordRestFetch,
  );
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application id");
  }
  logDiscordStartupPhase({
    runtime,
    accountId: account.accountId,
    phase: "fetch-application-id:done",
    startAt: startupStartedAt,
    details: `applicationId=${applicationId}`,
  });

  const maxDiscordCommands = 100;
  let skillCommands =
    nativeEnabled && nativeSkillsEnabled
      ? (listSkillCommandsForAgentsForTesting ?? listSkillCommandsForAgents)({ cfg })
      : [];
  let commandSpecs = nativeEnabled
    ? (listNativeCommandSpecsForConfigForTesting ?? listNativeCommandSpecsForConfig)(cfg, {
        skillCommands,
        provider: "discord",
      })
    : [];
  if (nativeEnabled) {
    commandSpecs = await appendPluginCommandSpecs({ commandSpecs, runtime });
  }
  const initialCommandCount = commandSpecs.length;
  if (nativeEnabled && nativeSkillsEnabled && commandSpecs.length > maxDiscordCommands) {
    skillCommands = [];
    commandSpecs = (listNativeCommandSpecsForConfigForTesting ?? listNativeCommandSpecsForConfig)(
      cfg,
      { skillCommands: [], provider: "discord" },
    );
    commandSpecs = await appendPluginCommandSpecs({ commandSpecs, runtime });
    runtime.log?.(
      warn(
        `discord: ${initialCommandCount} commands exceeds limit; removing per-skill commands and keeping /skill.`,
      ),
    );
  }
  if (nativeEnabled && commandSpecs.length > maxDiscordCommands) {
    runtime.log?.(
      warn(
        `discord: ${commandSpecs.length} commands exceeds limit; some commands may fail to deploy.`,
      ),
    );
  }
  const voiceManagerRef: { current: DiscordVoiceManager | null } = { current: null };
  const threadBindings = threadBindingsEnabled
    ? discordProviderSessionRuntime.createThreadBindingManager({
        accountId: account.accountId,
        token,
        cfg,
        idleTimeoutMs: threadBindingIdleTimeoutMs,
        maxAgeMs: threadBindingMaxAgeMs,
      })
    : discordProviderSessionRuntime.createNoopThreadBindingManager(account.accountId);
  if (threadBindingsEnabled) {
    const uncertainProbeKeys = new Set<string>();
    const reconciliation = await discordProviderSessionRuntime.reconcileAcpThreadBindingsOnStartup({
      cfg,
      accountId: account.accountId,
      sendFarewell: false,
      healthProbe: async ({ sessionKey, session }) => {
        const probe = await probeDiscordAcpBindingHealth({
          cfg,
          sessionKey,
          storedState: session.acp?.state,
          lastActivityAt: session.acp?.lastActivityAt,
        });
        if (probe.status === "uncertain") {
          uncertainProbeKeys.add(`${sessionKey}${probe.reason ? ` (${probe.reason})` : ""}`);
        }
        return probe;
      },
    });
    if (reconciliation.removed > 0) {
      logVerbose(
        `discord: removed ${reconciliation.removed}/${reconciliation.checked} stale ACP thread bindings on startup for account ${account.accountId}: ${reconciliation.staleSessionKeys.join(", ")}`,
      );
    }
    if (uncertainProbeKeys.size > 0) {
      logVerbose(
        `discord: ACP thread-binding health probe uncertain for account ${account.accountId}: ${[...uncertainProbeKeys].join(", ")}`,
      );
    }
  }
  let lifecycleStarted = false;
  let gatewaySupervisor: ReturnType<typeof createDiscordGatewaySupervisor> | undefined;
  let deactivateMessageHandler: (() => void) | undefined;
  let autoPresenceController: Awaited<
    ReturnType<typeof createDiscordMonitorClient>
  >["autoPresenceController"] = null;
  let lifecycleGateway: MutableDiscordGateway | undefined;
  let earlyGatewayEmitter = gatewaySupervisor?.emitter;
  let onEarlyGatewayDebug: ((msg: unknown) => void) | undefined;
  try {
    const commands: BaseCommand[] = commandSpecs.map((spec) =>
      (createDiscordNativeCommandForTesting ?? createDiscordNativeCommand)({
        command: spec,
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        ephemeralDefault,
        threadBindings,
      }),
    );
    if (nativeEnabled && voiceEnabled) {
      commands.push(
        createDiscordVoiceCommand({
          cfg,
          discordConfig: discordCfg,
          accountId: account.accountId,
          groupPolicy,
          useAccessGroups,
          getManager: () => voiceManagerRef.current,
          ephemeralDefault,
        }),
      );
    }

    // Initialize exec approvals handler if enabled
    const execApprovalsConfig = discordCfg.execApprovals ?? {};
    const execApprovalsEnabled = isDiscordExecApprovalClientEnabled({
      cfg,
      accountId: account.accountId,
      configOverride: execApprovalsConfig,
    });
    if (execApprovalsEnabled) {
      registerChannelRuntimeContext({
        channelRuntime: opts.channelRuntime,
        channelId: "discord",
        accountId: account.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: {
          token,
          config: execApprovalsConfig,
        },
        abortSignal: opts.abortSignal,
      });
    }

    const agentComponentsConfig = discordCfg.agentComponents ?? {};
    const agentComponentsEnabled = agentComponentsConfig.enabled ?? true;

    const components: BaseMessageInteractiveComponent[] = [
      createDiscordCommandArgFallbackButton({
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        threadBindings,
      }),
      createDiscordModelPickerFallbackButton({
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        threadBindings,
      }),
      createDiscordModelPickerFallbackSelect({
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        threadBindings,
      }),
    ];
    const modals: Modal[] = [];

    if (execApprovalsEnabled) {
      components.push(
        createExecApprovalButton(
          createDiscordExecApprovalButtonContext({
            cfg,
            accountId: account.accountId,
            config: execApprovalsConfig,
          }),
        ),
      );
    }

    if (agentComponentsEnabled) {
      const componentContext = {
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        guildEntries,
        allowFrom,
        dmPolicy,
        runtime,
        token,
      };
      components.push(createAgentComponentButton(componentContext));
      components.push(createAgentSelectMenu(componentContext));
      components.push(createDiscordComponentButton(componentContext));
      components.push(createDiscordComponentStringSelect(componentContext));
      components.push(createDiscordComponentUserSelect(componentContext));
      components.push(createDiscordComponentRoleSelect(componentContext));
      components.push(createDiscordComponentMentionableSelect(componentContext));
      components.push(createDiscordComponentChannelSelect(componentContext));
      modals.push(createDiscordComponentModal(componentContext));
    }

    const {
      client,
      gateway,
      gatewaySupervisor: createdGatewaySupervisor,
      autoPresenceController: createdAutoPresenceController,
      eventQueueOpts,
    } = await createDiscordMonitorClient({
      accountId: account.accountId,
      applicationId,
      token,
      proxyFetch: discordProxyFetch,
      commands,
      components,
      modals,
      voiceEnabled,
      discordConfig: discordCfg,
      runtime,
      createClient: createClientForTesting ?? ((...args) => new Client(...args)),
      createGatewayPlugin: createDiscordGatewayPluginForTesting ?? createDiscordGatewayPlugin,
      createGatewaySupervisor:
        createDiscordGatewaySupervisorForTesting ?? createDiscordGatewaySupervisor,
      createAutoPresenceController: createDiscordAutoPresenceController,
      isDisallowedIntentsError: isDiscordDisallowedIntentsError,
    });
    lifecycleGateway = gateway;
    gatewaySupervisor = createdGatewaySupervisor;
    autoPresenceController = createdAutoPresenceController;

    earlyGatewayEmitter = gatewaySupervisor.emitter;
    onEarlyGatewayDebug = (msg: unknown) => {
      if (!(isVerboseForTesting ?? isVerbose)()) {
        return;
      }
      runtime.log?.(
        `discord startup [${account.accountId}] gateway-debug ${Math.max(0, Date.now() - startupStartedAt)}ms ${String(msg)}`,
      );
    };
    earlyGatewayEmitter?.on("debug", onEarlyGatewayDebug);

    logDiscordStartupPhase({
      runtime,
      accountId: account.accountId,
      phase: "deploy-commands:start",
      startAt: startupStartedAt,
      gateway: lifecycleGateway,
      details: `native=${nativeEnabled ? "on" : "off"} reconcile=on commandCount=${commands.length}`,
    });
    await deployDiscordCommands({
      client,
      runtime,
      enabled: nativeEnabled,
      accountId: account.accountId,
      startupStartedAt,
    });
    logDiscordStartupPhase({
      runtime,
      accountId: account.accountId,
      phase: "deploy-commands:done",
      startAt: startupStartedAt,
      gateway: lifecycleGateway,
    });

    const logger = createSubsystemLogger("discord/monitor");
    const guildHistories = new Map<
      string,
      import("openclaw/plugin-sdk/reply-history").HistoryEntry[]
    >();
    let { botUserId, botUserName } = await fetchDiscordBotIdentity({
      client,
      runtime,
      logStartupPhase: (phase, details) =>
        logDiscordStartupPhase({
          runtime,
          accountId: account.accountId,
          phase,
          startAt: startupStartedAt,
          gateway: lifecycleGateway,
          details,
        }),
    });
    let voiceManager: DiscordVoiceManager | null = null;

    if (nativeDisabledExplicit) {
      logDiscordStartupPhase({
        runtime,
        accountId: account.accountId,
        phase: "clear-native-commands:start",
        startAt: startupStartedAt,
        gateway: lifecycleGateway,
      });
      await clearDiscordNativeCommands({
        client,
        applicationId,
        runtime,
      });
      logDiscordStartupPhase({
        runtime,
        accountId: account.accountId,
        phase: "clear-native-commands:done",
        startAt: startupStartedAt,
        gateway: lifecycleGateway,
      });
    }

    if (voiceEnabled) {
      const { DiscordVoiceManager, DiscordVoiceReadyListener } = await loadDiscordVoiceRuntime();
      voiceManager = new DiscordVoiceManager({
        client,
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        runtime,
        botUserId,
      });
      voiceManagerRef.current = voiceManager;
      registerDiscordListener(client.listeners, new DiscordVoiceReadyListener(voiceManager));
    }

    const messageHandler = discordProviderSessionRuntime.createDiscordMessageHandler({
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      token,
      runtime,
      setStatus: opts.setStatus,
      abortSignal: opts.abortSignal,
      workerRunTimeoutMs: discordCfg.inboundWorker?.runTimeoutMs,
      botUserId,
      guildHistories,
      historyLimit,
      mediaMaxBytes,
      textLimit,
      replyToMode,
      dmEnabled,
      groupDmEnabled,
      groupDmChannels,
      allowFrom,
      guildEntries,
      threadBindings,
      discordRestFetch,
    });
    deactivateMessageHandler = messageHandler.deactivate;
    const trackInboundEvent = opts.setStatus
      ? () => {
          const at = Date.now();
          // Carbon handles gateway heartbeats internally but does not expose a
          // stable heartbeat-ack event, so Discord app events stay app-level only.
          opts.setStatus?.({ lastEventAt: at, lastInboundAt: at });
        }
      : undefined;
    registerDiscordMonitorListeners({
      cfg,
      client,
      accountId: account.accountId,
      discordConfig: discordCfg,
      runtime,
      botUserId,
      dmEnabled,
      groupDmEnabled,
      groupDmChannels,
      dmPolicy,
      allowFrom,
      groupPolicy,
      guildEntries,
      logger,
      messageHandler,
      trackInboundEvent,
      eventQueueListenerTimeoutMs: eventQueueOpts.listenerTimeout,
    });

    logDiscordStartupPhase({
      runtime,
      accountId: account.accountId,
      phase: "client-start",
      startAt: startupStartedAt,
      gateway: lifecycleGateway,
    });

    const botIdentity =
      botUserId && botUserName ? `${botUserId} (${botUserName})` : (botUserId ?? botUserName ?? "");
    runtime.log?.(
      formatDiscordStartupStatusMessage({
        gatewayReady: lifecycleGateway?.isConnected === true,
        botIdentity: botIdentity || undefined,
      }),
    );
    if (lifecycleGateway?.isConnected) {
      opts.setStatus?.(createConnectedChannelStatusPatch());
    }

    lifecycleStarted = true;
    earlyGatewayEmitter?.removeListener("debug", onEarlyGatewayDebug);
    onEarlyGatewayDebug = undefined;
    await (runDiscordGatewayLifecycleForTesting ?? runDiscordGatewayLifecycle)({
      accountId: account.accountId,
      gateway: lifecycleGateway,
      runtime,
      abortSignal: opts.abortSignal,
      statusSink: opts.setStatus,
      isDisallowedIntentsError: isDiscordDisallowedIntentsError,
      voiceManager,
      voiceManagerRef,
      threadBindings,
      gatewaySupervisor,
    });
  } finally {
    deactivateMessageHandler?.();
    autoPresenceController?.stop();
    opts.setStatus?.({ connected: false });
    if (onEarlyGatewayDebug) {
      earlyGatewayEmitter?.removeListener("debug", onEarlyGatewayDebug);
    }
    if (!lifecycleStarted) {
      try {
        lifecycleGateway?.disconnect();
      } catch (err) {
        runtime.error?.(
          danger(`discord: failed to disconnect gateway during startup cleanup: ${String(err)}`),
        );
      }
    }
    gatewaySupervisor?.dispose();
    if (!lifecycleStarted) {
      threadBindings.stop();
    }
  }
}

async function clearDiscordNativeCommands(params: {
  client: Client;
  applicationId: string;
  runtime: RuntimeEnv;
}) {
  try {
    await params.client.rest.put(Routes.applicationCommands(params.applicationId), {
      body: [],
    });
    logVerbose("discord: cleared native commands (commands.native=false)");
  } catch (err) {
    params.runtime.error?.(danger(`discord: failed to clear native commands: ${String(err)}`));
  }
}

export const __testing = {
  createDiscordGatewayPlugin,
  resolveDiscordRuntimeGroupPolicy: resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDiscordRestFetch,
  resolveThreadBindingsEnabled: resolveThreadBindingsEnabledForTesting,
  formatDiscordDeployErrorDetails,
  setFetchDiscordApplicationId(mock?: typeof fetchDiscordApplicationId) {
    fetchDiscordApplicationIdForTesting = mock;
  },
  setCreateDiscordNativeCommand(mock?: typeof createDiscordNativeCommand) {
    createDiscordNativeCommandForTesting = mock;
  },
  setRunDiscordGatewayLifecycle(mock?: typeof runDiscordGatewayLifecycle) {
    runDiscordGatewayLifecycleForTesting = mock;
  },
  setCreateDiscordGatewayPlugin(mock?: typeof createDiscordGatewayPlugin) {
    createDiscordGatewayPluginForTesting = mock;
  },
  setCreateDiscordGatewaySupervisor(mock?: typeof createDiscordGatewaySupervisor) {
    createDiscordGatewaySupervisorForTesting = mock;
  },
  setLoadDiscordVoiceRuntime(mock?: () => Promise<DiscordVoiceRuntimeModule>) {
    loadDiscordVoiceRuntimeForTesting = mock;
  },
  setLoadDiscordProviderSessionRuntime(mock?: () => Promise<DiscordProviderSessionRuntimeModule>) {
    loadDiscordProviderSessionRuntimeForTesting = mock;
  },
  setCreateClient(
    mock?: (
      options: ConstructorParameters<typeof Client>[0],
      handlers: ConstructorParameters<typeof Client>[1],
      plugins: ConstructorParameters<typeof Client>[2],
    ) => Client,
  ) {
    createClientForTesting = mock;
  },
  setGetPluginCommandSpecs(mock?: GetPluginCommandSpecs) {
    getPluginCommandSpecsForTesting = mock;
  },
  setResolveDiscordAccount(mock?: typeof resolveDiscordAccount) {
    resolveDiscordAccountForTesting = mock;
  },
  setResolveNativeCommandsEnabled(mock?: typeof resolveNativeCommandsEnabled) {
    resolveNativeCommandsEnabledForTesting = mock;
  },
  setResolveNativeSkillsEnabled(mock?: typeof resolveNativeSkillsEnabled) {
    resolveNativeSkillsEnabledForTesting = mock;
  },
  setListNativeCommandSpecsForConfig(mock?: typeof listNativeCommandSpecsForConfig) {
    listNativeCommandSpecsForConfigForTesting = mock;
  },
  setListSkillCommandsForAgents(mock?: typeof listSkillCommandsForAgents) {
    listSkillCommandsForAgentsForTesting = mock;
  },
  setIsVerbose(mock?: typeof isVerbose) {
    isVerboseForTesting = mock;
  },
  setShouldLogVerbose(mock?: typeof shouldLogVerbose) {
    shouldLogVerboseForTesting = mock;
  },
};

export const resolveDiscordRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
