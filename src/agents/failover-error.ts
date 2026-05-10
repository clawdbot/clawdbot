import { readErrorName } from "../infra/errors.js";
import {
  classifyFailoverSignal,
  inferSignalStatus,
  isUnclassifiedNoBodyHttpSignal,
  type FailoverClassification,
  type FailoverSignal,
} from "./pi-embedded-helpers/errors.js";
import { isTimeoutErrorMessage } from "./pi-embedded-helpers/errors.js";
import type { FailoverReason } from "./pi-embedded-helpers/types.js";
import { isSessionWriteLockTimeoutError } from "./session-write-lock-error.js";

const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;
const MAX_FAILOVER_CAUSE_DEPTH = 25;

export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;
  readonly code?: string;
  readonly rawError?: string;
  // Originating request attribution propagated through wrapper errors so
  // structured log ingestion (e.g. api_health_log) can attribute exhausted
  // failover failures back to a session/lane and the last attempted provider.
  // See #42713.
  readonly sessionId?: string;
  readonly lane?: string;
  readonly suspend?: boolean;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      profileId?: string;
      status?: number;
      code?: string;
      rawError?: string;
      sessionId?: string;
      lane?: string;
      cause?: unknown;
      suspend?: boolean;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.profileId = params.profileId;
    this.status = params.status;
    this.code = params.code;
    this.rawError = params.rawError;
    this.sessionId = params.sessionId;
    this.lane = params.lane;
    this.suspend = params.suspend;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  if (err instanceof FailoverError) {
    return true;
  }
  return Boolean(
    err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "FailoverError" &&
    typeof (err as { reason?: unknown }).reason === "string",
  );
}

export function resolveFailoverStatus(reason: FailoverReason): number | undefined {
  switch (reason) {
    case "billing":
      return 402;
    case "server_error":
      return 500;
    case "rate_limit":
      return 429;
    case "overloaded":
      return 503;
    case "auth":
      return 401;
    case "auth_permanent":
      return 403;
    case "timeout":
      return 408;
    case "format":
      return 400;
    case "model_not_found":
      return 404;
    case "session_expired":
      return 410; // Gone - session no longer exists
    default:
      return undefined;
  }
}

function findErrorProperty<T>(
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
  const candidate = err as { error?: unknown; cause?: unknown };
  return (
    findErrorProperty(candidate.error, reader, seen) ??
    findErrorProperty(candidate.cause, reader, seen)
  );
}

function readDirectStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  if (typeof candidate === "number") {
    return candidate;
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
}

function getStatusCode(err: unknown): number | undefined {
  return findErrorProperty(err, readDirectStatusCode);
}

function readDirectErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const directCode = (err as { code?: unknown }).code;
  if (typeof directCode === "string") {
    const trimmed = directCode.trim();
    return trimmed ? trimmed : undefined;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "string" || /^\d+$/.test(status)) {
    return undefined;
  }
  const trimmed = status.trim();
  return trimmed ? trimmed : undefined;
}

function getErrorCode(err: unknown): string | undefined {
  return findErrorProperty(err, readDirectErrorCode);
}

function readDirectProvider(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const provider = (err as { provider?: unknown }).provider;
  if (typeof provider !== "string") {
    return undefined;
  }
  const trimmed = provider.trim();
  return trimmed || undefined;
}

function getProvider(err: unknown): string | undefined {
  return findErrorProperty(err, readDirectProvider);
}

function readDirectErrorMessage(err: unknown): string | undefined {
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
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message || undefined;
    }
  }
  return undefined;
}

function getErrorMessage(err: unknown): string {
  return findErrorProperty(err, readDirectErrorMessage) ?? "";
}

function normalizeDirectErrorSignal(err: unknown): FailoverSignal {
  const message = readDirectErrorMessage(err);
  return {
    status: readDirectStatusCode(err),
    code: readDirectErrorCode(err),
    message: message || undefined,
    provider: readDirectProvider(err),
  };
}

function hasSessionWriteLockTimeout(err: unknown, seen: Set<object> = new Set()): boolean {
  if (isSessionWriteLockTimeoutError(err)) {
    return true;
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  if (seen.has(err)) {
    return false;
  }
  seen.add(err);
  const candidate = err as { error?: unknown; cause?: unknown; reason?: unknown };
  return (
    hasSessionWriteLockTimeout(candidate.error, seen) ||
    hasSessionWriteLockTimeout(candidate.cause, seen) ||
    hasSessionWriteLockTimeout(candidate.reason, seen)
  );
}

function hasTimeoutHint(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (hasSessionWriteLockTimeout(err)) {
    return false;
  }
  if (readErrorName(err) === "TimeoutError") {
    return true;
  }
  const message = getErrorMessage(err);
  return Boolean(message && isTimeoutErrorMessage(message));
}

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
  if (hasSessionWriteLockTimeout(err)) {
    return false;
  }
  const message = getErrorMessage(err);
  if (message && ABORT_TIMEOUT_RE.test(message)) {
    return true;
  }
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  const reason = "reason" in err ? (err as { reason?: unknown }).reason : undefined;
  return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}

function failoverReasonFromClassification(
  classification: FailoverClassification | null,
): FailoverReason | null {
  return classification?.kind === "reason" ? classification.reason : null;
}

function normalizeErrorSignal(err: unknown, providerHint?: string): FailoverSignal {
  const message = getErrorMessage(err);
  return {
    status: getStatusCode(err),
    code: getErrorCode(err),
    message: message || undefined,
    provider: getProvider(err) ?? providerHint,
  };
}

function getNestedErrorCandidates(err: unknown): unknown[] {
  if (!err || typeof err !== "object") {
    return [];
  }
  const candidate = err as { error?: unknown; cause?: unknown };
  return [candidate.error, candidate.cause].filter(
    (value): value is unknown => value !== undefined && value !== err,
  );
}

function isFormatClassification(classification: FailoverClassification | null): boolean {
  return classification?.kind === "reason" && classification.reason === "format";
}

function decideNestedFormatOverride(
  candidate: unknown,
  inheritedStatus: number | undefined,
  seen: Set<object>,
  depth: number,
): boolean | null {
  if (depth > MAX_FAILOVER_CAUSE_DEPTH) {
    return null;
  }
  if (candidate && typeof candidate === "object") {
    if (seen.has(candidate)) {
      return null;
    }
    seen.add(candidate);
  }

  const directSignal = normalizeDirectErrorSignal(candidate);
  const nestedCandidates = getNestedErrorCandidates(candidate);
  const nestedStatus = directSignal.status ?? inheritedStatus;
  const hasDirectMessage = Boolean(directSignal.message?.trim());
  if (
    hasDirectMessage &&
    isUnclassifiedNoBodyHttpSignal({ ...directSignal, status: nestedStatus })
  ) {
    return true;
  }
  if (hasDirectMessage && (nestedCandidates.length === 0 || classifyFailoverSignal(directSignal))) {
    return false;
  }
  for (const nestedCandidate of nestedCandidates) {
    const decision = decideNestedFormatOverride(nestedCandidate, nestedStatus, seen, depth + 1);
    if (decision !== null) {
      return decision;
    }
  }
  return null;
}

function resolveFailoverClassificationFromErrorInternal(
  err: unknown,
  seen: Set<object>,
  depth: number,
  providerHint?: string,
): FailoverClassification | null {
  if (depth > MAX_FAILOVER_CAUSE_DEPTH) {
    return null;
  }
  if (err && typeof err === "object") {
    if (seen.has(err)) {
      return null;
    }
    seen.add(err);
  }
  if (isFailoverError(err)) {
    return {
      kind: "reason",
      reason: err.reason,
    };
  }
  const signal = normalizeErrorSignal(err, providerHint);
  const codeReason = signal.code
    ? failoverReasonFromClassification(classifyFailoverSignal({ code: signal.code }))
    : null;
  const hasExplicitFailoverMetadata =
    typeof inferSignalStatus(signal) === "number" ||
    (codeReason !== null && codeReason !== "timeout");
  const hasSessionLock = hasSessionWriteLockTimeout(err);

  const classification = classifyFailoverSignal(signal);
  const nestedCandidates = getNestedErrorCandidates(err);

  if (!classification || classification.kind === "context_overflow") {
    for (const candidate of nestedCandidates) {
      const nestedClassification = resolveFailoverClassificationFromErrorInternal(
        candidate,
        seen,
        depth + 1,
        providerHint,
      );
      if (nestedClassification) {
        if (hasSessionLock && !hasExplicitFailoverMetadata) {
          return null;
        }
        return nestedClassification;
      }
    }
  }

  if (isFormatClassification(classification)) {
    for (const candidate of nestedCandidates) {
      const shouldClearFormat = decideNestedFormatOverride(
        candidate,
        signal.status,
        seen,
        depth + 1,
      );
      if (shouldClearFormat === true) {
        return null;
      }
      if (shouldClearFormat === false) {
        break;
      }
    }
  }

  if (classification) {
    if (hasSessionLock && !hasExplicitFailoverMetadata) {
      return null;
    }
    return classification;
  }

  if (hasSessionLock) {
    return null;
  }

  if (isTimeoutError(err)) {
    return {
      kind: "reason",
      reason: "timeout",
    };
  }
  return null;
}

function resolveFailoverClassificationFromError(
  err: unknown,
  providerHint?: string,
): FailoverClassification | null {
  return resolveFailoverClassificationFromErrorInternal(err, new Set<object>(), 0, providerHint);
}

export function resolveFailoverReasonFromError(
  err: unknown,
  providerHint?: string,
): FailoverReason | null {
  return failoverReasonFromClassification(
    resolveFailoverClassificationFromError(err, providerHint),
  );
}

export function describeFailoverError(err: unknown): {
  message: string;
  rawError?: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
  provider?: string;
  model?: string;
  profileId?: string;
  sessionId?: string;
  lane?: string;
} {
  if (isFailoverError(err)) {
    return {
      message: err.message,
      rawError: err.rawError,
      reason: err.reason,
      status: err.status,
      code: err.code,
      provider: err.provider,
      model: err.model,
      profileId: err.profileId,
      sessionId: err.sessionId,
      lane: err.lane,
    };
  }
  const signal = normalizeErrorSignal(err);
  const message = signal.message ?? String(err);
  return {
    message,
    reason: resolveFailoverReasonFromError(err) ?? undefined,
    status: signal.status,
    code: signal.code,
    provider: signal.provider,
  };
}

export function coerceToFailoverError(
  err: unknown,
  context?: {
    provider?: string;
    model?: string;
    profileId?: string;
    sessionId?: string;
    lane?: string;
  },
): FailoverError | null {
  if (isFailoverError(err)) {
    return err;
  }
  const reason = resolveFailoverReasonFromError(err, context?.provider);
  if (!reason) {
    return null;
  }

  const signal = normalizeErrorSignal(err);
  const message = signal.message ?? String(err);
  const status = signal.status ?? resolveFailoverStatus(reason);
  const code = signal.code;

  // Suspend when hitting rate limits or billing issues in an attributed session
  const shouldSuspend =
    Boolean(context?.sessionId) && (reason === "rate_limit" || reason === "billing");

  return new FailoverError(message, {
    reason,
    provider: context?.provider ?? signal.provider,
    model: context?.model,
    profileId: context?.profileId,
    sessionId: context?.sessionId,
    lane: context?.lane,
    status,
    code,
    rawError: message,
    cause: err instanceof Error ? err : undefined,
    suspend: shouldSuspend,
  });
}
