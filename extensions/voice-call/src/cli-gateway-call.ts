// Voice Call plugin module implements cli gateway calls.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  callGatewayFromCli,
  isGatewayClientRequestError,
  isGatewayTransportError,
  redactSensitiveUrlLikeString,
} from "openclaw/plugin-sdk/gateway-runtime";
import {
  addTimerTimeoutGraceMs,
  clampTimerTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
} from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sleep } from "../api.js";
import { writeCliJson } from "./cli-command-io.js";
import type { VoiceCallConfig } from "./config.js";
import type { VoiceCallRuntime } from "./runtime.js";

type VoiceCallGatewayMethod =
  | "voicecall.initiate"
  | "voicecall.start"
  | "voicecall.continue"
  | "voicecall.continue.start"
  | "voicecall.continue.result"
  | "voicecall.speak"
  | "voicecall.dtmf"
  | "voicecall.end"
  | "voicecall.status";

type VoiceCallGatewayCallResult = { ok: true; payload: unknown } | { ok: false; error: unknown };

type GatewayCallOptions = { timeoutMs?: number };

const VOICE_CALL_GATEWAY_DEFAULT_TIMEOUT_MS = 5000;
const VOICE_CALL_GATEWAY_OPERATION_TIMEOUT_MS = 30000;
const VOICE_CALL_GATEWAY_TRANSCRIPT_BUFFER_MS = 10000;
const VOICE_CALL_GATEWAY_POLL_INTERVAL_MS = 1000;

function isGatewayUnavailableForLocalFallback(err: unknown): boolean {
  return (
    isGatewayTransportError(err) &&
    err.kind === "closed" &&
    (err.code === undefined || err.code === 1006)
  );
}

function isGatewayCredentialFailure(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.name === "GatewayCredentialsRequiredError" ||
      err.name === "GatewayExplicitAuthRequiredError" ||
      err.name === "GatewaySecretRefUnavailableError")
  );
}

function gatewayOperationalError(err: unknown): Error {
  const message = formatErrorMessage(err);
  const detail = (() => {
    if (isGatewayClientRequestError(err)) {
      return `Gateway responded but voicecall failed: ${message}\nThe running Gateway owns the voice-call runtime; check \`openclaw gateway status\` or restart it.`;
    }
    if (isGatewayCredentialFailure(err)) {
      return `Gateway requires credentials: ${message}\nConfigure gateway.auth or pair this device with \`openclaw devices approve --latest\`.`;
    }
    if (isGatewayTransportError(err)) {
      const url = err.connectionDetails.url;
      if (err.kind === "timeout") {
        const timeout =
          err.timeoutMs === undefined ? "the configured timeout" : `${err.timeoutMs}ms`;
        return `Gateway at ${url} did not answer within ${timeout}: ${message}\nIt may be starting or wedged; check \`openclaw gateway status\`.`;
      }
      return `Gateway connection at ${url} failed: ${message}\nCheck gateway.auth and \`openclaw gateway status\`, then retry.`;
    }
    return `Gateway voicecall request failed: ${message}\nCheck \`openclaw gateway status\`, then retry.`;
  })();
  // Configured gateway URLs may embed userinfo/tokens, and close reasons are
  // remote-controlled text; redact once where the text becomes operator-visible.
  return new Error(redactSensitiveUrlLikeString(detail));
}

export function isUnknownMethod(err: unknown, method: VoiceCallGatewayMethod): boolean {
  return formatErrorMessage(err).includes(`unknown method: ${method}`);
}

export async function callVoiceCallGateway(
  method: VoiceCallGatewayMethod,
  params?: Record<string, unknown>,
  opts?: GatewayCallOptions,
): Promise<VoiceCallGatewayCallResult> {
  try {
    const timeoutMs =
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? Math.max(1, Math.ceil(opts.timeoutMs))
        : VOICE_CALL_GATEWAY_DEFAULT_TIMEOUT_MS;
    const payload = await callGatewayFromCli(
      method,
      { json: true, timeout: String(timeoutMs) },
      params,
      { progress: false },
    );
    return { ok: true, payload };
  } catch (err) {
    if (isGatewayUnavailableForLocalFallback(err)) {
      return { ok: false, error: err };
    }
    throw gatewayOperationalError(err);
  }
}

export function resolveOperationTimeout(config: VoiceCallConfig): number {
  return Math.max(
    VOICE_CALL_GATEWAY_OPERATION_TIMEOUT_MS,
    addTimerTimeoutGraceMs(config.ringTimeoutMs) ?? 1,
  );
}

export function resolveContinueTimeout(config: VoiceCallConfig): number {
  return (
    clampTimerTimeoutMs(
      config.transcriptTimeoutMs +
        VOICE_CALL_GATEWAY_OPERATION_TIMEOUT_MS +
        VOICE_CALL_GATEWAY_TRANSCRIPT_BUFFER_MS,
    ) ?? 1
  );
}

function resolveVoiceCallDeadlineMs(timeoutMs: number, nowMs = Date.now()): number {
  return nowMs + (clampTimerTimeoutMs(timeoutMs) ?? MAX_TIMER_TIMEOUT_MS);
}

function readGatewayOperationId(payload: unknown): string {
  if (isRecord(payload) && typeof payload.operationId === "string" && payload.operationId) {
    return payload.operationId;
  }
  throw new Error("voicecall gateway response missing operationId");
}

function readGatewayPollTimeoutMs(payload: unknown, fallbackTimeoutMs: number): number {
  if (isRecord(payload) && typeof payload.pollTimeoutMs === "number") {
    return clampTimerTimeoutMs(payload.pollTimeoutMs) ?? fallbackTimeoutMs;
  }
  return fallbackTimeoutMs;
}

function readCompletedContinueResult(
  payload: unknown,
):
  | { status: "pending" }
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string } {
  if (!isRecord(payload)) {
    throw new Error("voicecall gateway response missing operation status");
  }
  if (payload.status === "pending") {
    return { status: "pending" };
  }
  if (payload.status === "failed") {
    return {
      status: "failed",
      error: typeof payload.error === "string" ? payload.error : "continue failed",
    };
  }
  if (payload.status === "completed") {
    return { status: "completed", result: payload.result };
  }
  throw new Error("voicecall gateway response has unknown operation status");
}

export async function pollContinueGateway(
  payload: unknown,
  fallbackTimeoutMs: number,
): Promise<unknown> {
  if (!isRecord(payload) || typeof payload.operationId !== "string") {
    return payload;
  }
  const params = {
    operationId: readGatewayOperationId(payload),
    timeoutMs: readGatewayPollTimeoutMs(payload, fallbackTimeoutMs),
  };
  const deadlineMs = resolveVoiceCallDeadlineMs(params.timeoutMs);

  for (;;) {
    // Sleep already clamps to remaining budget; the gateway RPC must too.
    // Otherwise the final poll can overrun the continue deadline by a full RPC timeout.
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const gateway = await callVoiceCallGateway(
      "voicecall.continue.result",
      { operationId: params.operationId },
      { timeoutMs: Math.min(VOICE_CALL_GATEWAY_DEFAULT_TIMEOUT_MS, remainingMs) },
    );
    if (!gateway.ok) {
      throw new Error(
        `gateway unavailable while waiting for voicecall continue result: ${formatErrorMessage(
          gateway.error,
        )}`,
      );
    }
    const result = readCompletedContinueResult(gateway.payload);
    if (result.status === "completed") {
      return result.result;
    }
    if (result.status === "failed") {
      throw new Error(result.error);
    }
    const sleepMs = Math.min(VOICE_CALL_GATEWAY_POLL_INTERVAL_MS, deadlineMs - Date.now());
    if (sleepMs <= 0) {
      break;
    }
    await sleep(sleepMs);
  }

  throw new Error("voicecall continue timed out waiting for gateway operation");
}

async function ensureStandaloneRuntime(params: {
  config: VoiceCallConfig;
  ensureRuntime: () => Promise<VoiceCallRuntime>;
}): Promise<VoiceCallRuntime> {
  try {
    return await params.ensureRuntime();
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
      throw new Error(
        `Voice-call webhook port ${params.config.serve.port} is already in use. A running Gateway probably already serves it; operational commands route through that Gateway. Check \`openclaw gateway status\` and retry.`,
        { cause: err },
      );
    }
    throw err;
  }
}

export async function runGatewayManagerCommand(params: {
  config: VoiceCallConfig;
  ensureRuntime: () => Promise<VoiceCallRuntime>;
  gatewayCall: () => Promise<VoiceCallGatewayCallResult>;
  resolveGatewayPayload?: (payload: unknown) => Promise<unknown>;
  managerFallback: (
    manager: VoiceCallRuntime["manager"],
  ) => Promise<{ success: boolean; error?: string }>;
  failureLabel: string;
}): Promise<void> {
  const gateway = await params.gatewayCall();
  if (gateway.ok) {
    const payload = params.resolveGatewayPayload
      ? await params.resolveGatewayPayload(gateway.payload)
      : gateway.payload;
    writeCliJson(payload);
    return;
  }

  const runtime = await ensureStandaloneRuntime(params);
  const result = await params.managerFallback(runtime.manager);
  if (!result.success) {
    throw new Error(result.error || `${params.failureLabel} failed`);
  }
  writeCliJson(result);
}

function readGatewayCallId(payload: unknown, invalidCallIdMessage?: string): string {
  if (isRecord(payload) && typeof payload.callId === "string") {
    if (!invalidCallIdMessage || payload.callId) {
      return payload.callId;
    }
  }
  if (invalidCallIdMessage) {
    throw new Error(invalidCallIdMessage);
  }
  if (isRecord(payload) && typeof payload.error === "string") {
    throw new Error(payload.error);
  }
  throw new Error("voicecall gateway response missing callId");
}

export async function initiateVoiceCall(params: {
  ensureRuntime: () => Promise<VoiceCallRuntime>;
  config: VoiceCallConfig;
  method: "voicecall.initiate" | "voicecall.start";
  to?: string;
  message?: string;
  mode?: string;
  defaultMode?: "notify" | "conversation";
  failureMessage?: string;
}): Promise<string> {
  const mode =
    params.mode === "notify" || params.mode === "conversation" ? params.mode : params.defaultMode;
  const gateway = await callVoiceCallGateway(
    params.method,
    {
      ...(params.to ? { to: params.to } : {}),
      ...(params.message ? { message: params.message } : {}),
      ...(mode ? { mode } : {}),
    },
    {
      timeoutMs: resolveOperationTimeout(params.config),
    },
  );
  if (gateway.ok) {
    return readGatewayCallId(gateway.payload, params.failureMessage);
  }

  const runtime = await ensureStandaloneRuntime(params);
  const to = params.to ?? runtime.config.toNumber;
  if (!to) {
    throw new Error("Missing --to and no toNumber configured");
  }
  const result = await runtime.manager.initiateCall(to, undefined, {
    message: params.message,
    mode,
  });
  if (!result.success) {
    throw new Error(result.error || params.failureMessage || "initiate failed");
  }
  if (params.failureMessage && !result.callId) {
    throw new Error(params.failureMessage);
  }
  return result.callId;
}
