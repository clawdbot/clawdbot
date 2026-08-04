/**
 * Environment-driven debug controls for model transport logging.
 *
 * Model adapters share these helpers so payload, SSE, and transport diagnostics
 * interpret OpenClaw debug environment variables consistently.
 */
type SubsystemLogger = {
  info(message: string): void;
  debug(message: string): void;
};

type ModelTransportDebugEnv = NodeJS.ProcessEnv;

/** Payload debug detail levels accepted by `OPENCLAW_DEBUG_MODEL_PAYLOAD`. */
type ModelPayloadDebugMode = "off" | "summary" | "tools" | "full-redacted";
/** SSE debug detail levels accepted by `OPENCLAW_DEBUG_SSE`. */
type ModelSseDebugMode = "off" | "events" | "peek";

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
function isModelTransportDebugEnabled(env: ModelTransportDebugEnv = process.env): boolean {
  return (
    isTruthyEnv(env.OPENCLAW_DEBUG_MODEL_TRANSPORT) ||
    resolveModelPayloadDebugMode(env) !== "off" ||
    resolveModelSseDebugMode(env) !== "off" ||
    isTruthyEnv(env.OPENCLAW_DEBUG_CODE_MODE)
  );
}

function isModelFetchMetadataMessage(message: string): boolean {
  return message.startsWith("[model-fetch]");
}

/** Emits model-fetch metadata at info level by default; other diagnostics require debug env. */
export function emitModelTransportDebug(log: SubsystemLogger, message: string): void {
  if (isModelFetchMetadataMessage(message) || isModelTransportDebugEnabled()) {
    log.info(message);
    return;
  }
  log.debug(message);
}
