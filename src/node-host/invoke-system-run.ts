/** Policy and execution pipeline for approved node-host system.run requests. */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  describeInterpreterInlineEval,
  type InterpreterInlineEvalHit,
} from "../infra/command-analysis/inline-eval.js";
import { detectPolicyInlineEval } from "../infra/command-analysis/policy.js";
import { createDedupeCache } from "../infra/dedupe.js";
import {
  commitExecAuthorizationLocked,
  commandRequiresSecurityAuditSuppressionApproval,
  createExecApprovalPolicySnapshot,
  hasDurableExecApproval,
  isExecApprovalPolicySnapshotCurrent,
  maxAsk,
  minSecurity,
  resolveApprovalAuditTrustPath,
  resolveAllowAlwaysPersistenceDecision,
  resolveDurableExecApprovalRequirement,
  resolveExecApprovalsLocked,
  type ExecAllowlistEntry,
  type ExecApprovalUsageAuthorization,
  type ExecApprovalPolicySnapshot,
  type ExecApprovalsResolved,
  type ExecAsk,
  type ExecCommandSegment,
  type ExecSegmentSatisfiedBy,
  type ExecSecurity,
  type SkillBinTrustEntry,
} from "../infra/exec-approvals.js";
import type { ExecAuthorizationPlan } from "../infra/exec-authorization-plan.js";
import { resolveExecAutoReviewDecision, type ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { ExecHostRequest, ExecHostResponse, ExecHostRunResult } from "../infra/exec-host.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import {
  extractEnvAssignmentKeysFromDispatchWrappers,
  isBlockedShellWrapperCommand,
  isShellWrapperInvocation,
  resolveShellWrapperTransportArgv,
} from "../infra/exec-wrapper-resolution.js";
import {
  inspectHostExecEnvOverrides,
  sanitizeSystemRunEnvOverrides,
} from "../infra/host-env-security.js";
import {
  APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
  normalizeSystemRunApprovalPlan,
  revalidateApprovedMutableFileOperand,
  resolveMutableFileOperandSnapshotSync,
} from "../infra/system-run-approval-binding.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "../infra/system-run-command.js";
import {
  APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
  type ApprovedCwdSnapshot,
  captureApprovedCwdSnapshotSync,
  revalidateApprovedCwdSnapshot,
} from "../infra/system-run-cwd-binding.js";
import { logWarn } from "../logger.js";
import type { NodeHostClient } from "./client.js";
import {
  evaluateSystemRunPolicy,
  resolveExecApprovalDecision,
  resolveNodeExecConfigPolicy,
} from "./exec-policy.js";
import {
  applyOutputTruncation,
  evaluateSystemRunAllowlist,
  resolvePlannedAllowlistArgv,
  resolveSystemRunExecArgv,
} from "./invoke-system-run-allowlist.js";
import { hardenApprovedExecutionPaths } from "./invoke-system-run-plan.js";
import type {
  ExecEventPayload,
  ExecFinishedResult,
  ExecFinishedEventParams,
  RunResult,
  SkillBinsProvider,
  SystemRunParams,
} from "./invoke-types.js";

type SystemRunInvokeResult = {
  ok: boolean;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

type SystemRunDeniedReason =
  | "security=deny"
  | "approval-required"
  | "approval-state-write-failed"
  | "allowlist-miss"
  | "execution-plan-miss"
  | "companion-unavailable"
  | "cwd-unavailable"
  | "permission:screenRecording";

type SystemRunExecutionContext = {
  sessionKey: string;
  runId: string;
  commandText: string;
  suppressNotifyOnExit: boolean;
};

type SystemRunParsePhase = {
  argv: string[];
  shellPayload: string | null;
  shellWrapperInvocation: boolean;
  commandText: string;
  commandPreview: string | null;
  approvalPlan: import("../infra/exec-approvals.js").SystemRunApprovalPlan | null;
  agentId: string | undefined;
  sessionKey: string;
  runId: string;
  execution: SystemRunExecutionContext;
  approvalDecision: ReturnType<typeof resolveExecApprovalDecision>;
  approvalSource: "ask-fallback" | "auto-review" | undefined;
  delayedApprovalPolicySnapshot: ExecApprovalPolicySnapshot | null;
  envOverrides: Record<string, string> | undefined;
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  timeoutMs: number | undefined;
  needsScreenRecording: boolean;
  approved: boolean;
};

type SystemRunPolicyPhase = SystemRunParsePhase & {
  approvals: ExecApprovalsResolved;
  evaluationPolicySnapshot: ExecApprovalPolicySnapshot;
  security: ExecSecurity;
  ask: ExecAsk;
  policy: ReturnType<typeof evaluateSystemRunPolicy>;
  approvalGrantSource: "explicit-approval" | "auto-review" | null;
  durableApprovalSatisfied: boolean;
  durableApprovalRequirement: ReturnType<typeof resolveDurableExecApprovalRequirement>;
  strictInlineEval: boolean;
  inlineEvalHit: InterpreterInlineEvalHit | null;
  allowlistMatches: ExecAllowlistEntry[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  allowlistAuthorizationSatisfied: boolean;
  safeBins: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBins"];
  safeBinProfiles: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBinProfiles"];
  trustedSafeBinDirs: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["trustedSafeBinDirs"];
  skillBins: SkillBinTrustEntry[];
  autoAllowSkills: boolean;
  segments: ExecCommandSegment[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
  authorizationPlan: ExecAuthorizationPlan | undefined;
  plannedAllowlistArgv: string[] | undefined;
  isWindows: boolean;
  approvedCwdSnapshot: ApprovedCwdSnapshot | undefined;
};

const safeBinTrustedDirWarningCache = createDedupeCache({
  ttlMs: 0,
  maxSize: 4096,
});
const APPROVAL_SCRIPT_OPERAND_BINDING_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval missing script operand binding";
const APPROVAL_STATE_WRITE_FAILED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval state could not be persisted";
type ExecToolConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["exec"]>;

type EffectiveSystemRunExecPolicy = {
  agentExec: ExecToolConfig | undefined;
  globalExec: ExecToolConfig | undefined;
  approvals: ExecApprovalsResolved;
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview: boolean;
};

function warnWritableTrustedDirOnce(message: string): void {
  if (safeBinTrustedDirWarningCache.check(message)) {
    return;
  }
  logWarn(message);
}

function normalizeDeniedReason(reason: string | null | undefined): SystemRunDeniedReason {
  switch (reason) {
    case "security=deny":
    case "approval-required":
    case "allowlist-miss":
    case "execution-plan-miss":
    case "companion-unavailable":
    case "cwd-unavailable":
    case "permission:screenRecording":
      return reason;
    default:
      return "approval-required";
  }
}

/** Resolves the effective exec security/ask policy for one system.run request. */
export async function resolveEffectiveSystemRunExecPolicy(params: {
  cfg: OpenClawConfig;
  agentId: string | undefined;
  defaultSecurity: ExecSecurity;
  defaultAsk: ExecAsk;
  requireSocket: boolean;
}): Promise<EffectiveSystemRunExecPolicy> {
  const modePolicy = resolveNodeExecConfigPolicy(params);
  const { agentExec, globalExec } = modePolicy;
  const approvals = await resolveExecApprovalsLocked(params.agentId, {
    security: modePolicy.security,
    ask: modePolicy.ask,
    requireSocket: params.requireSocket,
  });
  return {
    agentExec,
    globalExec,
    approvals,
    security: minSecurity(modePolicy.security, approvals.agent.security),
    ask: maxAsk(modePolicy.ask, approvals.agent.ask),
    autoReview: modePolicy.autoReview,
  };
}

async function resolveSystemRunAutoReviewer(params: {
  opts: HandleSystemRunInvokeOptions;
  cfg: OpenClawConfig;
  agentId: string | undefined;
  agentExec: ExecToolConfig | undefined;
  globalExec: ExecToolConfig | undefined;
}): Promise<ExecAutoReviewer> {
  if (params.opts.autoReviewer) {
    return params.opts.autoReviewer;
  }
  const { createModelExecAutoReviewer } = await import("../agents/exec-auto-reviewer.js");
  return createModelExecAutoReviewer({
    cfg: params.cfg,
    agentId: params.agentId,
    reviewer: params.agentExec?.reviewer ?? params.globalExec?.reviewer,
  });
}

type HandleSystemRunInvokeOptions = {
  client: NodeHostClient;
  params: SystemRunParams;
  skillBins: SkillBinsProvider;
  signal?: AbortSignal;
  execHostEnforced: boolean;
  execHostFallbackAllowed: boolean;
  resolveExecSecurity: (value?: string) => ExecSecurity;
  resolveExecAsk: (value?: string) => ExecAsk;
  isCmdExeInvocation: (argv: string[]) => boolean;
  sanitizeEnv: (overrides?: Record<string, string> | null) => Record<string, string> | undefined;
  runCommand: (
    argv: string[],
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ) => Promise<RunResult>;
  runViaMacAppExecHost: (params: {
    approvals: ExecApprovalsResolved;
    request: ExecHostRequest;
    signal?: AbortSignal;
  }) => Promise<ExecHostResponse | null>;
  sendNodeEvent: (client: NodeHostClient, event: string, payload: unknown) => Promise<void>;
  buildExecEventPayload: (payload: ExecEventPayload) => ExecEventPayload;
  sendInvokeResult: (result: SystemRunInvokeResult) => Promise<void>;
  sendExecFinishedEvent: (params: ExecFinishedEventParams) => Promise<void>;
  preferMacAppExecHost: boolean;
  getRuntimeConfig?: () => OpenClawConfig;
  autoReviewer?: ExecAutoReviewer;
  commitExecAuthorization?: typeof commitExecAuthorizationLocked;
};

async function loadSystemRunConfig(opts: HandleSystemRunInvokeOptions): Promise<OpenClawConfig> {
  if (opts.getRuntimeConfig) {
    return opts.getRuntimeConfig();
  }
  const { getRuntimeConfig } = await import("../config/config.js");
  return getRuntimeConfig();
}

async function sendSystemRunDenied(
  opts: Pick<
    HandleSystemRunInvokeOptions,
    "client" | "sendNodeEvent" | "buildExecEventPayload" | "sendInvokeResult"
  >,
  execution: SystemRunExecutionContext,
  params: {
    reason: SystemRunDeniedReason;
    message: string;
    /** Suppress for host-authored freeform messages (mac app exec host), where
     * the generic policy hint may mislabel a transient outcome. */
    suppressEscalationHint?: boolean;
    /** "binding" routes to renewal guidance instead of the policy hint:
     * approval-binding integrity failures (cwd/script drift, binding capture)
     * are corrected by re-requesting approval for the current operand, not by
     * an exec-policy change. */
    escalationOwner?: "binding";
  },
) {
  await opts.sendNodeEvent(
    opts.client,
    "exec.denied",
    opts.buildExecEventPayload({
      sessionKey: execution.sessionKey,
      runId: execution.runId,
      host: "node",
      command: execution.commandText,
      reason: params.reason,
      suppressNotifyOnExit: execution.suppressNotifyOnExit,
    }),
  );
  await opts.sendInvokeResult({
    ok: false,
    // A missing companion reply can follow execution; it is not a policy denial.
    error: {
      code: params.reason === "companion-unavailable" ? "UNAVAILABLE" : "SYSTEM_RUN_DENIED",
      message: params.suppressEscalationHint
        ? params.message
        : deniedMessageWithEscalationHint({
            reason: params.reason,
            message: params.message,
            ...(params.escalationOwner ? { escalation: params.escalationOwner } : {}),
          }),
    },
  });
}

/**
 * Appended to model-facing denials so the sanctioned path is taught at the decision
 * point; without it the agent's next move is unguided and retries burn turns.
 */
const SYSTEM_RUN_DENIED_ESCALATION_HINT =
  "to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again";

/**
 * Appended to approval-binding integrity denials instead of the policy hint:
 * the approved binding no longer matches the execution, and the sanctioned
 * correction is renewing the approval — policy-relaxation guidance would send
 * the model (and the operator) after the wrong lever.
 */
const SYSTEM_RUN_DENIED_BINDING_HINT =
  "the approved binding no longer matches this execution; request approval again for the current command";

/** Denial reasons that an exec-policy change actually corrects. */
const POLICY_OWNED_DENIED_REASONS = new Set<SystemRunDeniedReason>([
  "security=deny",
  "approval-required",
  "allowlist-miss",
  "execution-plan-miss",
]);

/**
 * Structured policy reasons the mac app exec host's final policy evaluator
 * emits verbatim; recognized host responses keep the escalation hint while
 * freeform ones (cancelled prompt, unavailable approval store, permission
 * prompts) are suppressed.
 */
const MAC_HOST_POLICY_OWNED_REASONS = new Set(["security=deny", "allowlist-miss"]);

function deniedMessageWithEscalationHint(params: {
  reason: SystemRunDeniedReason;
  message: string;
  /** Explicit owner override from the denial site; see sendSystemRunDenied. */
  escalation?: "binding";
}): string {
  // Binding-owned denials get renewal guidance, never policy relaxation.
  if (params.escalation === "binding") {
    return `${params.message} — ${SYSTEM_RUN_DENIED_BINDING_HINT}`;
  }
  // Only policy-owned denials carry the hint: transient outcomes
  // (approval-state-write-failed), infrastructure availability
  // (companion-unavailable), OS permission grants (permission:screenRecording)
  // are all fixed by something other than an exec-policy change, and the
  // hint's "identical retry will be denied" claim would be wrong for them.
  if (!POLICY_OWNED_DENIED_REASONS.has(params.reason)) {
    return params.message;
  }
  // Already carries its own next-step guidance; a generic hint would contradict it.
  if (params.message.endsWith("request approval again")) {
    return params.message;
  }
  return `${params.message} — ${SYSTEM_RUN_DENIED_ESCALATION_HINT}`;
}

async function sendSystemRunCompleted(
  opts: Pick<HandleSystemRunInvokeOptions, "sendExecFinishedEvent" | "sendInvokeResult">,
  execution: SystemRunExecutionContext,
  result: ExecFinishedResult,
  payloadJSON: string,
) {
  await opts.sendExecFinishedEvent({
    sessionKey: execution.sessionKey,
    runId: execution.runId,
    commandText: execution.commandText,
    result,
    suppressNotifyOnExit: execution.suppressNotifyOnExit,
  });
  await opts.sendInvokeResult({
    ok: true,
    payloadJSON,
  });
}

function argvArraysMatch(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

export { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";

async function parseSystemRunPhase(
  opts: HandleSystemRunInvokeOptions,
): Promise<SystemRunParsePhase | null> {
  const command = resolveSystemRunCommandRequest({
    command: opts.params.command,
    rawCommand: opts.params.rawCommand,
  });
  if (!command.ok) {
    await opts.sendInvokeResult({
      ok: false,
      error: { code: "INVALID_REQUEST", message: command.message },
    });
    return null;
  }
  if (command.argv.length === 0) {
    await opts.sendInvokeResult({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "command required" },
    });
    return null;
  }

  const shellPayload = command.shellPayload;
  const shellWrapperInvocation = isShellWrapperInvocation(command.argv);
  const commandText = command.commandText;
  const approvalPlan =
    opts.params.systemRunPlan === undefined
      ? null
      : normalizeSystemRunApprovalPlan(opts.params.systemRunPlan);
  if (opts.params.systemRunPlan !== undefined && !approvalPlan) {
    await opts.sendInvokeResult({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "systemRunPlan invalid" },
    });
    return null;
  }
  const agentId = normalizeOptionalString(opts.params.agentId);
  const requestedSessionKey = normalizeOptionalString(opts.params.sessionKey);
  const sessionKey = requestedSessionKey ?? "node";
  const runId = normalizeOptionalString(opts.params.runId) ?? crypto.randomUUID();
  const cwd = normalizeOptionalString(opts.params.cwd);
  const suppressNotifyOnExit = opts.params.suppressNotifyOnExit === true;
  const approvalSource = opts.params.approvalSource;
  if (
    approvalSource != null &&
    approvalSource !== "ask-fallback" &&
    approvalSource !== "auto-review"
  ) {
    await opts.sendInvokeResult({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "approvalSource invalid" },
    });
    return null;
  }
  const approvalDecision = resolveExecApprovalDecision(opts.params.approvalDecision);
  const approved = opts.params.approved === true;
  if (
    approvalSource != null &&
    (opts.params.approved !== undefined || opts.params.approvalDecision !== undefined)
  ) {
    await opts.sendInvokeResult({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "approvalSource cannot be combined with explicit approval",
      },
    });
    return null;
  }
  const explicitApproval = approved || approvalDecision !== null;
  const forwardedDelayedApproval = approvalSource === "auto-review" || explicitApproval;
  if (approvalSource != null || explicitApproval) {
    const planMatchesRequest =
      approvalPlan !== null &&
      argvArraysMatch(approvalPlan.argv, command.argv) &&
      approvalPlan.commandText === commandText &&
      normalizeOptionalString(approvalPlan.cwd) === cwd &&
      normalizeOptionalString(approvalPlan.agentId) === agentId &&
      normalizeOptionalString(approvalPlan.sessionKey) === requestedSessionKey;
    if (!planMatchesRequest) {
      await opts.sendInvokeResult({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message:
            approvalSource != null
              ? "approvalSource requires matching systemRunPlan"
              : "explicit approval requires matching systemRunPlan",
        },
      });
      return null;
    }
  }
  const delayedApprovalPolicySnapshot = forwardedDelayedApproval
    ? (approvalPlan?.policySnapshot ?? null)
    : null;
  if (forwardedDelayedApproval && !delayedApprovalPolicySnapshot) {
    await opts.sendInvokeResult({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "delayed approval requires a prepared policy snapshot",
      },
    });
    return null;
  }
  const envAssignmentKeys = extractEnvAssignmentKeysFromDispatchWrappers(command.argv);
  const envAssignmentOverrides =
    envAssignmentKeys.length > 0
      ? Object.fromEntries(envAssignmentKeys.map((key) => [key, "1"]))
      : undefined;
  const envAssignmentDiagnostics = inspectHostExecEnvOverrides({
    overrides: envAssignmentOverrides,
    blockPathOverrides: true,
  });
  // `extractEnvAssignmentKeysFromDispatchWrappers` only emits keys that satisfy
  // `isEnvAssignment` and therefore portable env-key syntax by construction.
  if (envAssignmentDiagnostics.rejectedOverrideBlockedKeys.length > 0) {
    await opts.sendInvokeResult({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `SYSTEM_RUN_DENIED: command env assignment rejected (blocked env assignment keys: ${envAssignmentDiagnostics.rejectedOverrideBlockedKeys.join(", ")})`,
      },
    });
    return null;
  }
  const envOverrideDiagnostics = inspectHostExecEnvOverrides({
    overrides: opts.params.env ?? undefined,
    blockPathOverrides: true,
  });
  if (
    envOverrideDiagnostics.rejectedOverrideBlockedKeys.length > 0 ||
    envOverrideDiagnostics.rejectedOverrideInvalidKeys.length > 0
  ) {
    const details: string[] = [];
    if (envOverrideDiagnostics.rejectedOverrideBlockedKeys.length > 0) {
      details.push(
        `blocked override keys: ${envOverrideDiagnostics.rejectedOverrideBlockedKeys.join(", ")}`,
      );
    }
    if (envOverrideDiagnostics.rejectedOverrideInvalidKeys.length > 0) {
      details.push(
        `invalid non-portable override keys: ${envOverrideDiagnostics.rejectedOverrideInvalidKeys.join(", ")}`,
      );
    }
    await opts.sendInvokeResult({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `SYSTEM_RUN_DENIED: environment override rejected (${details.join("; ")})`,
      },
    });
    return null;
  }
  const envOverrides = sanitizeSystemRunEnvOverrides({
    overrides: opts.params.env ?? undefined,
    shellWrapper: shellWrapperInvocation,
  });
  return {
    argv: command.argv,
    shellPayload,
    shellWrapperInvocation,
    commandText,
    commandPreview: command.previewText,
    approvalPlan,
    agentId,
    sessionKey,
    runId,
    execution: { sessionKey, runId, commandText, suppressNotifyOnExit },
    approvalDecision,
    approvalSource: approvalSource ?? undefined,
    delayedApprovalPolicySnapshot,
    envOverrides,
    env: opts.sanitizeEnv(envOverrides),
    cwd,
    timeoutMs: opts.params.timeoutMs ?? undefined,
    needsScreenRecording: opts.params.needsScreenRecording === true,
    approved,
  };
}

async function evaluateSystemRunPolicyPhase(
  opts: HandleSystemRunInvokeOptions,
  parsed: SystemRunParsePhase,
): Promise<SystemRunPolicyPhase | null> {
  const cfg = await loadSystemRunConfig(opts);
  const effectivePolicy = await resolveEffectiveSystemRunExecPolicy({
    cfg,
    agentId: parsed.agentId,
    defaultSecurity: opts.resolveExecSecurity(undefined),
    defaultAsk: opts.resolveExecAsk(undefined),
    requireSocket: opts.preferMacAppExecHost,
  });
  const { agentExec, globalExec, approvals } = effectivePolicy;
  const currentPolicySnapshot = createExecApprovalPolicySnapshot({
    file: approvals.file,
    agentId: parsed.agentId,
  });
  if (
    parsed.delayedApprovalPolicySnapshot &&
    !isExecApprovalPolicySnapshotCurrent(
      parsed.delayedApprovalPolicySnapshot,
      currentPolicySnapshot,
    )
  ) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message: "SYSTEM_RUN_DENIED: exec approval policy changed; request approval again",
    });
    return null;
  }
  const evaluationPolicySnapshot = parsed.delayedApprovalPolicySnapshot ?? currentPolicySnapshot;
  const baseSecurity = effectivePolicy.security;
  const baseAsk = effectivePolicy.ask;
  const fallbackRequest = parsed.approvalSource === "ask-fallback";
  const security = fallbackRequest
    ? minSecurity(baseSecurity, approvals.agent.askFallback)
    : baseSecurity;
  const ask = fallbackRequest ? "off" : baseAsk;
  const autoAllowSkills = approvals.agent.autoAllowSkills;
  const { safeBins, safeBinProfiles, trustedSafeBinDirs } = resolveExecSafeBinRuntimePolicy({
    global: cfg.tools?.exec,
    local: agentExec,
    onWarning: warnWritableTrustedDirOnce,
  });
  const bins = autoAllowSkills ? await opts.skillBins.current() : [];
  const allowlistEvaluation = await evaluateSystemRunAllowlist({
    shellCommand: parsed.shellPayload,
    argv: parsed.argv,
    approvals,
    security,
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    cwd: parsed.cwd,
    env: parsed.env,
    skillBins: bins,
    autoAllowSkills,
  });
  const {
    allowlistMatches,
    allowlistAuthorizationSatisfied,
    segments,
    segmentAllowlistEntries,
    segmentSatisfiedBy,
  } = allowlistEvaluation;
  let { analysisOk, allowlistSatisfied } = allowlistEvaluation;
  const strictInlineEval =
    agentExec?.strictInlineEval === true || cfg.tools?.exec?.strictInlineEval === true;
  const inlineEvalHit = strictInlineEval ? detectPolicyInlineEval(segments) : null;
  const isWindows = process.platform === "win32";
  // Detect Windows wrapper transport from the same shell-wrapper view used to
  // derive the inner payload. That keeps `cmd.exe /c` approval-gated even when
  // dispatch carriers like `env FOO=bar ...` wrap the shell invocation.
  const cmdDetectionArgv = resolveShellWrapperTransportArgv(parsed.argv) ?? parsed.argv;
  const cmdInvocation = opts.isCmdExeInvocation(cmdDetectionArgv);
  const durableApprovalSatisfied = hasDurableExecApproval({
    analysisOk,
    segmentAllowlistEntries,
    allowlist: approvals.allowlist,
    commandText: parsed.commandText,
  });
  const inlineEvalExecutableTrusted =
    inlineEvalHit !== null &&
    segmentAllowlistEntries.some((entry) => entry?.source === "allow-always");
  const forwardedAutoReview = parsed.approvalSource === "auto-review";
  let approvalDecision = forwardedAutoReview ? "allow-once" : parsed.approvalDecision;
  let approvalGrantSource: SystemRunPolicyPhase["approvalGrantSource"] = forwardedAutoReview
    ? "auto-review"
    : parsed.approved || approvalDecision !== null
      ? "explicit-approval"
      : null;
  let policy = evaluateSystemRunPolicy({
    security,
    ask,
    analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied: durableApprovalSatisfied || inlineEvalExecutableTrusted,
    approvalDecision,
    approved: parsed.approved,
    isWindows,
    cmdInvocation,
    // Keep cmd.exe approval gating scoped to inline shell-wrapper transport.
    // Env sanitization uses broader shell-wrapper detection in parse phase.
    shellWrapperInvocation: parsed.shellPayload !== null,
  });
  const requiresSecurityAuditSuppressionApproval =
    commandRequiresSecurityAuditSuppressionApproval({
      command: parsed.commandText,
      cwd: parsed.cwd,
      env: parsed.env,
      segments,
    }) && !(baseSecurity === "full" && baseAsk === "off" && !fallbackRequest);
  if (forwardedAutoReview && requiresSecurityAuditSuppressionApproval) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message: "SYSTEM_RUN_DENIED: explicit approval required",
    });
    return null;
  }
  if (requiresSecurityAuditSuppressionApproval && !policy.approvedByAsk) {
    policy = {
      allowed: false,
      eventReason: "approval-required",
      errorMessage: "SYSTEM_RUN_DENIED: approval required",
      analysisOk: policy.analysisOk,
      allowlistSatisfied: policy.allowlistSatisfied,
      shellWrapperBlocked: policy.shellWrapperBlocked,
      windowsShellWrapperBlocked: policy.windowsShellWrapperBlocked,
      requiresAsk: true,
      approvalDecision: policy.approvalDecision,
      approvedByAsk: policy.approvedByAsk,
    };
  }
  let autoReviewDeferredMessage: string | undefined;
  analysisOk = policy.analysisOk;
  allowlistSatisfied = policy.allowlistSatisfied;
  const strictInlineEvalRequiresApproval =
    inlineEvalHit !== null &&
    !policy.approvedByAsk &&
    (policy.allowed ? true : policy.eventReason !== "security=deny");
  if (strictInlineEvalRequiresApproval) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message:
        `SYSTEM_RUN_DENIED: approval required (` +
        `${describeInterpreterInlineEval(inlineEvalHit)} requires explicit approval in strictInlineEval mode)`,
    });
    return null;
  }

  if (!policy.allowed) {
    const [autoReviewSegment] = segments;
    const directAutoReviewArgvMatchesRequest =
      parsed.shellPayload !== null || argvArraysMatch(autoReviewSegment?.argv, parsed.argv);
    const autoReviewArgv =
      segments.length === 1 &&
      autoReviewSegment !== undefined &&
      autoReviewSegment.resolution?.policyBlocked !== true &&
      // Check the reviewed inner command so safe node transport remains usable.
      !isBlockedShellWrapperCommand(autoReviewSegment.argv) &&
      directAutoReviewArgvMatchesRequest &&
      (parsed.shellPayload === null ||
        (autoReviewSegment.raw !== undefined &&
          autoReviewSegment.raw.trim() === parsed.shellPayload.trim()))
        ? autoReviewSegment.argv
        : undefined;
    const canAutoReviewApprovalMiss =
      !fallbackRequest &&
      effectivePolicy.autoReview &&
      ask !== "always" &&
      analysisOk &&
      autoReviewArgv !== undefined &&
      parsed.approvalPlan !== null &&
      inlineEvalHit === null &&
      !requiresSecurityAuditSuppressionApproval &&
      policy.eventReason !== "security=deny";
    if (canAutoReviewApprovalMiss) {
      const reviewer = await resolveSystemRunAutoReviewer({
        opts,
        cfg,
        agentId: parsed.agentId,
        agentExec,
        globalExec,
      });
      const decision = await resolveExecAutoReviewDecision(reviewer, {
        command: parsed.commandText,
        argv: autoReviewArgv,
        cwd: parsed.cwd,
        envKeys: Object.keys(parsed.envOverrides ?? {}).toSorted(),
        host: "node",
        reason: policy.eventReason === "allowlist-miss" ? "allowlist-miss" : "approval-required",
        analysis: {
          parsed: analysisOk,
          allowlistMatched: allowlistSatisfied,
          durableApprovalMatched: durableApprovalSatisfied,
          inlineEval: false,
          shellWrapper: parsed.shellWrapperInvocation,
        },
        agent: {
          id: parsed.agentId,
          sessionKey: parsed.sessionKey,
        },
      });
      if (decision.decision === "allow-once" && decision.risk === "low") {
        approvalDecision = "allow-once";
        approvalGrantSource = "auto-review";
        policy = evaluateSystemRunPolicy({
          security,
          ask,
          analysisOk,
          allowlistSatisfied,
          durableApprovalSatisfied: durableApprovalSatisfied || inlineEvalExecutableTrusted,
          approvalDecision,
          approved: true,
          isWindows,
          cmdInvocation,
          shellWrapperInvocation: parsed.shellPayload !== null,
        });
      } else {
        autoReviewDeferredMessage = `${policy.errorMessage} (exec auto-review deferred to human approval: ${decision.rationale})`;
      }
    }
  }

  if (!policy.allowed) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: policy.eventReason,
      message: autoReviewDeferredMessage ?? policy.errorMessage,
    });
    return null;
  }

  // Fail closed if policy/runtime drift re-allows Windows shell wrappers.
  if (policy.shellWrapperBlocked && !policy.approvedByAsk && !durableApprovalSatisfied) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message: "SYSTEM_RUN_DENIED: approval required",
    });
    return null;
  }
  // Bind the commit to the normalized policy: Windows wrappers invalidate
  // otherwise-valid raw allowlist matches before execution.
  const durableApprovalRequired =
    security === "allowlist" &&
    durableApprovalSatisfied &&
    !policy.approvedByAsk &&
    (!policy.analysisOk || !policy.allowlistSatisfied);
  const durableApprovalRequirement = resolveDurableExecApprovalRequirement({
    durableApprovalRequired,
    allowlist: approvals.allowlist,
    commandText: parsed.commandText,
  });

  const approvalContextBound = policy.approvedByAsk || fallbackRequest;
  const hardenedPaths = hardenApprovedExecutionPaths({
    approvedByAsk: approvalContextBound,
    argv: parsed.argv,
    shellCommand: parsed.shellPayload,
    cwd: parsed.cwd,
  });
  if (!hardenedPaths.ok) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message: hardenedPaths.message,
      escalationOwner: "binding",
    });
    return null;
  }
  let executionCwd = hardenedPaths.cwd;
  let approvedCwdSnapshot = approvalContextBound ? hardenedPaths.approvedCwdSnapshot : undefined;
  if (security === "allowlist" && !approvedCwdSnapshot) {
    const capturedCwd = captureApprovedCwdSnapshotSync(executionCwd ?? process.cwd());
    if (!capturedCwd.ok) {
      await sendSystemRunDenied(opts, parsed.execution, {
        reason: "approval-required",
        message: capturedCwd.message,
        escalationOwner: "binding",
      });
      return null;
    }
    executionCwd = capturedCwd.snapshot.cwd;
    approvedCwdSnapshot = capturedCwd.snapshot;
  }
  if ((approvalContextBound || security === "allowlist") && !approvedCwdSnapshot) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message: APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
      escalationOwner: "binding",
    });
    return null;
  }

  const plannedAllowlistArgv = resolvePlannedAllowlistArgv({
    security,
    shellCommand: parsed.shellPayload,
    policy,
    segments,
  });
  if (plannedAllowlistArgv === null) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "execution-plan-miss",
      message: "SYSTEM_RUN_DENIED: execution plan mismatch",
    });
    return null;
  }
  return {
    ...parsed,
    cwd: executionCwd,
    approvalDecision,
    argv: hardenedPaths.argv,
    approvals,
    evaluationPolicySnapshot,
    security,
    ask,
    policy,
    approvalGrantSource,
    durableApprovalSatisfied,
    durableApprovalRequirement,
    strictInlineEval,
    inlineEvalHit,
    allowlistMatches,
    analysisOk,
    allowlistSatisfied,
    allowlistAuthorizationSatisfied,
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    skillBins: bins,
    autoAllowSkills,
    segments,
    segmentSatisfiedBy,
    authorizationPlan: allowlistEvaluation.authorizationPlan,
    plannedAllowlistArgv: plannedAllowlistArgv ?? undefined,
    isWindows,
    approvedCwdSnapshot,
  };
}

async function revalidateSystemRunApprovedPathBindings(
  opts: HandleSystemRunInvokeOptions,
  phase: SystemRunPolicyPhase,
): Promise<boolean> {
  if (phase.approvedCwdSnapshot && !revalidateApprovedCwdSnapshot(phase.approvedCwdSnapshot)) {
    logWarn(`security: system.run approval cwd drift blocked (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "approval-required",
      message: APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
      escalationOwner: "binding",
    });
    return false;
  }
  if (
    phase.approvalPlan?.mutableFileOperand &&
    !revalidateApprovedMutableFileOperand({
      snapshot: phase.approvalPlan.mutableFileOperand,
      argv: phase.argv,
      cwd: phase.cwd,
    })
  ) {
    logWarn(`security: system.run approval script drift blocked (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "approval-required",
      message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      escalationOwner: "binding",
    });
    return false;
  }
  return true;
}

async function executeSystemRunPhase(
  opts: HandleSystemRunInvokeOptions,
  phase: SystemRunPolicyPhase,
): Promise<void> {
  if (!(await revalidateSystemRunApprovedPathBindings(opts, phase))) {
    return;
  }
  const expectedMutableFileOperand =
    phase.approvalPlan &&
    (phase.policy.approvedByAsk ||
      phase.approvalSource !== undefined ||
      phase.security === "allowlist")
      ? resolveMutableFileOperandSnapshotSync({
          argv: phase.argv,
          cwd: phase.cwd,
          shellCommand: phase.shellPayload,
        })
      : null;
  if (expectedMutableFileOperand && !expectedMutableFileOperand.ok) {
    logWarn(`security: system.run approval script binding blocked (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "approval-required",
      message: expectedMutableFileOperand.message,
      escalationOwner: "binding",
    });
    return;
  }
  if (expectedMutableFileOperand?.snapshot && !phase.approvalPlan?.mutableFileOperand) {
    logWarn(`security: system.run approval script binding missing (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "approval-required",
      message: APPROVAL_SCRIPT_OPERAND_BINDING_DENIED_MESSAGE,
      escalationOwner: "binding",
    });
    return;
  }
  const execArgv = await resolveSystemRunExecArgv({
    plannedAllowlistArgv: phase.plannedAllowlistArgv,
    argv: phase.argv,
    security: phase.security,
    approvals: phase.approvals,
    safeBins: phase.safeBins,
    safeBinProfiles: phase.safeBinProfiles,
    trustedSafeBinDirs: phase.trustedSafeBinDirs,
    skillBins: phase.skillBins,
    autoAllowSkills: phase.autoAllowSkills,
    isWindows: phase.isWindows,
    policy: phase.policy,
    shellCommand: phase.shellPayload,
    segments: phase.segments,
    segmentSatisfiedBy: phase.segmentSatisfiedBy,
    authorizationPlan: phase.authorizationPlan,
    cwd: phase.cwd,
    env: phase.env,
  });
  if (!execArgv) {
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "execution-plan-miss",
      message: "SYSTEM_RUN_DENIED: execution plan mismatch",
    });
    return;
  }

  if (opts.preferMacAppExecHost) {
    const macApprovalSource =
      phase.approvalSource ??
      (phase.approvalGrantSource === "auto-review" ? "auto-review" : undefined);
    const macApprovalDecision = macApprovalSource
      ? null
      : phase.approvalGrantSource === "explicit-approval" && phase.approvalDecision === null
        ? "allow-once"
        : phase.approvalDecision;
    const execRequest: ExecHostRequest = {
      command: execArgv,
      // Forward canonical display text so companion approval/prompt surfaces bind to
      // the exact command context already validated on the node-host.
      rawCommand: execArgv === phase.argv ? phase.commandText || null : formatExecCommand(execArgv),
      cwd: phase.cwd ?? null,
      env: phase.envOverrides ?? null,
      timeoutMs: phase.timeoutMs ?? null,
      needsScreenRecording: phase.needsScreenRecording,
      agentId: phase.agentId ?? null,
      sessionKey: phase.sessionKey ?? null,
      approvalDecision: macApprovalDecision,
      approvalSource: macApprovalSource,
      ...(phase.approvalGrantSource ? { policySnapshot: phase.evaluationPolicySnapshot } : {}),
    };
    const response = await opts.runViaMacAppExecHost({
      approvals: phase.approvals,
      request: execRequest,
      signal: opts.signal,
    });
    if (opts.signal?.aborted) {
      return;
    }
    if (!response) {
      if (opts.execHostEnforced || !opts.execHostFallbackAllowed) {
        await sendSystemRunDenied(opts, phase.execution, {
          reason: "companion-unavailable",
          message: "COMPANION_APP_UNAVAILABLE: macOS app exec host unreachable",
        });
        return;
      }
    } else if (!response.ok) {
      const hostReason = response.error.reason ?? "";
      const hostMessage = response.error.message;
      // Structured binding-integrity failures come back through an
      // approval-required host response carrying the binding-denial message
      // (the mac host revalidates the approved cwd/script snapshots with the
      // same infra); they teach renewal, not policy relaxation — parity with
      // the local binding path.
      const macBindingFailure =
        normalizeDeniedReason(hostReason) === "approval-required" &&
        (hostMessage === APPROVAL_CWD_DRIFT_DENIED_MESSAGE ||
          hostMessage === APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE ||
          hostMessage === APPROVAL_SCRIPT_OPERAND_BINDING_DENIED_MESSAGE);
      await sendSystemRunDenied(opts, phase.execution, {
        reason: normalizeDeniedReason(hostReason),
        message: hostMessage,
        // Freeform host-authored messages (cancelled prompt, temporarily
        // unavailable approval store, permission prompts) carry no policy
        // guarantee; the host's structured policy verdicts do.
        suppressEscalationHint:
          !macBindingFailure && !MAC_HOST_POLICY_OWNED_REASONS.has(hostReason),
        ...(macBindingFailure ? { escalationOwner: "binding" as const } : {}),
      });
      return;
    } else {
      const result: ExecHostRunResult = response.payload;
      await sendSystemRunCompleted(opts, phase.execution, result, JSON.stringify(result));
      return;
    }
  }

  if (phase.needsScreenRecording) {
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "permission:screenRecording",
      message: "PERMISSION_MISSING: screenRecording",
    });
    return;
  }

  const allowAlwaysDecision =
    phase.policy.approvalDecision === "allow-always"
      ? resolveAllowAlwaysPersistenceDecision({
          segments: phase.segments,
          cwd: phase.cwd,
          env: phase.env,
          platform: process.platform,
          commandText: phase.commandText,
          strictInlineEval: phase.strictInlineEval,
          authorizationPlan: phase.authorizationPlan,
          runtimePayload: phase.inlineEvalHit !== null,
        })
      : undefined;
  const authorizationSource: ExecApprovalUsageAuthorization["source"] =
    phase.approvalSource === "ask-fallback"
      ? "ask-fallback"
      : phase.approvalSource === "auto-review"
        ? "auto-review"
        : (phase.approvalGrantSource ?? "current-policy");
  const delayedAuthorization =
    authorizationSource === "explicit-approval" || authorizationSource === "auto-review";
  const authorization: ExecApprovalUsageAuthorization = {
    source: authorizationSource,
    security: phase.security,
    ask: phase.ask,
    allowlistSatisfied: phase.allowlistAuthorizationSatisfied || phase.durableApprovalSatisfied,
    ...(delayedAuthorization ? { policySnapshot: phase.evaluationPolicySnapshot } : {}),
    requireAutoAllowSkills: phase.segmentSatisfiedBy.includes("skills"),
    requireExactCommandApproval: phase.durableApprovalRequirement === "exact-command",
    requireDurableAllowlistApproval: phase.durableApprovalRequirement === "segment-allowlist",
  };

  try {
    await (opts.commitExecAuthorization ?? commitExecAuthorizationLocked)({
      agentId: phase.agentId,
      matches: phase.allowlistMatches,
      command: phase.commandText,
      resolvedPath: resolveApprovalAuditTrustPath(phase.segments[0]?.resolution ?? null, phase.cwd),
      authorization,
      ...(allowAlwaysDecision ? { allowAlwaysDecision } : {}),
    });
  } catch {
    // Approval state is part of the authorization boundary. Never execute after
    // a failed durable grant or audit write, and consume the error in this
    // fire-and-forget node invocation before it can terminate the host process.
    logWarn(`security: system.run approval state write failed (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "approval-state-write-failed",
      message: APPROVAL_STATE_WRITE_FAILED_MESSAGE,
    });
    return;
  }

  // Policy commit can yield to another invocation or process. Recheck the
  // approval-bound cwd and mutable operand immediately before local spawn.
  if (!(await revalidateSystemRunApprovedPathBindings(opts, phase))) {
    return;
  }

  if (opts.signal?.aborted) {
    return;
  }
  const result = await (opts.signal
    ? opts.runCommand(execArgv, phase.cwd, phase.env, phase.timeoutMs, opts.signal)
    : opts.runCommand(execArgv, phase.cwd, phase.env, phase.timeoutMs));
  if (opts.signal?.aborted) {
    return;
  }
  applyOutputTruncation(result);
  await sendSystemRunCompleted(
    opts,
    phase.execution,
    result,
    JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ?? null,
    }),
  );
}

/** Executes a validated system.run request, emitting lifecycle events and approvals. */
export async function handleSystemRunInvoke(opts: HandleSystemRunInvokeOptions): Promise<void> {
  if (opts.signal?.aborted) {
    return;
  }
  const parsed = await parseSystemRunPhase(opts);
  if (!parsed || opts.signal?.aborted) {
    return;
  }
  const policyPhase = await evaluateSystemRunPolicyPhase(opts, parsed);
  if (!policyPhase || opts.signal?.aborted) {
    return;
  }
  await executeSystemRunPhase(opts, policyPhase);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
