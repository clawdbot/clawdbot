/**
 * Provider/model failover error classification.
 * Converts nested provider, transport, timeout, auth, and local coordination
 * failures into structured failover reasons and remediation metadata.
 */
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { formatCliCommand } from "../cli/command-format.js";
import { isAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import { collectErrorGraphCandidates, formatErrorMessage, readErrorName } from "../infra/errors.js";
import { failoverReasonFromClassification } from "./failover/classification-rules.js";
import {
  classifyFailoverSignal,
  extractFailoverSignalDetails,
  isProviderRequestSizeCeilingError,
  isUnclassifiedNoBodyHttpSignal,
} from "./failover/classify.js";
import {
  FailoverError,
  findErrorProperty,
  getErrorMessage,
  isFailoverError,
  isTimeoutError,
  readDirectErrorMessage,
  type CliTimeoutContext,
} from "./failover/error.js";
import type { FailoverClassification, FailoverReason, FailoverSignal } from "./failover/signal.js";
import { AgentHarnessSessionSupersededError } from "./harness/errors.js";

export {
  FailoverError,
  isFailoverError,
  isSignalTimeoutReason,
  isTimeoutError,
  type CliTimeoutContext,
  type FallbackAttemptRecord,
} from "./failover/error.js";

const MAX_FAILOVER_CAUSE_DEPTH = 25;
const MISSING_TOOL_RESULT_REASON = "missing_tool_result";
const MISSING_TOOL_RESULT_TEXT_RE = /native Codex tool\.call without a matching tool\.result/i;
const RUNTIME_COORDINATION_ERROR_NAMES = new Set([
  "GatewayDrainingError",
  "WorkerRunnerUnavailableError",
  "WorkerRunnerCapacityError",
  "WorkerWorkspaceReconciliationError",
]);

function resolveNestedErrors(candidate: Record<string, unknown>): unknown[] {
  const errors = candidate.errors;
  return [candidate.error, candidate.cause, ...(Array.isArray(errors) ? errors : [])];
}

/**
 * True when the provider refused the request for its own size rather than for context pressure or
 * bucket state.  An error that never became a `FailoverError` still carries the provider's text in
 * its message, so it is read directly.
 */
export function hasProviderRequestSizeCeiling(err: unknown): boolean {
  return collectErrorGraphCandidates(err, resolveNestedErrors).some((candidate) =>
    isFailoverError(candidate)
      ? candidate.requestSizeCeiling
      : isProviderRequestSizeCeilingError(formatErrorMessage(candidate)),
  );
}

function findCliFailoverError<T extends FailoverError>(
  err: unknown,
  match: (error: FailoverError) => T | undefined,
  seen: Set<object>,
): T | undefined {
  const direct = isFailoverError(err) ? match(err) : undefined;
  if (direct) {
    return direct;
  }
  if (!err || typeof err !== "object" || seen.has(err)) {
    return undefined;
  }
  // Preserve depth-first error/cause/aggregate order for both CLI facts,
  // including a terminal run wrapped by a fork-persistence failure.
  seen.add(err);
  for (const value of resolveNestedErrors(err as Record<string, unknown>)) {
    const found = findCliFailoverError(value, match, seen);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function findCliMaxTurnsError(err: unknown): FailoverError | undefined {
  return findCliFailoverError(
    err,
    (error) => (error.code === "cli_max_turns" ? error : undefined),
    new Set(),
  );
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
): (FailoverError & { cliTimeout: CliTimeoutContext }) | undefined {
  return findCliFailoverError(
    err,
    (error) => (hasCliTimeoutContext(error) ? error : undefined),
    new Set(),
  );
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
    case "tls_certificate":
      return 502;
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

function hasSessionTranscriptWriterClaimRebound(
  err: unknown,
  seen: Set<object> = new Set(),
): boolean {
  if (
    err &&
    typeof err === "object" &&
    readErrorName(err) === "SessionTranscriptWriterClaimReboundError"
  ) {
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
    hasSessionTranscriptWriterClaimRebound(candidate.error, seen) ||
    hasSessionTranscriptWriterClaimRebound(candidate.cause, seen) ||
    hasSessionTranscriptWriterClaimRebound(candidate.reason, seen)
  );
}

function readField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readErrorStringField(value: unknown, key: string): string | undefined {
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
    const value = readErrorStringField(err, key);
    if (value && isMissingToolResultMarker(value)) {
      return true;
    }
  }
  const output = readErrorStringField(err, "output");
  if (output && isMissingToolResultMessage(output)) {
    return true;
  }
  const resultReason = readErrorStringField(readField(err, "result"), "reason");
  const detailReason = readErrorStringField(readField(err, "detail"), "reason");
  if (resultReason === MISSING_TOOL_RESULT_REASON || detailReason === MISSING_TOOL_RESULT_REASON) {
    return true;
  }
  return undefined;
}

function hasMissingToolResultFailure(err: unknown): boolean {
  return findErrorProperty(err, readMissingToolResultMarker) === true;
}

function hasStaleAgentRunLifecycleFailure(err: unknown): boolean {
  return (
    findErrorProperty(err, (candidate) =>
      isAgentRunStaleLifecycleError(candidate) ? true : undefined,
    ) === true
  );
}

function hasRuntimeCoordinationFailure(err: unknown): boolean {
  return collectErrorGraphCandidates(err, resolveNestedErrors).some((candidate) =>
    RUNTIME_COORDINATION_ERROR_NAMES.has(readErrorName(candidate)),
  );
}

function hasDirectProviderFailureIdentity(err: unknown): boolean {
  if (isFailoverError(err)) {
    return true;
  }
  const signal = normalizeDirectErrorSignal(err);
  return Boolean(signal.status || signal.code || signal.errorType || signal.provider);
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
    return classification;
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
  if (provider === "google-gemini-cli") {
    return `Authenticate in Gemini CLI directly, or configure a supported Google API key with: ${formatCliCommand("openclaw configure")}`;
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
  | { kind: "terminal"; error: unknown }
  | { kind: "coordination"; error: unknown }
  | { kind: "unknown"; error: unknown };

/** Convert a classified raw error into a FailoverError with optional request context. */
export function coerceToFailoverError(
  err: unknown,
  context?: FailoverErrorContext,
): FailoverError | null {
  if (isFailoverError(err)) {
    if (context?.authMode && !err.authMode) {
      const message = typeof err.message === "string" ? err.message : String(err);
      return new FailoverError(message, {
        reason: err.reason,
        provider: err.provider,
        model: err.model,
        profileId: err.profileId,
        authMode: context.authMode,
        status: err.status,
        code: err.code,
        rawError: err.rawError,
        authProfileFailure: err.authProfileFailure,
        sessionId: err.sessionId,
        lane: err.lane,
        cause: err.cause,
        suspend: err.suspend,
        cliTimeout: err.cliTimeout,
        attempts: err.attempts,
        soonestCooldownExpiry: err.soonestCooldownExpiry,
      });
    }
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
  // Gateway admission can fail before any provider turn starts. Preserve that
  // identity through wrappers and aggregates so fallback cannot blame a model.
  if (hasRuntimeCoordinationFailure(err)) {
    return { kind: "coordination", error: err };
  }
  const staleLifecycleFailure = hasStaleAgentRunLifecycleFailure(err);
  if (
    staleLifecycleFailure &&
    (isAgentRunStaleLifecycleError(err) || !hasDirectProviderFailureIdentity(err))
  ) {
    return { kind: "coordination", error: err };
  }
  // The in-transaction transcript fence owns writer supersession. A rebound is
  // local coordination failure even when provider-looking wrappers contain it.
  if (hasSessionTranscriptWriterClaimRebound(err)) {
    return { kind: "coordination", error: err };
  }
  // Recorded terminal stops prohibit replay regardless of provider policy.
  // Keep the wrapper identity before coercion can discard the terminal fact.
  if (findCliMaxTurnsError(err)) {
    return { kind: "terminal", error: err };
  }
  const failoverError = coerceToFailoverError(err, context);
  if (failoverError) {
    return { kind: "failover", error: failoverError };
  }
  if (hasMissingToolResultFailure(err) || staleLifecycleFailure) {
    return { kind: "coordination", error: err };
  }
  return { kind: "unknown", error: err };
}
