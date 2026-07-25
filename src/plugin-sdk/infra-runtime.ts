/**
 * @deprecated Compatibility shim only. Keep old plugins working, but do not
 * add new imports here and do not use this subpath from repo code.
 * Prefer focused openclaw/plugin-sdk/<domain> runtime subpaths instead.
 */

export * from "./delivery-queue-runtime.js";

export * from "../infra/backoff.js";
export * from "../infra/channel-activity.js";
export * from "../infra/dedupe.js";
export type * from "../infra/diagnostic-events.js";
export {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  isDiagnosticsEnabled,
  onDiagnosticEvent,
} from "../infra/diagnostic-events.js";
export * from "../infra/diagnostic-flags.js";
export * from "../infra/env.js";
export * from "../infra/errors.js";
import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";

/** @deprecated Shipped compat only (removed from core in #104546); no core caller. Removal with the next plugin-SDK major. */
export type ErrorKind = "refusal" | "timeout" | "rate_limit" | "context_length" | "unknown";

/**
 * @deprecated Shipped compat only; preserves the old substring semantics for
 * external plugins. Core chat classification now maps canonical failover
 * reasons (see gateway resolveChatErrorKindFromError). Removal with the next
 * plugin-SDK major.
 */
export function detectErrorKind(err: unknown): ErrorKind | undefined {
  if (err === undefined) {
    return undefined;
  }
  const message = formatErrorMessage(err).toLowerCase();
  const code = extractErrorCode(err)?.toLowerCase();
  if (
    message.includes("refusal") ||
    message.includes("content_filter") ||
    message.includes("sensitive") ||
    message.includes("unhandled stop reason: refusal_policy")
  ) {
    return "refusal";
  }
  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    code === "429"
  ) {
    return "rate_limit";
  }
  if (message.includes("timeout") || code === "etimedout" || code === "timeout") {
    return "timeout";
  }
  if (
    message.includes("context length") ||
    message.includes("too many tokens") ||
    message.includes("token limit") ||
    message.includes("context_window")
  ) {
    return "context_length";
  }
  return undefined;
}
export * from "../infra/exec-approval-command-display.ts";
export * from "../infra/exec-approval-channel-runtime.ts";
export * from "../infra/exec-approval-reply.ts";
export * from "../infra/exec-approval-session-target.ts";
// Keep this deprecated barrel pinned to its shipped approval surface. Internal
// store/locking exports must not become plugin contracts accidentally.
export {
  addAllowlistEntry,
  addDurableCommandApproval,
  analyzeArgvCommand,
  analyzeWindowsShellCommand,
  buildEnforcedShellCommand,
  commandRequiresSecurityAuditSuppressionApproval,
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  DEFAULT_EXEC_APPROVAL_DECISIONS,
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  ensureExecApprovals,
  evaluateExecAllowlist,
  evaluateExecAllowlistWithAuthorization,
  evaluateShellAllowlist,
  evaluateShellAllowlistWithAuthorization,
  EXEC_TARGET_VALUES,
  hasDurableExecApproval,
  hasExactCommandDurableExecApproval,
  hasNodeCommandAllowAlwaysMarker,
  isExecApprovalDecisionAllowed,
  isSafeBinUsage,
  isWindowsPlatform,
  loadExecApprovals,
  matchAllowlist,
  maxAsk,
  mergeExecApprovalsSocketDefaults,
  minSecurity,
  normalizeExecApprovals,
  normalizeExecApprovalUnavailableDecisions,
  normalizeExecAsk,
  normalizeExecHost,
  normalizeExecMode,
  normalizeExecSecurity,
  normalizeExecTarget,
  normalizeSafeBins,
  OPTIONAL_EXEC_APPROVAL_DECISIONS,
  parseExecArgvToken,
  persistAllowAlwaysDecision,
  persistAllowAlwaysPatterns,
  readExecApprovalsSnapshot,
  recordAllowlistMatchesUse,
  recordAllowlistUse,
  requestExecApprovalViaSocket,
  requiresExecApproval,
  requireValidExecTarget,
  resolveAllowAlwaysPatternCoverage,
  resolveAllowAlwaysPatternEntries,
  resolveAllowAlwaysPatterns,
  resolveAllowAlwaysPersistenceDecision,
  resolveAllowlistCandidatePath,
  resolveApprovalAuditCandidatePath,
  resolveApprovalAuditTrustPath,
  resolveCommandResolution,
  resolveCommandResolutionFromArgv,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalRequestAllowedDecisions,
  resolveExecApprovals,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsFromFile,
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
  resolveExecApprovalsTranscriptPath,
  resolveExecApprovalUnavailableDecisions,
  resolveExecModeFromPolicy,
  resolveExecModePolicy,
  resolveExecPolicyForMode,
  resolveExecutableTrustPath,
  resolveExecutionTargetCandidatePath,
  resolveExecutionTargetResolution,
  resolveExecutionTargetTrustPath,
  resolvePlannedSegmentArgv,
  resolvePolicyAllowlistCandidatePath,
  resolvePolicyTargetCandidatePath,
  resolvePolicyTargetResolution,
  resolvePolicyTargetTrustPath,
  resolveSafeBins,
  restoreExecApprovalsSnapshot,
  saveExecApprovals,
  tokenizeWindowsSegment,
  windowsEscapeArg,
  type AllowAlwaysPattern,
  type AllowAlwaysPersistenceDecision,
  type AllowAlwaysPersistenceReason,
  type CommandResolution,
  type ExecAllowlistAnalysis,
  type ExecAllowlistEntry,
  type ExecAllowlistEvaluation,
  type ExecApprovalCommandSpan,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprovalRequestPayload,
  type ExecApprovalResolved,
  type ExecApprovalsAgent,
  type ExecApprovalsDefaultOverrides,
  type ExecApprovalsDefaults,
  type ExecApprovalsFile,
  type ExecApprovalsResolved,
  type ExecApprovalsSnapshot,
  type ExecApprovalUnavailableDecision,
  type ExecArgvToken,
  type ExecAsk,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
  type ExecHost,
  type ExecMode,
  type ExecSecurity,
  type ExecSegmentSatisfiedBy,
  type ExecTarget,
  type ExecutableResolution,
  type ShellChainOperator,
  type SkillBinTrustEntry,
  type SystemRunApprovalBinding,
  type SystemRunApprovalFileOperand,
  type SystemRunApprovalPlan,
} from "../infra/exec-approvals.js";
export * from "../infra/approval-native-delivery.ts";
export * from "../infra/approval-native-runtime.ts";
export * from "../infra/approval-display-paths.ts";
export * from "../infra/plugin-approvals.ts";
export * from "../infra/fetch.js";
export * from "../infra/file-lock.js";
export * from "../infra/format-time/format-duration.ts";
export * from "../infra/fs-safe.ts";
export * from "../infra/heartbeat-events.ts";
export * from "../infra/heartbeat-summary.ts";
export * from "../infra/heartbeat-visibility.ts";
export * from "../infra/home-dir.js";
// Keep this deprecated barrel pinned to its shipped request-body surface; new
// response readers belong only to the focused response-limit/media entrypoints.
export {
  __test__,
  DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  installRequestBodyLimitGuard,
  isRequestBodyLimitError,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
  RequestBodyLimitError,
  testApi,
  type ReadJsonBodyOptions,
  type ReadJsonBodyResult,
  type ReadRequestBodyOptions,
  type RequestBodyLimitErrorCode,
  type RequestBodyLimitGuard,
  type RequestBodyLimitGuardOptions,
} from "../infra/http-body.js";
export * from "../infra/json-files.js";
export * from "../infra/local-file-access.js";
export * from "../infra/map-size.js";
export * from "../infra/net/hostname.ts";
export {
  fetchWithRuntimeDispatcher,
  fetchWithSsrFGuard,
  GUARDED_FETCH_MODE,
  retainSafeHeadersForCrossOriginRedirectHeaders,
  withStrictGuardedFetchMode,
  withTrustedEnvProxyGuardedFetchMode,
  withTrustedExplicitProxyGuardedFetchMode,
  type GuardedFetchMode,
  type GuardedFetchOptions,
  type GuardedFetchResult,
} from "../infra/net/fetch-guard.js";
export * from "../infra/net/proxy-env.js";
export * from "../infra/net/proxy-fetch.js";
export * from "../infra/net/undici-global-dispatcher.js";
export * from "../infra/net/ssrf.js";
export * from "../infra/outbound/identity.js";
export * from "../infra/outbound/sanitize-text.js";
export * from "../infra/parse-finite-number.js";
export * from "../infra/outbound/send-deps.js";
export * from "../infra/retry.js";
export * from "../infra/retry-policy.js";
export * from "../infra/scp-host.ts";
export * from "../infra/secret-file.js";
export * from "../infra/secure-random.js";
export * from "../infra/system-events.js";
export * from "../infra/system-message.ts";
export * from "../infra/tmp-openclaw-dir.js";
export * from "../infra/transport-ready.js";
export * from "../infra/wsl.ts";
export * from "../utils/fetch-timeout.js";
export * from "../utils/run-with-concurrency.js";
export { createRuntimeOutboundDelegates } from "../channels/plugins/runtime-forwarders.js";
export * from "./ssrf-policy.js";
