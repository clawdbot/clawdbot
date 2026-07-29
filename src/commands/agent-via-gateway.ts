// Gateway-first agent CLI implementation with explicit --local embedded execution.
import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.types.js";
import { withProgress } from "../cli/progress.js";
import {
  readGatewayDispatchConfig,
  readGatewayDispatchConfigWithShellEnvFallback,
} from "../config/gateway-dispatch-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  callGateway,
  isGatewayCredentialsRequiredError,
  isGatewayExplicitAuthRequiredError,
  isGatewayTransportError,
  randomIdempotencyKey,
  type GatewayRequestFunction,
} from "../gateway/call.js";
import { isGatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { ADMIN_SCOPE } from "../gateway/operator-scopes.js";
import { createAbortError } from "../infra/abort-signal.js";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import { routeLogsToStderr } from "../logging/console.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { normalizeMessageChannel } from "../utils/message-channel-normalize.js";

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
const GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const;

type AgentCliOpts = {
  message?: string;
  messageFile?: string;
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
type AgentDispatchOpts = Omit<AgentCliOpts, "messageFile"> & {
  message: string;
};

type AgentCliSignal = "SIGINT" | "SIGTERM";
type AgentCliProcessLike = {
  exitCode?: NodeJS.Process["exitCode"];
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
type AgentSessionModule = typeof import("./agent/session.js");
type AgentSessionModuleLoader = () => Promise<AgentSessionModule>;

const AGENT_CLI_SIGNALS: readonly AgentCliSignal[] = ["SIGINT", "SIGTERM"];
const GATEWAY_ABORT_RETRY_DELAYS_MS = [50, 150, 300, 600] as const;
const GATEWAY_ABORT_REQUEST_TIMEOUT_MS = 2_000;
const AGENT_CLI_SIGNAL_EXIT_CODES: Record<AgentCliSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};
const MESSAGE_FILE_DECODER = new TextDecoder("utf-8", { fatal: true });

const defaultAgentSessionModuleLoader: AgentSessionModuleLoader = () =>
  import("./agent/session.js");
let agentSessionModuleLoader: AgentSessionModuleLoader = defaultAgentSessionModuleLoader;
const embeddedAgentCommandLoader = createLazyPromiseLoader(
  () => import("./agent.js").then((module) => module.agentCommand),
  { cacheRejections: true },
);
const agentSessionModuleCache = createLazyPromiseLoader(() => agentSessionModuleLoader(), {
  cacheRejections: true,
});
const runtimeConfigModuleLoader = createLazyPromiseLoader(() => import("../config/io.js"), {
  cacheRejections: true,
});
const replyPayloadModuleLoader = createLazyPromiseLoader(
  () => import("openclaw/plugin-sdk/reply-payload"),
  { cacheRejections: true },
);
let gatewayAbortRetryDelaysMsForTests: readonly number[] | undefined;

function resolveGatewayAbortRetryDelaysMs(): readonly number[] {
  return gatewayAbortRetryDelaysMsForTests ?? GATEWAY_ABORT_RETRY_DELAYS_MS;
}

const loadAgentSessionModule = agentSessionModuleCache.load;

async function loadRuntimeConfig(): Promise<OpenClawConfig> {
  const { getRuntimeConfig } = await runtimeConfigModuleLoader.load();
  return getRuntimeConfig();
}

const loadReplyPayloadModule = replyPayloadModuleLoader.load;

/** Test-only hooks for resetting lazy imports and shortening retry timing. */
export const agentViaGatewayTesting = {
  resetLazyImportsForTests(): void {
    embeddedAgentCommandLoader.clear();
    agentSessionModuleCache.clear();
    runtimeConfigModuleLoader.clear();
    replyPayloadModuleLoader.clear();
    agentSessionModuleLoader = defaultAgentSessionModuleLoader;
  },
  setAgentSessionModuleLoaderForTests(loader: AgentSessionModuleLoader): void {
    agentSessionModuleCache.clear();
    agentSessionModuleLoader = loader;
  },
  resolveGatewayAgentTimeoutMs,
  setGatewayAbortRetryDelaysMsForTests(delays?: readonly number[]): void {
    gatewayAbortRetryDelaysMsForTests = delays;
  },
};

function protectJsonStdout(opts: Pick<AgentCliOpts, "json">): void {
  if (opts.json === true) {
    routeLogsToStderr();
  }
}

function missingAgentMessageError(): Error {
  return new Error(
    `Missing message. Use ${formatCliCommand('openclaw agent --message "..." --agent <id>')} or ${formatCliCommand("openclaw agent --message-file <path> --agent <id>")}.`,
  );
}

function formatMessageFileReadFailure(messageFile: string, err: unknown): string {
  const code =
    typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  if (code === "ENOENT") {
    return `Message file not found: ${messageFile}`;
  }
  if (code === "EISDIR") {
    return `Message file is a directory: ${messageFile}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Unable to read message file ${messageFile}: ${message}`;
}

// Agent messages are prompt text; a 4 MiB cap gives generous headroom for
// long system prompts while preventing a symlink/huge-file path from OOMing
// the CLI before dispatch.
const AGENT_MESSAGE_FILE_MAX_BYTES = 4 * 1024 * 1024;

async function readAgentMessageFile(messageFile: string): Promise<string> {
  // Open the original path so the kernel preserves symlink and procfs magic-link
  // behavior (notably piped /dev/stdin), then inspect that exact descriptor.
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(messageFile, "r");
  } catch (err) {
    throw new Error(formatMessageFileReadFailure(messageFile, err), { cause: err });
  }
  let buffer: Buffer;
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      // Keep the legacy fs.readFile directory UX.
      throw Object.assign(new Error("Message file is a directory"), { code: "EISDIR" });
    }
    // Regular files fail fast. Streams report size 0, so the descriptor reader
    // enforces the same limit byte-by-byte while preserving FIFO behavior.
    if (stat.isFile() && stat.size > AGENT_MESSAGE_FILE_MAX_BYTES) {
      throw new Error(`File exceeds ${AGENT_MESSAGE_FILE_MAX_BYTES} bytes: ${messageFile}`);
    }
    buffer = await readFileDescriptorBounded(handle.fd, AGENT_MESSAGE_FILE_MAX_BYTES);
  } catch (err) {
    throw new Error(formatMessageFileReadFailure(messageFile, err), { cause: err });
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    return MESSAGE_FILE_DECODER.decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(`Message file must be valid UTF-8: ${messageFile}`);
  }
}

async function resolveAgentMessageOpts(opts: AgentCliOpts): Promise<AgentDispatchOpts> {
  const { messageFile: rawMessageFile, ...rest } = opts;
  const messageFile = rawMessageFile?.trim();
  const hasInlineMessage = opts.message !== undefined;
  if (hasInlineMessage && messageFile) {
    throw new Error("Use either --message or --message-file, not both.");
  }
  if (rawMessageFile !== undefined && !messageFile) {
    throw new Error("--message-file must not be empty.");
  }
  if (messageFile) {
    const message = await readAgentMessageFile(messageFile);
    if (!message.trim()) {
      throw new Error(`Message file is empty: ${messageFile}`);
    }
    return { ...rest, message };
  }
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw missingAgentMessageError();
  }
  return { ...rest, message };
}

function parseTimeoutSeconds(opts: { cfg: OpenClawConfig; timeout?: string }) {
  const raw =
    opts.timeout !== undefined
      ? parseStrictNonNegativeInteger(opts.timeout)
      : (opts.cfg.agents?.defaults?.timeoutSeconds ?? 600);
  if (raw === undefined) {
    throw new Error(
      `Invalid --timeout. Use seconds as a non-negative integer, for example --timeout 600. Use --timeout 0 to disable the timeout.`,
    );
  }
  return raw;
}

function resolveGatewayAgentTimeoutMs(timeoutSeconds: number): number {
  if (timeoutSeconds === 0) {
    return NO_GATEWAY_TIMEOUT_MS;
  }
  return resolveTimerTimeoutMs((timeoutSeconds + 30) * 1000, 10_000, 10_000);
}

async function formatPayloadForLog(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
}) {
  const { resolveSendableOutboundReplyParts } = await loadReplyPayloadModule();
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
    lines.push(`Attachment: ${url}`);
  }
  return lines.join("\n").trimEnd();
}

function isCompactControlCommand(message: string): boolean {
  return /^\/compact(?:\s|:|$)/iu.test(message.trim());
}

function isSessionResetCommand(message: string): boolean {
  return /^\/(?:new|reset)(?:\s|$)/i.test(message.trim());
}

function shouldRetryGatewayDispatchWithShellEnvFallback(err: unknown): boolean {
  return (
    isGatewayCredentialsRequiredError(err) ||
    isGatewayExplicitAuthRequiredError(err) ||
    isGatewaySecretRefUnavailableError(err)
  );
}

function resolveGatewayAgentFailureHint(
  err: unknown,
): "timed out" | "connection closed" | undefined {
  if (!isGatewayTransportError(err)) {
    return undefined;
  }
  // callGateway's wrapper timer gives this CLI path typed transport errors.
  // Legacy request-timeout strings belong to lower-level and in-process callers.
  return err.kind === "timeout" ? "timed out" : "connection closed";
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

async function normalizeSessionKeyOptsForDispatch(
  opts: AgentDispatchOpts,
): Promise<AgentDispatchOpts> {
  const rawSessionKey = opts.sessionKey?.trim();
  const rawTo = opts.to?.trim();
  if (!rawSessionKey && !opts.sessionId?.trim() && classifySessionKeyShape(rawTo) === "agent") {
    return {
      ...opts,
      to: undefined,
      sessionKey: rawTo,
    };
  }
  const isLegacySessionKey =
    rawSessionKey && classifySessionKeyShape(rawSessionKey) === "legacy_or_alias";
  const agentIdRaw = opts.agent?.trim();
  const shouldScopeDefaultAgentKey =
    isLegacySessionKey && !agentIdRaw && !isUnscopedSessionKeySentinel(rawSessionKey);
  const cfg =
    isLegacySessionKey && (agentIdRaw || shouldScopeDefaultAgentKey)
      ? opts.local === true
        ? await loadRuntimeConfig()
        : readGatewayDispatchConfig()
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
    setExitCode: (code: number) => {
      processLike.exitCode = code;
    },
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
  if (!deps || !Object.hasOwn(deps, "process")) {
    return process;
  }
  const processLike = (deps as { process?: unknown }).process;
  return isAgentCliProcessLike(processLike) ? processLike : process;
}

function createAbortDelayError(): Error {
  return createAbortError("gateway agent retry aborted");
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
  config: OpenClawConfig;
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
      config: params.config,
      ...params.gatewayIdentity,
    });
  const retryDelaysMs = resolveGatewayAbortRetryDelaysMs();
  for (const [attempt, retryDelayMs] of [...retryDelaysMs, 0].entries()) {
    const isFinalAttempt = attempt === retryDelaysMs.length;
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
  const retryDelaysMs = resolveGatewayAbortRetryDelaysMs();
  for (const [attempt, retryDelayMs] of [...retryDelaysMs, 0].entries()) {
    const isFinalAttempt = attempt === retryDelaysMs.length;
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

function markFailedGatewayAgentResponse(
  response: GatewayAgentResponse,
  signalBridge: ReturnType<typeof createAgentCliSignalBridge>,
): void {
  if (
    response.status === "timeout" ||
    response.status === "error" ||
    response.status === "cancelled"
  ) {
    // Let Node drain structured or text stdout before the process exits.
    signalBridge.setExitCode(1);
  }
}

function formatInFlightGatewayAgentMessage(response: GatewayAgentResponse): string {
  return response.runId
    ? `Agent run ${response.runId} is already in flight; not starting a duplicate run.`
    : "Agent run is already in flight; not starting a duplicate run.";
}

async function agentViaGatewayCommand(
  opts: AgentDispatchOpts,
  runtime: RuntimeEnv,
  signalBridge: ReturnType<typeof createAgentCliSignalBridge>,
) {
  const body = opts.message;
  const explicitSessionKey = opts.sessionKey?.trim();
  if (!opts.to && !opts.sessionId && !opts.agent && !explicitSessionKey) {
    throw new Error(
      `No target session selected. Use --agent <id>, --session-key <key>, --session-id <id>, or --to <E.164>. Run ${formatCliCommand("openclaw agents list")} to see agents.`,
    );
  }

  // Scoped gateway turns need core agent/session/gateway fields only. The
  // running gateway owns plugin validation and plugin metadata freshness.
  let cfg: OpenClawConfig = readGatewayDispatchConfig();
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
  const gatewayTimeoutMs = resolveGatewayAgentTimeoutMs(timeoutSeconds);
  const channel = normalizeMessageChannel(opts.channel);
  const deferExplicitRecipientSession = Boolean(
    !explicitSessionKey &&
    !opts.sessionId?.trim() &&
    agentId &&
    channel &&
    channel !== "last" &&
    opts.to?.trim() &&
    classifySessionKeyShape(opts.to) !== "agent",
  );

  const sessionKey = deferExplicitRecipientSession
    ? undefined
    : classifySessionKeyShape(explicitSessionKey) === "agent"
      ? explicitSessionKey
      : (await loadAgentSessionModule()).resolveSessionKeyForRequest({
          cfg,
          agentId,
          to: opts.to,
          sessionId: opts.sessionId,
          sessionKey: explicitSessionKey,
        }).sessionKey;
  const abortSessionKey = deferExplicitRecipientSession
    ? (await loadAgentSessionModule()).resolveSessionKeyForRequest({ cfg, agentId }).sessionKey
    : sessionKey;

  const idempotencyKey = normalizeOptionalString(opts.runId) || randomIdempotencyKey();
  const modelOverride = normalizeOptionalString(opts.model);
  const hasModelOverride = Boolean(modelOverride);
  const needsAdminGatewayIdentity = hasModelOverride || isSessionResetCommand(body);
  const hasGatewayUrlOverride = Boolean(normalizeOptionalString(process.env.OPENCLAW_GATEWAY_URL));
  const usesRemoteGateway = cfg.gateway?.mode === "remote" || hasGatewayUrlOverride;
  const gatewayIdentity: AgentGatewayCallIdentity = needsAdminGatewayIdentity
    ? {
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: [ADMIN_SCOPE],
      }
    : {
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        // The local CLI is the Gateway owner. Keep owner-only run tools available;
        // remote clients retain the agent method's least-privilege scope.
        ...(usesRemoteGateway ? {} : { scopes: [ADMIN_SCOPE] }),
      };

  let acceptedRunId: string | undefined = idempotencyKey;
  let acceptedSessionKey: string | undefined = abortSessionKey;
  let acceptedGatewayRun = false;
  let activeConnectionAbortAttempted = false;
  let activeConnectionAbortSucceeded = false;
  let response: GatewayAgentResponse | undefined;
  const dispatchGatewayAgentCall = async (activeCfg: OpenClawConfig) =>
    await withProgress(
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
            cleanupBundleMcpOnRunEnd: true,
            idempotencyKey,
          },
          expectFinal: true,
          timeoutMs: gatewayTimeoutMs,
          config: activeCfg,
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

  let shellEnvFallbackRetriesRemaining = 1;
  const consumeShellEnvFallbackRetry = () => shellEnvFallbackRetriesRemaining-- > 0;
  for (;;) {
    try {
      response = await dispatchGatewayAgentCall(cfg);
      break;
    } catch (err) {
      if (
        !acceptedGatewayRun &&
        shouldRetryGatewayDispatchWithShellEnvFallback(err) &&
        consumeShellEnvFallbackRetry()
      ) {
        cfg = await readGatewayDispatchConfigWithShellEnvFallback();
        continue;
      }
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
          config: cfg,
        });
      }
      throw err;
    }
  }
  if (!response) {
    throw new Error("gateway agent call did not return a response");
  }

  if (opts.json) {
    writeRuntimeJson(runtime, buildGatewayJsonResponse(response));
    markFailedGatewayAgentResponse(response, signalBridge);
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
    markFailedGatewayAgentResponse(response, signalBridge);
    return response;
  }

  for (const payload of payloads) {
    const out = await formatPayloadForLog(payload);
    if (out) {
      runtime.log(out);
    }
  }

  markFailedGatewayAgentResponse(response, signalBridge);

  return response;
}

async function agentViaGatewayCommandWithTransientRetries(
  opts: AgentDispatchOpts,
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
        `Gateway agent connection closed during handshake; retrying in ${retryDelayMs}ms before failing.`,
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
  const messageOpts = await resolveAgentMessageOpts(opts);
  // `/compact` cannot run as a plain CLI agent turn: the slash-command handler
  // rejects CLI-originated senders, so the message would fall through to a
  // normal turn and exit 0 without compacting anything (issue #90640 Gap B).
  // Fail loudly and point at the first-class command instead of no-opping.
  if (isCompactControlCommand(messageOpts.message)) {
    runtime.error?.(
      "Slash commands cannot be executed via --message from the CLI. Use: openclaw sessions compact <key>",
    );
    runtime.exit(1);
    return undefined;
  }
  const dispatchOpts = await normalizeSessionKeyOptsForDispatch(messageOpts);
  validateExplicitSessionKeyForDispatch(dispatchOpts);
  const gatewayDispatchOpts = dispatchOpts.runId
    ? dispatchOpts
    : { ...dispatchOpts, runId: randomIdempotencyKey() };
  const signalBridge = createAgentCliSignalBridge(resolveAgentCliProcessLike(deps));
  try {
    if (dispatchOpts.local === true) {
      const agentCommand = await embeddedAgentCommandLoader.load();
      const result = await agentCommand(
        {
          ...gatewayDispatchOpts,
          agentId: gatewayDispatchOpts.agent,
          replyAccountId: gatewayDispatchOpts.replyAccount,
          cleanupBundleMcpOnRunEnd: true,
          cleanupCliLiveSessionOnRunEnd: true,
          oneShotCliRun: true,
          abortSignal: signalBridge.signal,
        },
        runtime,
        deps,
      );
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
      const failureHint = resolveGatewayAgentFailureHint(err);
      if (failureHint) {
        // Transport loss is ambiguous: the Gateway may have accepted and may still
        // finish this turn. Recommending a blind retry or --local here could
        // double-execute the message, so point at verification first.
        runtime.error?.(
          `Gateway agent call ${failureHint}; the Gateway may still be running this turn. Check \`openclaw gateway status\` and the session transcript before retrying or rerunning with --local, so the turn does not execute twice.`,
        );
      }
      throw err;
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
