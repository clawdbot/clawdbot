/**
 * Environment-driven debug controls for model transport logging.
 *
 * Model adapters share these helpers so payload, SSE, and transport diagnostics
 * interpret OpenClaw debug environment variables consistently.
 */
import type { createSubsystemLogger } from "../logging/subsystem.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ModelTransportDebugEnv = NodeJS.ProcessEnv;

/** Payload debug detail levels accepted by `OPENCLAW_DEBUG_MODEL_PAYLOAD`. */
export type ModelPayloadDebugMode = "off" | "summary" | "tools" | "full-redacted";
/** SSE debug detail levels accepted by `OPENCLAW_DEBUG_SSE`. */
export type ModelSseDebugMode = "off" | "events" | "peek";

function normalizeEnv(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isTruthyEnv(value: unknown): boolean {
  const normalized = normalizeEnv(value);
  return (
    normalized.length > 0 &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "off" &&
    normalized !== "no"
  );
}

/** Resolves model payload debug verbosity from `OPENCLAW_DEBUG_MODEL_PAYLOAD`. */
export function resolveModelPayloadDebugMode(
  env: ModelTransportDebugEnv = process.env,
): ModelPayloadDebugMode {
  const normalized = normalizeEnv(env.OPENCLAW_DEBUG_MODEL_PAYLOAD);
  if (normalized === "tools" || normalized === "full-redacted") {
    return normalized;
  }
  if (normalized === "summary") {
    return "summary";
  }
  return "off";
}

/** Resolves SSE stream debug verbosity from `OPENCLAW_DEBUG_SSE`. */
export function resolveModelSseDebugMode(
  env: ModelTransportDebugEnv = process.env,
): ModelSseDebugMode {
  const normalized = normalizeEnv(env.OPENCLAW_DEBUG_SSE);
  if (normalized === "peek") {
    return "peek";
  }
  if (normalized === "events" || isTruthyEnv(normalized)) {
    return "events";
  }
  return "off";
}

/** Returns whether any model transport debug channel is enabled. */
export function isModelTransportDebugEnabled(env: ModelTransportDebugEnv = process.env): boolean {
  return (
    isTruthyEnv(env.OPENCLAW_DEBUG_MODEL_TRANSPORT) ||
    resolveModelPayloadDebugMode(env) !== "off" ||
    resolveModelSseDebugMode(env) !== "off" ||
    isTruthyEnv(env.OPENCLAW_DEBUG_CODE_MODE)
  );
}

/** Emits transport diagnostics at info level only when debug env explicitly enables them. */
export function emitModelTransportDebug(log: SubsystemLogger, message: string): void {
  if (isModelTransportDebugEnabled()) {
    log.info(message);
    return;
  }
  log.debug(message);
}
