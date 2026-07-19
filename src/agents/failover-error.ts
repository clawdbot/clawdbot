/**
 * Provider/model failover error classification.
 * Converts nested provider, transport, timeout, auth, and local coordination
 * failures into structured failover reasons and remediation metadata.
 */
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { formatCliCommand } from "../cli/command-format.js";
import { readErrorName } from "../infra/errors.js";
import {
  classifyFailoverSignal,
  extractFailoverSignalDetails,
  inferSignalStatus,
  isUnclassifiedNoBodyHttpSignal,
  type FailoverClassification,
  type FailoverSignal,
} from "./embedded-agent-helpers/errors.js";
import { isTimeoutErrorMessage } from "./embedded-agent-helpers/errors.js";
import type { FailoverReason } from "./embedded-agent-helpers/types.js";
import { AgentHarnessSessionSupersededError } from "./harness/errors.js";
import { isSessionWriteLockAcquireError } from "./session-write-lock-error.js";

const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;
const MAX_FAILOVER_CAUSE_DEPTH = 25;
const MISSING_TOOL_RESULT_REASON = "missing_tool_result";
const MISSING_TOOL_RESULT_TEXT_RE = /native Codex tool\.call without a matching tool\.result/i;

export type CliTimeoutContext = {
  mode: "overall" | "no-output";
  timeoutSeconds: number;
  observedActivity: boolean;
  activeToolCount: number;
  backgroundTaskCount: number;
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
  readonly authProfileFailure?: { allInCooldown: boolean };
  // Originating request attribution propagated through wrapper errors so
  // structured log ingestion (e.g. api_health_log) can attribute exhausted
  // failover failures back to a session/lane and the last attempted provider.
  // See #42713.
  readonly sessionId?: string;
  readonly lane?: string;
  readonly suspend?: boolean;
  readonly cliTimeout?: CliTimeoutContext;

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
    this.authProfileFailure = params.authProfileFailure;
    this.sessionId = params.sessionId;
    this.lane = params.lane;
    this.suspend = params.suspend;
    this.cliTimeout = params.cliTimeout;
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
    (err as { name?: unknown }).name === "FailoverError" &&
    typeof (err as { reason?: unknown }).reason === "string",
  );
}

export function findCliMaxTurnsError(
  err: unknown,
  seen: Set<object> = new Set(),
): FailoverError | undefined {
  if (isFailoverError(err) && err.code === "cli_max_turns") {
    return err;
  }
  if (!err || typeof err !== "object" || seen.has(err)) {
    return undefined;
  }
  // Fork persistence can aggregate a terminal run error with its own failure.
  // Keep max-turn replay protection intact across those wrapper boundaries.
  seen.add(err);
  const candidate = err as { error?: unknown; cause?: unknown; errors?: unknown };
  const nested = [
    candidate.error,
    candidate.cause,
    ...(Array.isArray(candidate.errors) ? candidate.errors : []),
  ];
  for (const value of nested) {
    const found = findCliMaxTurnsError(value, seen);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function hasCliTimeoutContext(error: FailoverError): error is FailoverError & {
  cliTimeout: CliTimeoutContext;
} {
  const context = error.cliTimeout;
  return Boolean(
    context &&
    (context.mode === "overall" || context.mode === "no-output") &&
    Number.isFinite(context.timeoutSeconds) &&
    context.timeoutSeconds >= 0 &&
    typeof context.observedActivity === "boolean" &&
    Number.isInteger(context.activeToolCount) &&
    context.activeToolCount >= 0 &&
    Number.isInteger(context.backgroundTaskCount) &&
    context.backgroundTaskCount >= 0,
  );
}

export function findCliTimeoutError(
  err: unknown,
  seen: Set<object> = new Set(),
): (FailoverError & { cliTimeout: CliTimeoutContext }) | undefined {
  if (isFailoverError(err) && hasCliTimeoutContext(err)) {
    return err;
  }
  if (!err || typeof err !== "object" || seen.has(err)) {
    return undefined;
  }
  // Failover summaries and persistence failures can wrap the terminal CLI error.
  seen.add(err);
  const candidate = err as { error?: unknown; cause?: unknown; errors?: unknown };
  const nested = [
    candidate.error,
    candidate.cause,
    ...(Array.isArray(candidate.errors) ? candidate.errors : []),
  ];
  for (const value of nested) {
    const found = findCliTimeoutError(value, seen);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Map a failover reason to the closest HTTP-like status code. */
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
    case "context_overflow":
      return 413;
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
  if (typeof candidate === "string") {
    return parseStrictNonNegativeInteger(candidate);
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
  const detailCode = (err as { detail?: { code?: unknown } }).detail?.code;
  if (typeof detailCode === "string") {
    const trimmed = detailCode.trim();
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

function isStableProviderErrorType(value: string): boolean {
  if (
    /^(?:api|authentication|invalid_request|not_found|overloaded|permission|rate_limit|server)_error$/i.test(
      value,
    )
  ) {
    return false;
  }
  return /^[A-Z][A-Z0-9_:-]*$/.test(value);
}

function readDirectErrorType(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const directType = (err as { errorType?: unknown }).errorType;
  if (typeof directType === "string") {
    const trimmed = directType.trim();
    return trimmed && isStableProviderErrorType(trimmed) ? trimmed : undefined;
  }
  const detailType = (err as { detail?: { type?: unknown } }).detail?.type;
  if (typeof detailType === "string") {
    const trimmed = detailType.trim();
    return trimmed && isStableProviderErrorType(trimmed) ? trimmed : undefined;
  }
  const type = (err as { type?: unknown }).type;
  if (typeof type === "string") {
    const trimmed = type.trim();
    if (!trimmed || /^(?:error|exception)$/i.test(trimmed)) {
      return undefined;
    }
    return isStableProviderErrorType(trimmed) ? trimmed : undefined;
  }
  return undefined;
}

function getErrorType(err: unknown): string | undefined {
  return findErrorProperty(err, readDirectErrorType);
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

function readDirectErrorDetails(err: unknown): string[] | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = err as {
    body?: unknown;
    detail?: unknown;
    error?: unknown;
    errorBody?: unknown;
    param?: unknown;
  };
  return extractFailoverSignalDetails(
    candidate.param,
    candidate.errorBody,
    candidate.body,
    candidate.detail,
    candidate.error,
  );
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
    errorType: readDirectErrorType(err),
    message: message || undefined,
    provider: readDirectProvider(err),
    details: readDirectErrorDetails(err),
  };
}

function hasSessionWriteLockContention(err: unknown, seen: Set<object> = new Set()): boolean {
  if (isSessionWriteLockAcquireError(err)) {
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
    hasSessionWriteLockContention(candidate.error, seen) ||
    hasSessionWriteLockContention(candidate.cause, seen) ||
    hasSessionWriteLockContention(candidate.reason, seen)
  );
}

function isEmbeddedAttemptSessionTakeover(err: unknown): boolean {
  // Match by name to avoid importing embedded-agent-runner here (would create a cycle).
  return Boolean(
    err && typeof err === "object" && readErrorName(err) === "EmbeddedAttemptSessionTakeoverError",
  );
}

function hasPreservedTakeoverPromptError(err: unknown): err is Record<"promptError", unknown> {
  return Boolean(
    isEmbeddedAttemptSessionTakeover(err) &&
    err &&
    typeof err === "object" &&
    Object.hasOwn(err, "promptError"),
  );
}

function resolveFailoverSourceError(err: unknown): unknown {
  // Cleanup takeover is a secondary failure when the wrapper preserves the
  // prompt error. Classify and report that provider-facing source instead.
  return hasPreservedTakeoverPromptError(err) ? err.promptError : err;
}

function hasEmbeddedAttemptSessionTakeover(err: unknown, seen: Set<object> = new Set()): boolean {
  if (isEmbeddedAttemptSessionTakeover(err)) {
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
    hasEmbeddedAttemptSessionTakeover(candidate.error, seen) ||
    hasEmbeddedAttemptSessionTakeover(candidate.cause, seen) ||
    hasEmbeddedAttemptSessionTakeover(candidate.reason, seen)
  );
}

function readField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readStringField(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === "string" ? field : undefined;
}

function isMissingToolResultMessage(value: string): boolean {
  return MISSING_TOOL_RESULT_TEXT_RE.test(value);
}

function isMissingToolResultMarker(value: string): boolean {
  return value.trim() === MISSING_TOOL_RESULT_REASON;
}

function readMissingToolResultMarker(err: unknown): true | undefined {
  const message = readDirectErrorMessage(err);
  if (message && isMissingToolResultMessage(message)) {
    return true;
  }
  for (const key of ["code", "reason", "status"] as const) {
    const value = readStringField(err, key);
    if (value && isMissingToolResultMarker(value)) {
      return true;
    }
  }
  const output = readStringField(err, "output");
  if (output && isMissingToolResultMessage(output)) {
    return true;
  }
  const resultReason = readStringField(readField(err, "result"), "reason");
  const detailReason = readStringField(readField(err, "detail"), "reason");
  if (resultReason === MISSING_TOOL_RESULT_REASON || detailReason === MISSING_TOOL_RESULT_REASON) {
    return true;
  }
  return undefined;
}

function hasMissingToolResultFailure(err: unknown): boolean {
  return findErrorProperty(err, readMissingToolResultMarker) === true;
}

/**
 * True when the error is a local runtime coordination/tool-execution error
 * rather than a provider/model failure. The model fallback chain must abort on
 * these instead of consuming candidate slots — retrying any model would hit the
 * same local condition. See #83510 and #95474.
 */
export function isNonProviderRuntimeCoordinationError(err: unknown): boolean {
  return resolveModelFallbackError(err).kind === "coordination";
}

function hasTimeoutHint(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (hasSessionWriteLockContention(err)) {
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
  if (hasSessionWriteLockContention(err)) {
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

/** Return true when an abort-signal reason is an intentional timeout; plain AbortError is a cancellation, not a timeout. */
export function isSignalTimeoutReason(reason: unknown): boolean {
  return readErrorName(reason) === "TimeoutError";
}

function failoverReasonFromClassification(
  classification: FailoverClassification | null,
): FailoverReason | null {
  if (!classification) {
    return null;
  }
  return classification.kind === "reason" ? classification.reason : "context_overflow";
}

function normalizeErrorSignal(err: unknown, providerHint?: string): FailoverSignal {
  const message = getErrorMessage(err);
  return {
    status: getStatusCode(err),
    code: getErrorCode(err),
    errorType: getErrorType(err),
    message: message || undefined,
    provider: getProvider(err) ?? providerHint,
    details: readDirectErrorDetails(err),
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
  const hasSessionLock = hasSessionWriteLockContention(err);

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

/** Resolve the failover reason represented by an unknown provider/runtime error. */
export function resolveFailoverReasonFromError(
  err: unknown,
  providerHint?: string,
): FailoverReason | null {
  return failoverReasonFromClassification(
    resolveFailoverClassificationFromError(err, providerHint),
  );
}

/**
 * Build an actionable remediation hint for a failover error when the failure
 * reason is `auth` / `auth_permanent` and we have enough provider attribution
 * to suggest a re-authentication command. Returns `undefined` for any other
 * failure shape so callers can opportunistically append the hint without
 * branching on every reason themselves.
 *
 * Keep the string short and copy-pasteable — operators see it in fallback
 * summary errors and TUI status lines.
 */
export function buildFailoverRemediationHint(err: unknown): string | undefined {
  if (!isFailoverError(err)) {
    return undefined;
  }
  if (err.reason !== "auth" && err.reason !== "auth_permanent") {
    return undefined;
  }
  const provider = err.provider?.trim();
  if (!provider) {
    return undefined;
  }
  const command = buildProviderReauthCommand(provider);
  return command ? `Re-authenticate with: ${command}` : undefined;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Build the operator command for reauthenticating one provider. */
export function buildProviderReauthCommand(
  provider: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | undefined {
  const trimmed = provider.trim();
  if (!trimmed || hasControlCharacter(trimmed)) {
    return undefined;
  }
  return formatCliCommand(
    `openclaw models auth login --provider ${quotePosixShellArg(trimmed)} --force`,
    env,
  );
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Convert a failover or raw error into structured fields for logs/UI. */
export function describeFailoverError(err: unknown): {
  message: string;
  rawError?: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
  provider?: string;
  model?: string;
  profileId?: string;
  authMode?: string;
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
      authMode: err.authMode,
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

type FailoverErrorContext = {
  provider?: string;
  model?: string;
  profileId?: string;
  authMode?: string;
  sessionId?: string;
  lane?: string;
};

type ModelFallbackErrorResolution =
  | { kind: "failover"; error: FailoverError }
  | { kind: "coordination"; error: unknown }
  | { kind: "unknown"; error: unknown };

/** Convert a classified raw error into a FailoverError with optional request context. */
export function coerceToFailoverError(
  err: unknown,
  context?: FailoverErrorContext,
): FailoverError | null {
  const sourceError = resolveFailoverSourceError(err);
  if (isFailoverError(sourceError)) {
    if (context?.authMode && !sourceError.authMode) {
      const message =
        typeof sourceError.message === "string" ? sourceError.message : String(sourceError);
      return new FailoverError(message, {
        reason: sourceError.reason,
        provider: sourceError.provider,
        model: sourceError.model,
        profileId: sourceError.profileId,
        authMode: context.authMode,
        status: sourceError.status,
        code: sourceError.code,
        rawError: sourceError.rawError,
        authProfileFailure: sourceError.authProfileFailure,
        sessionId: sourceError.sessionId,
        lane: sourceError.lane,
        cause: sourceError.cause,
        suspend: sourceError.suspend,
      });
    }
    return sourceError;
  }
  const reason = resolveFailoverReasonFromError(sourceError, context?.provider);
  if (!reason) {
    return null;
  }

  const signal = normalizeErrorSignal(sourceError);
  const message = signal.message ?? String(sourceError);
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
    authMode: context?.authMode,
    sessionId: context?.sessionId,
    lane: context?.lane,
    status,
    code,
    rawError: message,
    cause: err instanceof Error ? err : undefined,
    suspend: shouldSuspend,
  });
}

/** Classify one candidate failure once so fallback routing and diagnostics share it. */
export function resolveModelFallbackError(
  err: unknown,
  context?: FailoverErrorContext,
): ModelFallbackErrorResolution {
  if (err instanceof AgentHarnessSessionSupersededError) {
    return { kind: "coordination", error: err };
  }
  // A direct takeover remains a coordination failure unless the dedicated
  // cleanup wrapper owns a preserved prompt error. Its message alone must not
  // reclassify session-state loss as a provider failure.
  if (isEmbeddedAttemptSessionTakeover(err) && !hasPreservedTakeoverPromptError(err)) {
    return { kind: "coordination", error: err };
  }
  const failoverError = coerceToFailoverError(err, context);
  if (failoverError) {
    return { kind: "failover", error: failoverError };
  }
  if (
    hasSessionWriteLockContention(err) ||
    hasEmbeddedAttemptSessionTakeover(err) ||
    hasMissingToolResultFailure(err)
  ) {
    return { kind: "coordination", error: err };
  }
  return { kind: "unknown", error: err };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
