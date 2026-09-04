// Error identity and timeout recognition must not load logging or provider runtime.
import { readErrorName } from "@openclaw/normalization-core/error-coercion";
import { isProviderRequestSizeCeilingError, isTimeoutErrorMessage } from "./message-patterns.js";
import type { FailoverReason } from "./signal.js";

const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;

export type CliTimeoutContext = {
  mode: "overall" | "no-output";
  timeoutSeconds: number;
  observedActivity: boolean;
  activeToolCount: number;
  backgroundTaskCount: number;
};

export type FallbackAttemptRecord = {
  provider: string;
  model: string;
  reason: FailoverReason;
  status?: number;
  error?: string;
};

/** Structured error used to carry model fallback/failover metadata across layers. */
export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly authMode?: string;
  readonly status?: number;
  readonly code?: string;
  readonly rawError?: string;
  // Preserve the provider fact before the message becomes user-facing copy.
  readonly requestSizeCeiling: boolean;
  readonly authProfileFailure?: { allInCooldown: boolean };
  // Originating request attribution propagated through wrapper errors so
  // structured log ingestion (e.g. api_health_log) can attribute exhausted
  // failover failures back to a session/lane and the last attempted provider.
  // See #42713.
  readonly sessionId?: string;
  readonly lane?: string;
  readonly suspend?: boolean;
  readonly cliTimeout?: CliTimeoutContext;
  readonly attempts?: readonly FallbackAttemptRecord[];
  readonly soonestCooldownExpiry?: number | null;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      profileId?: string;
      authMode?: string;
      status?: number;
      code?: string;
      rawError?: string;
      authProfileFailure?: { allInCooldown: boolean };
      sessionId?: string;
      lane?: string;
      cause?: unknown;
      suspend?: boolean;
      cliTimeout?: CliTimeoutContext;
      attempts?: readonly FallbackAttemptRecord[];
      soonestCooldownExpiry?: number | null;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.profileId = params.profileId;
    this.authMode = params.authMode;
    this.status = params.status;
    this.code = params.code;
    this.rawError = params.rawError;
    this.requestSizeCeiling = isProviderRequestSizeCeilingError(params.rawError ?? message);
    this.authProfileFailure = params.authProfileFailure;
    this.sessionId = params.sessionId;
    this.lane = params.lane;
    this.suspend = params.suspend;
    this.cliTimeout = params.cliTimeout;
    this.attempts = params.attempts;
    this.soonestCooldownExpiry = params.soonestCooldownExpiry;
  }
}

/** Return true for native or serialized failover errors. */
export function isFailoverError(err: unknown): err is FailoverError {
  if (err instanceof FailoverError) {
    return true;
  }
  return Boolean(
    err &&
    typeof err === "object" &&
    // SAFETY: the object check above permits reading an unknown optional name.
    (err as { name?: unknown }).name === "FailoverError" &&
    // SAFETY: the object check above permits reading an unknown optional reason.
    typeof (err as { reason?: unknown }).reason === "string",
  );
}

export function findErrorProperty<T>(
  err: unknown,
  reader: (candidate: unknown) => T | undefined,
  seen: Set<object> = new Set(),
): T | undefined {
  const direct = reader(err);
  if (direct !== undefined) {
    return direct;
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  if (seen.has(err)) {
    return undefined;
  }
  seen.add(err);
  // SAFETY: non-objects were rejected; both optional fields stay unknown.
  const candidate = err as { error?: unknown; cause?: unknown };
  return (
    findErrorProperty(candidate.error, reader, seen) ??
    findErrorProperty(candidate.cause, reader, seen)
  );
}

export function readDirectErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  // SAFETY: The object guard permits probing code; its value remains unknown.
  const directCode = (err as { code?: unknown }).code;
  if (typeof directCode === "string") {
    const trimmed = directCode.trim();
    return trimmed ? trimmed : undefined;
  }
  // SAFETY: Optional chaining handles absent details; only string codes are accepted.
  const detailCode = (err as { detail?: { code?: unknown } }).detail?.code;
  if (typeof detailCode === "string") {
    const trimmed = detailCode.trim();
    return trimmed ? trimmed : undefined;
  }
  // SAFETY: The object guard permits probing status; its type is checked below.
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "string" || /^\d+$/.test(status)) {
    return undefined;
  }
  const trimmed = status.trim();
  return trimmed ? trimmed : undefined;
}

export function getFailoverErrorCode(err: unknown): string | undefined {
  // A typed failure owns its code, including absence; only raw errors search causes.
  return isFailoverError(err) ? err.code : findErrorProperty(err, readDirectErrorCode);
}

export function readDirectErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) {
    return err.message || undefined;
  }
  if (typeof err === "string") {
    return err || undefined;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    return err.description ?? undefined;
  }
  if (err && typeof err === "object") {
    // SAFETY: this branch has an object; the message is checked before use.
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message || undefined;
    }
  }
  return undefined;
}

export function getErrorMessage(err: unknown): string {
  return findErrorProperty(err, readDirectErrorMessage) ?? "";
}

function hasTimeoutHint(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (readErrorName(err) === "TimeoutError") {
    return true;
  }
  const message = getErrorMessage(err);
  return Boolean(message && isTimeoutErrorMessage(message));
}

/** Return true when an unknown error shape represents a timeout. */
export function isTimeoutError(err: unknown): boolean {
  if (hasTimeoutHint(err)) {
    return true;
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  if (readErrorName(err) !== "AbortError") {
    return false;
  }
  const message = getErrorMessage(err);
  if (message && ABORT_TIMEOUT_RE.test(message)) {
    return true;
  }
  const cause = "cause" in err ? err.cause : undefined;
  const reason = "reason" in err ? err.reason : undefined;
  return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}

/** Return true when an abort-signal reason is an intentional timeout; plain AbortError is a cancellation, not a timeout. */
export function isSignalTimeoutReason(reason: unknown): boolean {
  return readErrorName(reason) === "TimeoutError";
}
