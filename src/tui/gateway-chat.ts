// Bridges TUI chat requests to gateway session APIs.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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
import type { ErrorShape } from "../../packages/gateway-protocol/src/frame-guards.js";
import {
  type HelloOk,
  GATEWAY_SERVER_CAPS,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type CommandEntry,
  type CommandsListParams,
  type CommandsListResult,
  type EnvironmentsListResult,
  type SessionsListParams,
  type SessionsResolveParams,
  type SessionsPatchResult,
  type SessionsPatchParams,
  type TaskSuggestionsAcceptResult,
  type TaskSuggestionsAcceptParams,
  type TaskSuggestionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { isRetryableGatewayStartupUnavailableError } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import {
  resolveGatewayClientBootstrap,
  resolveGatewayUrlOverride,
} from "../gateway/client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import { GatewayClient, GatewayClientRequestError } from "../gateway/client.js";
import { resolveExplicitGatewayAuth } from "../gateway/credentials.js";
import { loadOriginDeviceToken } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readActiveGatewayLockPort } from "../infra/gateway-lock.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { sleep } from "../utils/sleep.js";
import { VERSION } from "../version.js";
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
  TuiTaskSuggestionAcceptMode,
} from "./tui-backend.js";

type GatewayConnectionOptions = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  allowConfiguredAuthForExactTarget?: boolean;
  suppressEnvAuthFallback?: boolean;
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
type HandoffSessionResolveParams = Required<
  Pick<SessionsResolveParams, "key" | "agentId" | "includeGlobal" | "allowMissing">
>;
type HandoffSessionResolveResult =
  | { ok: true; key: string; agentId: string }
  | { ok: true; missing: true }
  | {
      ok: true;
      ambiguous: true;
      candidates: Array<{ key: string; agentId: string; displayName?: string }>;
    }
  | { ok: false; error: ErrorShape };

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
      notifyOnStartupRetry: true,
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
          // Dedupe is per close-cycle: clearing here lets the next reconnect
          // attempt report its own failure cause. Holding the guard until a
          // successful hello froze the TUI on the first error forever (e.g. a
          // later pairing-required failure and its approval hint never showed).
          this.pendingConnectError = undefined;
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
    if (isRetryableGatewayStartupUnavailableError(error)) {
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
    const acceptedRunId = normalizeOptionalString(response?.runId) ?? runId;
    const status = normalizeOptionalString(response?.status);
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

  async resolveSession(opts: HandoffSessionResolveParams): Promise<HandoffSessionResolveResult> {
    return await this.client.request<HandoffSessionResolveResult>("sessions.resolve", opts);
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

  async listModels(opts?: { agentId?: string }): Promise<GatewayModelChoice[]> {
    const res = await this.client.request("models.list", opts ?? {});
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
    const capabilities = this.hello?.features?.capabilities;
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
      canAcceptModes:
        Array.isArray(capabilities) &&
        capabilities.includes(GATEWAY_SERVER_CAPS.TASK_SUGGESTIONS_ACCEPT_MODES),
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

  async listCloudWorkerProfiles() {
    if (this.hello?.features?.methods?.includes("environments.list") !== true) {
      return [];
    }
    try {
      const result = await this.client.request<EnvironmentsListResult>("environments.list", {});
      return result.profiles?.map((profile) => profile.id) ?? [];
    } catch {
      // Cloud placement is optional; older or temporarily failing gateways stay quiet.
      return [];
    }
  }

  async acceptTaskSuggestion(
    taskId: string,
    mode?: TuiTaskSuggestionAcceptMode,
    cloudProfileId?: string,
  ) {
    const params: TaskSuggestionsAcceptParams =
      !mode || mode === "worktree"
        ? { taskId }
        : { taskId, mode, ...(cloudProfileId ? { cloudProfileId } : {}) };
    return await this.client.request<TaskSuggestionsAcceptResult>("taskSuggestions.accept", params);
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

  const urlOverride = resolveGatewayUrlOverride({ gatewayUrl: opts.url, env });
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  const hasExplicitGatewayTarget = Boolean(
    urlOverride.url || env.OPENCLAW_GATEWAY_PORT?.trim() || isRemoteMode,
  );
  const resumeMayMatchLocalTarget =
    opts.allowConfiguredAuthForExactTarget === true &&
    urlOverride.source === "cli" &&
    !isRemoteMode &&
    !env.OPENCLAW_GATEWAY_PORT?.trim();
  const activeLocalGatewayPort =
    !hasExplicitGatewayTarget || resumeMayMatchLocalTarget
      ? await readActiveGatewayLockPort()
      : undefined;
  if (
    !urlOverride.source &&
    gatewayAuthMode !== "none" &&
    gatewayAuthMode !== "trusted-proxy" &&
    !isRemoteMode
  ) {
    try {
      assertExplicitGatewayAuthModeWhenBothConfigured(config);
    } catch (err) {
      throwGatewayAuthResolutionError(formatErrorMessage(err));
    }
  }
  const bootstrap = await resolveGatewayClientBootstrap({
    config,
    gatewayUrl: urlOverride.source === "cli" ? urlOverride.url : undefined,
    explicitAuth,
    env,
    authPolicy: "interactive",
    allowConfiguredAuthForExactTarget: opts.allowConfiguredAuthForExactTarget,
    suppressEnvAuthFallback: opts.suppressEnvAuthFallback,
    ...(activeLocalGatewayPort ? { localPortOverride: activeLocalGatewayPort } : {}),
    explicitTlsFingerprint: opts.tlsFingerprint,
    allowStoredOriginAuth: hasStoredOriginDeviceAuth,
    overrideAuthErrorHint:
      "Fix: pass --token or --password once to request pairing, approve it in that gateway's Control UI (Settings -> Devices), then retry with the same credential so OpenClaw can store the device token.",
    buildConnectionDetails: buildGatewayConnectionDetails,
  });
  const hasStoredOriginAuth = Boolean(
    bootstrap.deviceAuthScope && hasStoredOriginDeviceAuth(bootstrap.deviceAuthScope),
  );
  const missingSharedAuth =
    bootstrap.authFailureReason === "Missing gateway auth credentials." ||
    bootstrap.authFailureReason === "Missing gateway auth token." ||
    bootstrap.authFailureReason === "Missing gateway auth password.";
  if (bootstrap.authFailureReason && (!missingSharedAuth || !hasStoredOriginAuth)) {
    throwGatewayAuthResolutionError(bootstrap.authFailureReason);
  }
  return {
    url: bootstrap.url,
    deviceAuthScope: bootstrap.deviceAuthScope,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    ...(bootstrap.tlsFingerprint ? { tlsFingerprint: bootstrap.tlsFingerprint } : {}),
  };
}
