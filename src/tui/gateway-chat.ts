// Bridges TUI chat requests to gateway session APIs.
import { randomUUID } from "node:crypto";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import {
  type HelloOk,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type CommandEntry,
  type CommandsListParams,
  type CommandsListResult,
  type SessionsListParams,
  type SessionsPatchResult,
  type SessionsPatchParams,
  type TaskSuggestionsAcceptResult,
  type TaskSuggestionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { resolveGatewayInteractiveSurfaceAuth } from "../gateway/auth-surface-resolution.js";
import {
  buildGatewayConnectionDetails,
  ensureExplicitGatewayAuth,
  resolveExplicitGatewayAuth,
} from "../gateway/call.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import { GatewayClient, GatewayClientRequestError } from "../gateway/client.js";
import { loadOriginDeviceToken } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readActiveGatewayLockPort } from "../infra/gateway-lock.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { sleep } from "../utils/sleep.js";
import { VERSION } from "../version.js";
import { TUI_SETUP_AUTH_SOURCE_CONFIG, TUI_SETUP_AUTH_SOURCE_ENV } from "./setup-launch-env.js";
import type {
  ChatSendOptions,
  TuiAgentsList,
  TuiBackend,
  TuiEvent,
  TuiModelChoice,
  TuiApprovalDecision,
  TuiSessionList,
  TuiSessionCreateOptions,
  TuiSessionMutationResult,
  TuiChatSendResult,
} from "./tui-backend.js";

type GatewayConnectionOptions = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

type GatewayEvent = TuiEvent;

const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5_000;

type ResolvedGatewayConnection = {
  url: string;
  deviceAuthScope?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
};

function throwGatewayAuthResolutionError(reason: string): never {
  throw new Error(
    [
      reason,
      "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass --token/--password,",
      "or resolve the configured secret provider for this credential.",
    ].join("\n"),
  );
}

function isRetryableStartupUnavailable(
  err: unknown,
  method: string,
): err is GatewayClientRequestError {
  if (!(err instanceof GatewayClientRequestError)) {
    return false;
  }
  if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
    return false;
  }
  const details = err.details;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = (details as { method?: unknown }).method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

function resolveStartupRetryDelayMs(err: GatewayClientRequestError): number {
  const retryAfterMs =
    typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasStoredOriginDeviceAuth(deviceAuthScope: string): boolean {
  try {
    const identity = loadDeviceIdentityIfPresent();
    return Boolean(
      identity &&
      loadOriginDeviceToken({
        gatewayScope: deviceAuthScope,
        deviceId: identity.deviceId,
        role: "operator",
      })?.token,
    );
  } catch {
    return false;
  }
}

function ensureTuiOriginAuth(params: {
  deviceAuthScope: string;
  explicitAuth: { token?: string; password?: string };
  urlOverrideSource: "cli" | "env";
}): void {
  if (
    params.explicitAuth.token ||
    params.explicitAuth.password ||
    hasStoredOriginDeviceAuth(params.deviceAuthScope)
  ) {
    return;
  }
  ensureExplicitGatewayAuth({
    urlOverride: params.deviceAuthScope,
    urlOverrideSource: params.urlOverrideSource,
    explicitAuth: params.explicitAuth,
    errorHint:
      "Fix: pass --token or --password once to request pairing, approve it in that gateway's Control UI (Settings -> Devices), then retry with the same credential so OpenClaw can store the device token.",
  });
}

function isLegacyPreserveSideRunsError(err: unknown): boolean {
  if (!(err instanceof GatewayClientRequestError) || err.gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const message = err.message.toLowerCase();
  return message.includes("invalid chat.abort params") && message.includes("preservesideruns");
}

function isLegacySucceedsParentError(err: unknown): boolean {
  if (!(err instanceof GatewayClientRequestError) || err.gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const message = err.message.toLowerCase();
  return message.includes("invalid sessions.create params") && message.includes("succeedsparent");
}

type GatewaySessionList = TuiSessionList;
type GatewayAgentsList = TuiAgentsList;
type GatewayModelChoice = TuiModelChoice;

export class GatewayChatClient implements TuiBackend {
  private client: GatewayClient;
  private readyPromise: Promise<void>;
  private resolveReady?: () => void;
  private pendingConnectError?: Error;
  readonly connection: ResolvedGatewayConnection;
  hello?: HelloOk;

  onEvent?: (evt: GatewayEvent) => void;
  onConnected?: () => void;
  onConnectError?: (error: Error) => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  constructor(connection: ResolvedGatewayConnection) {
    this.connection = connection;

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.client = new GatewayClient({
      url: connection.url,
      ...(connection.deviceAuthScope ? { deviceAuthScope: connection.deviceAuthScope } : {}),
      token: connection.token,
      password: connection.password,
      tlsFingerprint: connection.tlsFingerprint,
      preauthHandshakeTimeoutMs: connection.preauthHandshakeTimeoutMs,
      clientName: GATEWAY_CLIENT_NAMES.TUI,
      clientDisplayName: "openclaw-tui",
      clientVersion: VERSION,
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.UI,
      scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
      caps: [
        GATEWAY_CLIENT_CAPS.AGENT_KIND,
        GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS,
        GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
        GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
      ],
      instanceId: randomUUID(),
      minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onHelloOk: (hello) => {
        this.pendingConnectError = undefined;
        this.hello = hello;
        this.resolveReady?.();
        this.onConnected?.();
      },
      onEvent: (evt) => {
        this.onEvent?.({
          event: evt.event,
          payload: evt.payload,
          seq: evt.seq,
        });
      },
      onClose: (_code, reason) => {
        // Reset so waitForReady() blocks again until the next successful reconnect.
        this.readyPromise = new Promise((resolve) => {
          this.resolveReady = resolve;
        });
        if (this.pendingConnectError && this.onConnectError) {
          return;
        }
        this.onDisconnected?.(reason);
      },
      onConnectError: (error) => this.notifyConnectError(error),
      onGap: (info) => {
        this.onGap?.(info);
      },
    });
  }

  static async connect(opts: GatewayConnectionOptions): Promise<GatewayChatClient> {
    const connection = await resolveGatewayConnection(opts);
    return new GatewayChatClient(connection);
  }

  /** Connect to a target already selected and authenticated by a preceding Gateway probe. */
  static connectBound(
    opts: GatewayConnectionOptions & { config: OpenClawConfig; url: string },
  ): GatewayChatClient {
    return new GatewayChatClient(resolveBoundGatewayConnection(opts));
  }

  start() {
    void startGatewayClientWhenEventLoopReady(this.client, {
      clientOptions: { preauthHandshakeTimeoutMs: this.connection.preauthHandshakeTimeoutMs },
    })
      .then((readiness) => {
        if (!readiness.ready && !readiness.aborted) {
          this.notifyUnclosedConnectError(new Error("gateway event loop readiness timeout"));
        }
      })
      .catch((err: unknown) => {
        this.notifyUnclosedConnectError(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private notifyConnectError(error: Error) {
    if (this.pendingConnectError) {
      return;
    }
    if (
      this.connection.deviceAuthScope &&
      readConnectErrorDetailCode((error as Error & { details?: unknown }).details) ===
        ConnectErrorDetailCodes.PAIRING_REQUIRED &&
      !error.message.includes("Pairing request sent.")
    ) {
      error.message = [
        error.message,
        "Pairing request sent. Approve it in that gateway's Control UI (Settings -> Devices), or run `openclaw devices approve --latest` on the gateway host, then retry.",
      ].join("\n");
    }
    this.pendingConnectError = error;
    this.onConnectError?.(error);
  }

  private notifyUnclosedConnectError(error: Error) {
    const hasStructuredHandler = Boolean(this.onConnectError);
    this.notifyConnectError(error);
    if (!hasStructuredHandler) {
      this.onDisconnected?.(error.message);
    }
  }

  stop() {
    // Keep TUI teardown ordered after the transport closes. Otherwise the
    // late close callback can re-arm UI timers after shutdown cleared them.
    return this.client.stopAndWait();
  }

  async subscribeSessionEvents() {
    return await this.client.request("sessions.subscribe", {});
  }

  async waitForReady() {
    await this.readyPromise;
  }

  async sendChat(opts: ChatSendOptions): Promise<TuiChatSendResult> {
    const runId = opts.runId ?? randomUUID();
    const response = await this.client.request<{ runId?: unknown; status?: unknown }>("chat.send", {
      sessionKey: opts.sessionKey,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      message: opts.message,
      thinking: opts.thinking,
      deliver: opts.deliver,
      timeoutMs: opts.timeoutMs,
      idempotencyKey: runId,
    });
    const acceptedRunId = nonEmptyString(response?.runId) ?? runId;
    const status = nonEmptyString(response?.status);
    return status ? { runId: acceptedRunId, status } : { runId: acceptedRunId };
  }

  async abortChat(opts: { sessionKey: string; agentId?: string; runId?: string }) {
    const params = {
      sessionKey: opts.sessionKey,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
    };
    if (opts.runId) {
      return await this.client.request<{ ok: boolean; aborted: boolean; runIds?: string[] }>(
        "chat.abort",
        params,
      );
    }
    try {
      return await this.client.request<{ ok: boolean; aborted: boolean; runIds?: string[] }>(
        "chat.abort",
        { ...params, preserveSideRuns: true },
      );
    } catch (err) {
      // Protocol v4 peers reject unknown fields. Retry the shipped abort shape
      // so mixed-version TUI stops still work, even without BTW isolation.
      if (!isLegacyPreserveSideRunsError(err)) {
        throw err;
      }
      return await this.client.request<{ ok: boolean; aborted: boolean; runIds?: string[] }>(
        "chat.abort",
        params,
      );
    }
  }

  async loadHistory(opts: { sessionKey: string; agentId?: string; limit?: number }) {
    const startedAt = Date.now();
    for (;;) {
      try {
        return await this.client.request("chat.history", {
          sessionKey: opts.sessionKey,
          ...(opts.agentId ? { agentId: opts.agentId } : {}),
          limit: opts.limit,
        });
      } catch (err) {
        const withinStartupRetryWindow =
          Date.now() - startedAt < STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS;
        if (withinStartupRetryWindow && isRetryableStartupUnavailable(err, "chat.history")) {
          await sleep(resolveStartupRetryDelayMs(err));
          continue;
        }
        throw err;
      }
    }
  }

  async listSessions(opts?: SessionsListParams) {
    return await this.client.request<GatewaySessionList>("sessions.list", opts ?? {});
  }

  async listAgents() {
    return await this.client.request<GatewayAgentsList>("agents.list", {});
  }

  async patchSession(opts: SessionsPatchParams): Promise<SessionsPatchResult> {
    return await this.client.request<SessionsPatchResult>("sessions.patch", opts);
  }

  async createSession(opts: TuiSessionCreateOptions): Promise<TuiSessionMutationResult> {
    const params = {
      ...opts,
      emitCommandHooks: Boolean(opts.parentSessionKey),
    };
    try {
      return await this.client.request<TuiSessionMutationResult>("sessions.create", params);
    } catch (err) {
      if (opts.succeedsParent === undefined || !isLegacySucceedsParentError(err)) {
        throw err;
      }
      const { succeedsParent: _succeedsParent, ...legacyParams } = params;
      if (!opts.succeedsParent) {
        // Older Gateways cannot express a linked parallel child. Preserve the
        // parent's lifecycle by retrying as an unlinked child, never a rollover.
        const {
          parentSessionKey: _parentSessionKey,
          emitCommandHooks: _emitCommandHooks,
          ...parallelParams
        } = legacyParams;
        return await this.client.request<TuiSessionMutationResult>(
          "sessions.create",
          parallelParams,
        );
      }
      // Legacy rollover is equivalent to an explicit successor request.
      return await this.client.request<TuiSessionMutationResult>("sessions.create", legacyParams);
    }
  }

  async resetSession(
    key: string,
    reason?: "new" | "reset",
    opts?: { agentId?: string },
  ): Promise<TuiSessionMutationResult> {
    return await this.client.request<TuiSessionMutationResult>("sessions.reset", {
      key,
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  async getGatewayStatus() {
    return await this.client.request("status");
  }

  async listModels(): Promise<GatewayModelChoice[]> {
    const res = await this.client.request("models.list");
    return Array.isArray(res?.models) ? res.models : [];
  }

  async listCommands(opts?: CommandsListParams): Promise<CommandEntry[]> {
    const res = await this.client.request<CommandsListResult>("commands.list", opts ?? {});
    return Array.isArray(res?.commands) ? res.commands : [];
  }

  async listPluginApprovals() {
    return await this.client.request("plugin.approval.list", {});
  }

  async resolvePluginApproval(id: string, decision: TuiApprovalDecision) {
    return await this.client.request<{ ok?: boolean }>("plugin.approval.resolve", {
      id,
      decision,
    });
  }

  getTaskSuggestionActionCapabilities() {
    const auth = this.hello?.auth;
    const methods = this.hello?.features?.methods;
    const allows = (method: string, scope: "operator.admin" | "operator.write") =>
      Array.isArray(methods) &&
      methods.includes(method) &&
      Boolean(
        auth &&
        roleScopesAllow({
          role: auth.role,
          requestedScopes: [scope],
          allowedScopes: auth.scopes,
        }),
      );
    return {
      canAccept: allows("taskSuggestions.accept", "operator.admin"),
      canDismiss: allows("taskSuggestions.dismiss", "operator.write"),
    };
  }

  async listTaskSuggestions() {
    if (this.hello?.features?.methods?.includes("taskSuggestions.list") !== true) {
      return [];
    }
    const actions = this.getTaskSuggestionActionCapabilities();
    if (!actions.canAccept && !actions.canDismiss) {
      return [];
    }
    const result = await this.client.request<TaskSuggestionsListResult>("taskSuggestions.list", {});
    return result.suggestions;
  }

  async acceptTaskSuggestion(taskId: string) {
    return await this.client.request<TaskSuggestionsAcceptResult>("taskSuggestions.accept", {
      taskId,
    });
  }

  async dismissTaskSuggestion(taskId: string) {
    return await this.client.request<{ taskId: string; dismissed: boolean }>(
      "taskSuggestions.dismiss",
      { taskId },
    );
  }
}

/**
 * Preserve a pre-probed Gateway route across an in-process handoff. This path
 * deliberately ignores global config and Gateway env overrides, including
 * credentials, while still applying the normal remote URL safety policy.
 */
function resolveBoundGatewayConnection(
  opts: GatewayConnectionOptions & { config: OpenClawConfig; url: string },
): ResolvedGatewayConnection {
  const url = buildGatewayConnectionDetails({
    config: opts.config,
    url: opts.url,
    ignoreEnvUrlOverride: true,
  }).url;
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  return {
    url,
    deviceAuthScope: gatewayOriginScope(url),
    token: explicitAuth.token,
    password: explicitAuth.password,
    ...(opts.tlsFingerprint ? { tlsFingerprint: opts.tlsFingerprint } : {}),
  };
}

async function resolveGatewayConnection(
  opts: GatewayConnectionOptions,
): Promise<ResolvedGatewayConnection> {
  const config = getRuntimeConfig();
  const env = process.env;
  const gatewayAuthMode = config.gateway?.auth?.mode;
  const isRemoteMode = config.gateway?.mode === "remote";
  const preferConfiguredAuth = env[TUI_SETUP_AUTH_SOURCE_ENV] === TUI_SETUP_AUTH_SOURCE_CONFIG;

  const urlOverride =
    typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : undefined;
  const envUrlOverride = urlOverride ? undefined : nonEmptyString(env.OPENCLAW_GATEWAY_URL);
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  const hasExplicitGatewayTarget = Boolean(
    urlOverride || envUrlOverride || env.OPENCLAW_GATEWAY_PORT?.trim() || isRemoteMode,
  );
  const activeLocalGatewayPort = hasExplicitGatewayTarget
    ? undefined
    : await readActiveGatewayLockPort();
  const url = buildGatewayConnectionDetails({
    config,
    ...(urlOverride ? { url: urlOverride } : {}),
    ...(activeLocalGatewayPort ? { localPortOverride: activeLocalGatewayPort } : {}),
  }).url;

  if (urlOverride) {
    const deviceAuthScope = gatewayOriginScope(url);
    ensureTuiOriginAuth({ deviceAuthScope, explicitAuth, urlOverrideSource: "cli" });
    return {
      url,
      deviceAuthScope,
      token: explicitAuth.token,
      password: explicitAuth.password,
      ...(opts.tlsFingerprint ? { tlsFingerprint: opts.tlsFingerprint } : {}),
    };
  }

  if (envUrlOverride) {
    const deviceAuthScope = gatewayOriginScope(url);
    const envAuth = {
      token: explicitAuth.token ?? nonEmptyString(env.OPENCLAW_GATEWAY_TOKEN),
      password: explicitAuth.password ?? nonEmptyString(env.OPENCLAW_GATEWAY_PASSWORD),
    };
    ensureTuiOriginAuth({ deviceAuthScope, explicitAuth: envAuth, urlOverrideSource: "env" });
    return {
      url,
      deviceAuthScope,
      token: envAuth.token,
      password: envAuth.password,
      ...(opts.tlsFingerprint ? { tlsFingerprint: opts.tlsFingerprint } : {}),
    };
  }

  if (isRemoteMode) {
    const deviceAuthScope = gatewayOriginScope(url);
    const resolved = await resolveGatewayInteractiveSurfaceAuth({
      config,
      env,
      explicitAuth,
      suppressEnvAuthFallback: preferConfiguredAuth,
      surface: "remote",
    });
    if (
      resolved.failureReason &&
      (resolved.failureReason !== "Missing gateway auth credentials." ||
        !hasStoredOriginDeviceAuth(deviceAuthScope))
    ) {
      throwGatewayAuthResolutionError(resolved.failureReason);
    }
    return {
      url,
      deviceAuthScope,
      token: resolved.token,
      password: resolved.password,
      ...((opts.tlsFingerprint ?? config.gateway?.remote?.tlsFingerprint)
        ? { tlsFingerprint: opts.tlsFingerprint ?? config.gateway?.remote?.tlsFingerprint }
        : {}),
    };
  }

  if (gatewayAuthMode === "none" || gatewayAuthMode === "trusted-proxy") {
    const resolved = await resolveGatewayInteractiveSurfaceAuth({
      config,
      env,
      explicitAuth,
      surface: "local",
    });
    return {
      url,
      token: resolved.token,
      password: resolved.password,
      ...(opts.tlsFingerprint ? { tlsFingerprint: opts.tlsFingerprint } : {}),
    };
  }

  try {
    assertExplicitGatewayAuthModeWhenBothConfigured(config);
  } catch (err) {
    throwGatewayAuthResolutionError(formatErrorMessage(err));
  }

  const resolved = await resolveGatewayInteractiveSurfaceAuth({
    config,
    env,
    explicitAuth,
    suppressEnvAuthFallback: preferConfiguredAuth,
    surface: "local",
  });
  if (resolved.failureReason) {
    throwGatewayAuthResolutionError(resolved.failureReason);
  }
  return {
    url,
    token: resolved.token,
    password: resolved.password,
    ...(opts.tlsFingerprint ? { tlsFingerprint: opts.tlsFingerprint } : {}),
  };
}
