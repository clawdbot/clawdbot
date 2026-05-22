import { randomUUID } from "node:crypto";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.types.js";
import { withProgress } from "../cli/progress.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  callGateway,
  isGatewayTransportError,
  randomIdempotencyKey,
  type GatewayRequestFunction,
} from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/operator-scopes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { routeLogsToStderr } from "../logging/console.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { agentCommand } from "./agent.js";
import { buildExplicitSessionIdSessionKey, resolveSessionKeyForRequest } from "./agent/session.js";

type AgentGatewayResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string | null;
    mediaUrls?: string[];
  }>;
  deliveryStatus?: unknown;
  meta?: unknown;
};

type GatewayAgentResponse = {
  runId?: string;
  status?: string;
  summary?: string;
  result?: AgentGatewayResult;
  deliveryStatus?: unknown;
};

const NO_GATEWAY_TIMEOUT_MS = 2_147_000_000;
const EMBEDDED_FALLBACK_META = {
  transport: "embedded",
  fallbackFrom: "gateway",
} as const;
const GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX = "gateway-fallback-";
const GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const;

type AgentCliOpts = {
  message: string;
  agent?: string;
  model?: string;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  thinking?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  channel?: string;
  replyTo?: string;
  replyChannel?: string;
  replyAccount?: string;
  bestEffortDeliver?: boolean;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  local?: boolean;
};

type AgentCliSignal = "SIGINT" | "SIGTERM";
type AgentCliProcessLike = {
  on(signal: AgentCliSignal, handler: () => void): unknown;
  off(signal: AgentCliSignal, handler: () => void): unknown;
};
type AgentCliDeps = CliDeps & {
  process?: AgentCliProcessLike;
};
type AgentGatewayCallIdentity = Pick<
  Parameters<typeof callGateway>[0],
  "clientName" | "mode" | "scopes"
>;

const AGENT_CLI_SIGNALS: readonly AgentCliSignal[] = ["SIGINT", "SIGTERM"];
const GATEWAY_ABORT_RETRY_DELAYS_MS = [50, 150, 300, 600] as const;
const GATEWAY_ABORT_REQUEST_TIMEOUT_MS = 2_000;
const AGENT_CLI_SIGNAL_EXIT_CODES: Record<AgentCliSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

function protectJsonStdout(opts: Pick<AgentCliOpts, "json">): void {
  if (opts.json === true) {
    routeLogsToStderr();
  }
}

function parseTimeoutSeconds(opts: { cfg: OpenClawConfig; timeout?: string }) {
  const raw =
    opts.timeout !== undefined
      ? Number.parseInt(opts.timeout, 10)
      : (opts.cfg.agents?.defaults?.timeoutSeconds ?? 600);
  if (Number.isNaN(raw) || raw < 0) {
    throw new Error(
      `Invalid --timeout. Use seconds as a non-negative integer, for example --timeout 600. Use --timeout 0 to disable the timeout.`,
    );
  }
  return raw;
}

function formatPayloadForLog(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
}) {
  const parts = resolveSendableOutboundReplyParts({
    text: payload.text,
    mediaUrls: payload.mediaUrls,
    mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : undefined,
  });
  const lines: string[] = [];
  if (parts.text) {
    lines.push(parts.text.trimEnd());
  }
  for (const url of parts.mediaUrls) {
    lines.push(`MEDIA:${url}`);
  }
  return lines.join("\n").trimEnd();
}

function isGatewayAgentTimeoutError(err: unknown): boolean {
  if (isGatewayTransportError(err)) {
    return err.kind === "timeout";
  }
  return err instanceof Error && err.message.includes("gateway request timeout for agent");
}

function isGatewayAgentEmbeddedFallbackError(err: unknown): boolean {
  return isGatewayTransportError(err);
}

function isTransientGatewayAgentConnectClose(err: unknown): boolean {
  if (!isGatewayTransportError(err) || err.kind !== "closed") {
    return false;
  }
  const code = typeof err.code === "number" ? err.code : undefined;
  const reason = normalizeOptionalString(err.reason);
  return code === 1000 && (!reason || reason === "no close reason");
}

function validateExplicitSessionKeyForDispatch(
  opts: Pick<AgentCliOpts, "agent" | "sessionKey">,
): void {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }

  if (classifySessionKeyShape(sessionKey) === "malformed_agent") {
    throw new Error(
      `Invalid --session-key "${sessionKey}". Agent-prefixed session keys must use agent:<agent-id>:<session-key>.`,
    );
  }

  const agentIdRaw = opts.agent?.trim() || undefined;
  if (!agentIdRaw || classifySessionKeyShape(sessionKey) !== "agent") {
    return;
  }
  const agentId = normalizeAgentId(agentIdRaw);
  const sessionAgentId = resolveAgentIdFromSessionKey(sessionKey);
  if (sessionAgentId !== agentId) {
    throw new Error(
      `Agent id "${agentIdRaw}" does not match session key agent "${sessionAgentId}".`,
    );
  }
}

function normalizeSessionKeyOptsForDispatch(opts: AgentCliOpts): AgentCliOpts {
  const rawSessionKey = opts.sessionKey?.trim();
  const isLegacySessionKey =
    rawSessionKey && classifySessionKeyShape(rawSessionKey) === "legacy_or_alias";
  const agentIdRaw = opts.agent?.trim();
  const shouldScopeDefaultAgentKey =
    isLegacySessionKey && !agentIdRaw && !isUnscopedSessionKeySentinel(rawSessionKey);
  const cfg =
    isLegacySessionKey && (agentIdRaw || shouldScopeDefaultAgentKey)
      ? getRuntimeConfig()
      : undefined;
  const sessionKey = scopeLegacySessionKeyToAgent({
    agentId: agentIdRaw ?? (shouldScopeDefaultAgentKey ? resolveDefaultAgentId(cfg!) : undefined),
    sessionKey: opts.sessionKey,
    mainKey: cfg?.session?.mainKey,
  });
  if (sessionKey === opts.sessionKey) {
    return opts;
  }
  return {
    ...opts,
    sessionKey,
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function readAcceptedRunContext(payload: unknown): {
  runId?: string;
  sessionKey?: string;
} {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const runId = (payload as { runId?: unknown }).runId;
  const sessionKey = (payload as { sessionKey?: unknown }).sessionKey;
  const status = (payload as { status?: unknown }).status;
  if (status !== "accepted") {
    return {};
  }
  return {
    runId: typeof runId === "string" && runId.trim() ? runId.trim() : undefined,
    sessionKey: typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : undefined,
  };
}

function createAgentCliSignalBridge(processLike: AgentCliProcessLike = process) {
  const controller = new AbortController();
  let receivedSignal: AgentCliSignal | undefined;
  const handlers = new Map<AgentCliSignal, () => void>();
  const detachHandlers = () => {
    for (const [signal, handler] of handlers) {
      processLike.off(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of AGENT_CLI_SIGNALS) {
    const handler = () => {
      receivedSignal = signal;
      if (!controller.signal.aborted) {
        // runtime.exit may bypass finally cleanup, so first-signal self-detach is load-bearing.
        controller.abort();
        detachHandlers();
      }
    };
    handlers.set(signal, handler);
    processLike.on(signal, handler);
  }
  return {
    signal: controller.signal,
    getReceivedSignal: () => receivedSignal,
    dispose: detachHandlers,
  };
}

function isAgentCliProcessLike(value: unknown): value is AgentCliProcessLike {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { on?: unknown }).on === "function" &&
    typeof (value as { off?: unknown }).off === "function"
  );
}

function resolveAgentCliProcessLike(deps: AgentCliDeps | undefined): AgentCliProcessLike {
  if (!deps || !Object.prototype.hasOwnProperty.call(deps, "process")) {
    return process;
  }
  const processLike = (deps as { process?: unknown }).process;
  return isAgentCliProcessLike(processLike) ? processLike : process;
}

function createAbortDelayError(): Error {
  const err = new Error("gateway agent retry aborted");
  err.name = "AbortError";
  return err;
}

function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortDelayError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortDelayError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isConfirmedChatAbortResponseForRun(value: unknown, runId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const response = value as { aborted?: unknown; runIds?: unknown };
  if (response.aborted !== true) {
    return false;
  }
  if (response.runIds === undefined) {
    return true;
  }
  return Array.isArray(response.runIds) && response.runIds.includes(runId);
}

async function abortAcceptedGatewayAgentRunWithRequest(params: {
  runId: string | undefined;
  sessionKey: string | undefined;
  signal: AgentCliSignal | undefined;
  runtime: RuntimeEnv;
  request: GatewayRequestFunction;
  logFailure?: boolean;
}): Promise<boolean> {
  if (!params.signal || !params.runId || !params.sessionKey) {
    return false;
  }
  try {
    const response = await params.request(
      "chat.abort",
      {
        sessionKey: params.sessionKey,
        runId: params.runId,
      },
      { timeoutMs: GATEWAY_ABORT_REQUEST_TIMEOUT_MS },
    );
    if (isConfirmedChatAbortResponseForRun(response, params.runId)) {
      return true;
    }
    if (params.logFailure !== false) {
      params.runtime.error?.(
        `Interrupted by ${params.signal}; Gateway run ${params.runId} was not confirmed aborted.`,
      );
    }
    return false;
  } catch (err) {
    if (params.logFailure !== false) {
      params.runtime.error?.(
        `Interrupted by ${params.signal}; failed to abort Gateway run ${params.runId}: ${String(
          err,
        )}`,
      );
    }
    return false;
  }
}

async function abortAcceptedGatewayAgentRunWithGatewayCall(params: {
  runId: string | undefined;
  sessionKey: string | undefined;
  signal: AgentCliSignal | undefined;
  runtime: RuntimeEnv;
  gatewayIdentity: AgentGatewayCallIdentity;
}): Promise<void> {
  const request: GatewayRequestFunction = async <T = Record<string, unknown>>(
    method: string,
    requestParams?: unknown,
    opts?: Parameters<GatewayRequestFunction>[2],
  ): Promise<T> =>
    await callGateway<T>({
      method,
      params: requestParams,
      timeoutMs: opts?.timeoutMs ?? undefined,
      expectFinal: opts?.expectFinal,
      ...params.gatewayIdentity,
    });
  for (const [attempt, retryDelayMs] of [...GATEWAY_ABORT_RETRY_DELAYS_MS, 0].entries()) {
    const isFinalAttempt = attempt === GATEWAY_ABORT_RETRY_DELAYS_MS.length;
    const aborted = await abortAcceptedGatewayAgentRunWithRequest({
      runId: params.runId,
      sessionKey: params.sessionKey,
      signal: params.signal,
      runtime: params.runtime,
      request,
      logFailure: isFinalAttempt,
    });
    if (aborted || isFinalAttempt) {
      return;
    }
    await delayMs(retryDelayMs);
  }
}

async function abortAcceptedGatewayAgentRunOnActiveConnection(params: {
  runId: string | undefined;
  sessionKey: string | undefined;
  signal: AgentCliSignal | undefined;
  runtime: RuntimeEnv;
  request: GatewayRequestFunction;
}): Promise<boolean> {
  for (const [attempt, retryDelayMs] of [...GATEWAY_ABORT_RETRY_DELAYS_MS, 0].entries()) {
    const isFinalAttempt = attempt === GATEWAY_ABORT_RETRY_DELAYS_MS.length;
    const aborted = await abortAcceptedGatewayAgentRunWithRequest({
      runId: params.runId,
      sessionKey: params.sessionKey,
      signal: params.signal,
      runtime: params.runtime,
      request: params.request,
      logFailure: false,
    });
    if (aborted || isFinalAttempt) {
      return aborted;
    }
    await delayMs(retryDelayMs);
  }
  return false;
}

function exitForReceivedSignal(signal: AgentCliSignal | undefined, runtime: RuntimeEnv): boolean {
  if (!signal) {
    return false;
  }
  runtime.exit(AGENT_CLI_SIGNAL_EXIT_CODES[signal]);
  return true;
}

function returnAfterSignalExit<T>(
  value: T,
  signal: AgentCliSignal | undefined,
  runtime: RuntimeEnv,
): T | undefined {
  return exitForReceivedSignal(signal, runtime) ? undefined : value;
}

function createGatewayTimeoutFallbackSessionId(): string {
  return `${GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX}${randomUUID()}`;
}

function createGatewayTimeoutFallbackSession(agentId?: string): {
  sessionId: string;
  sessionKey: string;
} {
  const sessionId = createGatewayTimeoutFallbackSessionId();
  return {
    sessionId,
    sessionKey: buildExplicitSessionIdSessionKey({ sessionId, agentId }),
  };
}

function resolveAgentIdForGatewayTimeoutFallback(opts: AgentCliOpts): string | undefined {
  const explicitSessionKey = opts.sessionKey?.trim();
  if (classifySessionKeyShape(explicitSessionKey) === "agent") {
    return resolveAgentIdFromSessionKey(explicitSessionKey);
  }
  if (isUnscopedSessionKeySentinel(explicitSessionKey)) {
    return resolveDefaultAgentId(getRuntimeConfig());
  }

  const agentIdRaw = opts.agent?.trim();
  if (agentIdRaw) {
    return normalizeAgentId(agentIdRaw);
  }

  if (!opts.to && !opts.sessionId) {
    return undefined;
  }
  const cfg = getRuntimeConfig();
  const resolvedSessionKey = resolveSessionKeyForRequest({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
  }).sessionKey;
  return classifySessionKeyShape(resolvedSessionKey) === "agent"
    ? resolveAgentIdFromSessionKey(resolvedSessionKey)
    : undefined;
}

function buildGatewayJsonResponse(response: GatewayAgentResponse): GatewayAgentResponse {
  const deliveryStatus = response.result?.deliveryStatus;
  if (deliveryStatus === undefined) {
    return response;
  }
  return {
    ...response,
    deliveryStatus,
  };
}

function isInFlightGatewayAgentResponse(response: GatewayAgentResponse): boolean {
  return response.status === "in_flight";
}

function formatInFlightGatewayAgentMessage(response: GatewayAgentResponse): string {
  return response.runId
    ? `Agent run ${response.runId} is already in flight; not starting a duplicate run.`
    : "Agent run is already in flight; not starting a duplicate run.";
}

async function agentViaGatewayCommand(
  opts: AgentCliOpts,
  runtime: RuntimeEnv,
  signalBridge: ReturnType<typeof createAgentCliSignalBridge>,
) {
  protectJsonStdout(opts);
  const body = (opts.message ?? "").trim();
  const explicitSessionKey = opts.sessionKey?.trim();
  if (!body) {
    throw new Error(
      `Missing message. Use ${formatCliCommand('openclaw agent --message "..." --agent <id>')} or pass --to/--session-key/--session-id for an existing conversation.`,
    );
  }
  if (!opts.to && !opts.sessionId && !opts.agent && !explicitSessionKey) {
    throw new Error(
      `No target session selected. Use --agent <id>, --session-key <key>, --session-id <id>, or --to <E.164>. Run ${formatCliCommand("openclaw agents list")} to see agents.`,
    );
  }

  const cfg = getRuntimeConfig();
  const agentIdRaw = opts.agent?.trim();
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (agentId) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentId)) {
      throw new Error(
        `Unknown agent id "${agentIdRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  const timeoutSeconds = parseTimeoutSeconds({ cfg, timeout: opts.timeout });
  const gatewayTimeoutMs =
    timeoutSeconds === 0
      ? NO_GATEWAY_TIMEOUT_MS // no timeout (timer-safe max)
      : Math.max(10_000, (timeoutSeconds + 30) * 1000);

  const sessionKey = resolveSessionKeyForRequest({
    cfg,
    agentId,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: explicitSessionKey,
  }).sessionKey;

  const channel = normalizeMessageChannel(opts.channel);
  const idempotencyKey = normalizeOptionalString(opts.runId) || randomIdempotencyKey();
  const modelOverride = normalizeOptionalString(opts.model);
  const hasModelOverride = Boolean(modelOverride);
  const gatewayIdentity: AgentGatewayCallIdentity = hasModelOverride
    ? {
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: [ADMIN_SCOPE],
      }
    : {
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      };

  let acceptedRunId: string | undefined = idempotencyKey;
  let acceptedSessionKey: string | undefined = sessionKey;
  let acceptedGatewayRun = false;
  let activeConnectionAbortAttempted = false;
  let activeConnectionAbortSucceeded = false;
  let response: GatewayAgentResponse;
  try {
    response = await withProgress(
      {
        label: "Waiting for agent reply…",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          method: "agent",
          params: {
            message: body,
            agentId,
            model: modelOverride,
            to: opts.to,
            replyTo: opts.replyTo,
            sessionId: opts.sessionId,
            sessionKey,
            thinking: opts.thinking,
            deliver: Boolean(opts.deliver),
            channel,
            replyChannel: opts.replyChannel,
            replyAccountId: opts.replyAccount,
            bestEffortDeliver: opts.bestEffortDeliver,
            timeout: timeoutSeconds,
            lane: opts.lane,
            extraSystemPrompt: opts.extraSystemPrompt,
            idempotencyKey,
          },
          expectFinal: true,
          timeoutMs: gatewayTimeoutMs,
          signal: signalBridge.signal,
          onAccepted: (payload) => {
            acceptedGatewayRun = true;
            const accepted = readAcceptedRunContext(payload);
            acceptedRunId = accepted.runId ?? acceptedRunId;
            acceptedSessionKey = accepted.sessionKey ?? acceptedSessionKey;
          },
          onSignalAbort: async (request) => {
            activeConnectionAbortAttempted = true;
            activeConnectionAbortSucceeded = await abortAcceptedGatewayAgentRunOnActiveConnection({
              runId: acceptedRunId,
              sessionKey: acceptedSessionKey,
              signal: signalBridge.getReceivedSignal(),
              runtime,
              request,
            });
          },
          ...gatewayIdentity,
        }),
    );
  } catch (err) {
    if (
      isAbortError(err) &&
      !activeConnectionAbortSucceeded &&
      (acceptedGatewayRun || activeConnectionAbortAttempted)
    ) {
      await abortAcceptedGatewayAgentRunWithGatewayCall({
        runId: acceptedRunId,
        sessionKey: acceptedSessionKey,
        signal: signalBridge.getReceivedSignal(),
        runtime,
        gatewayIdentity,
      });
    }
    throw err;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, buildGatewayJsonResponse(response));
    return response;
  }

  const result = response?.result;
  const payloads = result?.payloads ?? [];

  if (isInFlightGatewayAgentResponse(response)) {
    runtime.error?.(formatInFlightGatewayAgentMessage(response));
    return response;
  }

  if (payloads.length === 0) {
    if (response?.status !== "ok") {
      runtime.log(response?.summary ? response.summary : "No reply from agent.");
    }
    return response;
  }

  for (const payload of payloads) {
    const out = formatPayloadForLog(payload);
    if (out) {
      runtime.log(out);
    }
  }

  return response;
}

async function agentViaGatewayCommandWithTransientRetries(
  opts: AgentCliOpts,
  runtime: RuntimeEnv,
  signalBridge: ReturnType<typeof createAgentCliSignalBridge>,
) {
  for (const [attempt, retryDelayMs] of [
    ...GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS,
    0,
  ].entries()) {
    try {
      return await agentViaGatewayCommand(opts, runtime, signalBridge);
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      const isFinalAttempt = attempt === GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS.length;
      if (isFinalAttempt || !isTransientGatewayAgentConnectClose(err)) {
        throw err;
      }
      runtime.error?.(
        `Gateway agent connection closed during handshake; retrying in ${retryDelayMs}ms before embedded fallback.`,
      );
      await delayMs(retryDelayMs, signalBridge.signal);
    }
  }
  throw new Error("Gateway agent retry loop exhausted unexpectedly.");
}

export async function agentCliCommand(
  opts: AgentCliOpts,
  runtime: RuntimeEnv,
  deps?: AgentCliDeps,
) {
  protectJsonStdout(opts);
  const dispatchOpts = normalizeSessionKeyOptsForDispatch(opts);
  validateExplicitSessionKeyForDispatch(dispatchOpts);
  const gatewayDispatchOpts = dispatchOpts.runId
    ? dispatchOpts
    : { ...dispatchOpts, runId: randomIdempotencyKey() };
  const signalBridge = createAgentCliSignalBridge(resolveAgentCliProcessLike(deps));
  const localOpts = {
    ...gatewayDispatchOpts,
    agentId: gatewayDispatchOpts.agent,
    replyAccountId: gatewayDispatchOpts.replyAccount,
    cleanupBundleMcpOnRunEnd: true,
    cleanupCliLiveSessionOnRunEnd: true,
    abortSignal: signalBridge.signal,
  };
  try {
    if (dispatchOpts.local === true) {
      const result = await agentCommand(localOpts, runtime, deps);
      return returnAfterSignalExit(result, signalBridge.getReceivedSignal(), runtime);
    }

    try {
      const result = await agentViaGatewayCommandWithTransientRetries(
        gatewayDispatchOpts,
        runtime,
        signalBridge,
      );
      return returnAfterSignalExit(result, signalBridge.getReceivedSignal(), runtime);
    } catch (err) {
      if (isAbortError(err)) {
        if (exitForReceivedSignal(signalBridge.getReceivedSignal(), runtime)) {
          return undefined;
        }
        throw err;
      }
      if (isGatewayAgentTimeoutError(err)) {
        const fallbackAgentId = resolveAgentIdForGatewayTimeoutFallback(dispatchOpts);
        const fallbackSession = createGatewayTimeoutFallbackSession(fallbackAgentId);
        runtime.error?.(
          `EMBEDDED FALLBACK: Gateway agent timed out; running embedded agent with fresh session ${fallbackSession.sessionId}: ${String(err)}`,
        );
        const result = await agentCommand(
          {
            ...localOpts,
            sessionId: fallbackSession.sessionId,
            sessionKey: fallbackSession.sessionKey,
            runId: fallbackSession.sessionId,
            resultMetaOverrides: {
              ...EMBEDDED_FALLBACK_META,
              fallbackReason: "gateway_timeout",
              fallbackSessionId: fallbackSession.sessionId,
              fallbackSessionKey: fallbackSession.sessionKey,
            },
          },
          runtime,
          deps,
        );
        return returnAfterSignalExit(result, signalBridge.getReceivedSignal(), runtime);
      }

      if (!isGatewayAgentEmbeddedFallbackError(err)) {
        throw err;
      }

      runtime.error?.(
        `EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: ${String(err)}`,
      );
      const result = await agentCommand(
        {
          ...localOpts,
          resultMetaOverrides: EMBEDDED_FALLBACK_META,
        },
        runtime,
        deps,
      );
      return returnAfterSignalExit(result, signalBridge.getReceivedSignal(), runtime);
    }
  } catch (err) {
    if (isAbortError(err) && exitForReceivedSignal(signalBridge.getReceivedSignal(), runtime)) {
      return undefined;
    }
    throw err;
  } finally {
    signalBridge.dispose();
  }
}
