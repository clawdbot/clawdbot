import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  describeInterpreterInlineEval,
  type InterpreterInlineEvalHit,
} from "../infra/command-analysis/inline-eval.js";
import { detectPolicyInlineEval } from "../infra/command-analysis/policy.js";
import {
  addDurableCommandApproval,
  commandRequiresSecurityAuditSuppressionApproval,
  hasDurableExecApproval,
  maxAsk,
  minSecurity,
  persistAllowAlwaysPatterns,
  recordAllowlistMatchesUse,
  resolveApprovalAuditTrustPath,
  resolveExecApprovals,
  resolveExecModePolicy,
  resolveExecPolicyForMode,
  type ExecAllowlistEntry,
  type ExecAsk,
  type ExecCommandSegment,
  type ExecMode,
  type ExecSegmentSatisfiedBy,
  type ExecSecurity,
  type SkillBinTrustEntry,
} from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { ExecHostRequest, ExecHostResponse, ExecHostRunResult } from "../infra/exec-host.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import {
  extractEnvAssignmentKeysFromDispatchWrappers,
  isShellWrapperInvocation,
  resolveShellWrapperTransportArgv,
} from "../infra/exec-wrapper-resolution.js";
import {
  inspectHostExecEnvOverrides,
  sanitizeSystemRunEnvOverrides,
} from "../infra/host-env-security.js";
import { normalizeSystemRunApprovalPlan } from "../infra/system-run-approval-binding.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "../infra/system-run-command.js";
import { logWarn } from "../logger.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { evaluateSystemRunPolicy, resolveExecApprovalDecision } from "./exec-policy.js";
import {
  applyOutputTruncation,
  evaluateSystemRunAllowlist,
  resolvePlannedAllowlistArgv,
  resolveSystemRunExecArgv,
} from "./invoke-system-run-allowlist.js";
import {
  hardenApprovedExecutionPaths,
  revalidateApprovedCwdSnapshot,
  revalidateApprovedMutableFileOperand,
  resolveMutableFileOperandSnapshotSync,
  type ApprovedCwdSnapshot,
} from "./invoke-system-run-plan.js";
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
  | "allowlist-miss"
  | "execution-plan-miss"
  | "companion-unavailable"
  | "permission:screenRecording";

type SystemRunExecutionContext = {
  sessionKey: string;
  runId: string;
  commandText: string;
  suppressNotifyOnExit: boolean;
};

type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;

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
  envOverrides: Record<string, string> | undefined;
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  timeoutMs: number | undefined;
  needsScreenRecording: boolean;
  approved: boolean;
  suppressNotifyOnExit: boolean;
};

type SystemRunPolicyPhase = SystemRunParsePhase & {
  approvals: ResolvedExecApprovals;
  security: ExecSecurity;
  ask: ExecAsk;
  policy: ReturnType<typeof evaluateSystemRunPolicy>;
  durableApprovalSatisfied: boolean;
  strictInlineEval: boolean;
  inlineEvalHit: InterpreterInlineEvalHit | null;
  allowlistMatches: ExecAllowlistEntry[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  safeBins: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBins"];
  safeBinProfiles: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBinProfiles"];
  trustedSafeBinDirs: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["trustedSafeBinDirs"];
  skillBins: SkillBinTrustEntry[];
  autoAllowSkills: boolean;
  segments: ExecCommandSegment[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
  plannedAllowlistArgv: string[] | undefined;
  isWindows: boolean;
  approvedCwdSnapshot: ApprovedCwdSnapshot | undefined;
};

const safeBinTrustedDirWarningCache = new Set<string>();
const APPROVAL_CWD_DRIFT_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval cwd changed before execution";
const APPROVAL_SCRIPT_OPERAND_BINDING_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval missing script operand binding";
const APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval script operand changed before execution";
type ExecToolConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["exec"]>;

type LayeredExecPolicy = {
  mode?: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
};

type EffectiveSystemRunExecPolicy = {
  agentExec: ExecToolConfig | undefined;
  globalExec: ExecToolConfig | undefined;
  approvals: ReturnType<typeof resolveExecApprovals>;
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview: boolean;
};

function hasLegacyExecPolicyOverride(exec?: ExecToolConfig): boolean {
  return exec?.security !== undefined || exec?.ask !== undefined;
}

function applyExecPolicyLayer(base: LayeredExecPolicy, layer?: ExecToolConfig): LayeredExecPolicy {
  if (!layer) {
    return base;
  }
  if (layer.mode) {
    return {
      mode: layer.mode,
      ...resolveExecPolicyForMode(layer.mode),
    };
  }
  if (hasLegacyExecPolicyOverride(layer)) {
    return {
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    };
  }
  return base;
}

function warnWritableTrustedDirOnce(message: string): void {
  if (safeBinTrustedDirWarningCache.has(message)) {
    return;
  }
  safeBinTrustedDirWarningCache.add(message);
  logWarn(message);
}

function normalizeDeniedReason(reason: string | null | undefined): SystemRunDeniedReason {
  switch (reason) {
    case "security=deny":
    case "approval-required":
    case "allowlist-miss":
    case "execution-plan-miss":
    case "companion-unavailable":
    case "permission:screenRecording":
      return reason;
    default:
      return "approval-required";
  }
}

function resolveAgentExecConfig(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): ExecToolConfig | undefined {
  if (!agentId) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  const entry = cfg.agents?.list?.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      normalizeAgentId(candidate.id) === normalizedAgentId,
  );
  return entry?.tools?.exec;
}

export function resolveEffectiveSystemRunExecPolicy(params: {
  cfg: OpenClawConfig;
  agentId: string | undefined;
  defaultSecurity: ExecSecurity;
  defaultAsk: ExecAsk;
  requireSocket: boolean;
}): EffectiveSystemRunExecPolicy {
  const agentExec = resolveAgentExecConfig(params.cfg, params.agentId);
  const globalExec = params.cfg.tools?.exec;
  const layeredPolicy = applyExecPolicyLayer(
    applyExecPolicyLayer(
      {
        security: params.defaultSecurity,
        ask: params.defaultAsk,
      },
      globalExec,
    ),
    agentExec,
  );
  const modePolicy = resolveExecModePolicy({
    mode: layeredPolicy.mode,
    security: layeredPolicy.security,
    ask: layeredPolicy.ask,
  });
  const approvals = resolveExecApprovals(params.agentId, {
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

export type HandleSystemRunInvokeOptions = {
  client: GatewayClient;
  params: SystemRunParams;
  skillBins: SkillBinsProvider;
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
  ) => Promise<RunResult>;
  runViaMacAppExecHost: (params: {
    approvals: ReturnType<typeof resolveExecApprovals>;
    request: ExecHostRequest;
  }) => Promise<ExecHostResponse | null>;
  sendNodeEvent: (client: GatewayClient, event: string, payload: unknown) => Promise<void>;
  buildExecEventPayload: (payload: ExecEventPayload) => ExecEventPayload;
  sendInvokeResult: (result: SystemRunInvokeResult) => Promise<void>;
  sendExecFinishedEvent: (params: ExecFinishedEventParams) => Promise<void>;
  preferMacAppExecHost: boolean;
  getRuntimeConfig?: () => OpenClawConfig;
  autoReviewer?: ExecAutoReviewer;
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
    error: { code: "UNAVAILABLE", message: params.message },
  });
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
  const sessionKey = normalizeOptionalString(opts.params.sessionKey) ?? "node";
  const runId = normalizeOptionalString(opts.params.runId) ?? crypto.randomUUID();
  const suppressNotifyOnExit = opts.params.suppressNotifyOnExit === true;
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
    approvalDecision: resolveExecApprovalDecision(opts.params.approvalDecision),
    envOverrides,
    env: opts.sanitizeEnv(envOverrides),
    cwd: normalizeOptionalString(opts.params.cwd),
    timeoutMs: opts.params.timeoutMs ?? undefined,
    needsScreenRecording: opts.params.needsScreenRecording === true,
    approved: opts.params.approved === true,
    suppressNotifyOnExit,
  };
}

async function evaluateSystemRunPolicyPhase(
  opts: HandleSystemRunInvokeOptions,
  parsed: SystemRunParsePhase,
): Promise<SystemRunPolicyPhase | null> {
  const cfg = await loadSystemRunConfig(opts);
  const effectivePolicy = resolveEffectiveSystemRunExecPolicy({
    cfg,
    agentId: parsed.agentId,
    defaultSecurity: opts.resolveExecSecurity(undefined),
    defaultAsk: opts.resolveExecAsk(undefined),
    requireSocket: opts.preferMacAppExecHost,
  });
  const { agentExec, globalExec, approvals, security, ask } = effectivePolicy;
  const autoAllowSkills = approvals.agent.autoAllowSkills;
  const { safeBins, safeBinProfiles, trustedSafeBinDirs } = resolveExecSafeBinRuntimePolicy({
    global: cfg.tools?.exec,
    local: agentExec,
    onWarning: warnWritableTrustedDirOnce,
  });
  const bins = autoAllowSkills ? await opts.skillBins.current() : [];
  let {
    analysisOk,
    allowlistMatches,
    allowlistSatisfied,
    segments,
    segmentAllowlistEntries,
    segmentSatisfiedBy,
  } = evaluateSystemRunAllowlist({
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
  let approvalDecision = parsed.approvalDecision;
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
    }) && !(security === "full" && ask === "off");
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
      directAutoReviewArgvMatchesRequest &&
      (parsed.shellPayload === null ||
        (autoReviewSegment?.raw !== undefined &&
          autoReviewSegment.raw.trim() === parsed.shellPayload.trim()))
        ? autoReviewSegment?.argv
        : undefined;
    const canAutoReviewApprovalMiss =
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
      const decision = await reviewer({
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
      if (decision.decision === "allow-once") {
        approvalDecision = "allow-once";
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

  const hardenedPaths = hardenApprovedExecutionPaths({
    approvedByAsk: policy.approvedByAsk,
    argv: parsed.argv,
    shellCommand: parsed.shellPayload,
    cwd: parsed.cwd,
  });
  if (!hardenedPaths.ok) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message: hardenedPaths.message,
    });
    return null;
  }
  const approvedCwdSnapshot = policy.approvedByAsk ? hardenedPaths.approvedCwdSnapshot : undefined;
  if (policy.approvedByAsk && hardenedPaths.cwd && !approvedCwdSnapshot) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message: APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
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
    approvalDecision,
    argv: hardenedPaths.argv,
    cwd: hardenedPaths.cwd,
    approvals,
    security,
    ask,
    policy,
    durableApprovalSatisfied,
    strictInlineEval,
    inlineEvalHit,
    allowlistMatches,
    analysisOk,
    allowlistSatisfied,
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    skillBins: bins,
    autoAllowSkills,
    segments,
    segmentSatisfiedBy,
    plannedAllowlistArgv: plannedAllowlistArgv ?? undefined,
    isWindows,
    approvedCwdSnapshot,
  };
}

async function executeSystemRunPhase(
  opts: HandleSystemRunInvokeOptions,
  phase: SystemRunPolicyPhase,
): Promise<void> {
  if (
    phase.approvedCwdSnapshot &&
    !revalidateApprovedCwdSnapshot({ snapshot: phase.approvedCwdSnapshot })
  ) {
    logWarn(`security: system.run approval cwd drift blocked (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "approval-required",
      message: APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
    });
    return;
  }
  const expectedMutableFileOperand = phase.approvalPlan
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
    });
    return;
  }
  if (expectedMutableFileOperand?.snapshot && !phase.approvalPlan?.mutableFileOperand) {
    logWarn(`security: system.run approval script binding missing (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "approval-required",
      message: APPROVAL_SCRIPT_OPERAND_BINDING_DENIED_MESSAGE,
    });
    return;
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
    });
    return;
  }

  const execArgv = resolveSystemRunExecArgv({
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

  const useMacAppExec = opts.preferMacAppExecHost;
  if (useMacAppExec) {
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
      approvalDecision: phase.approvalDecision,
    };
    const response = await opts.runViaMacAppExecHost({
      approvals: phase.approvals,
      request: execRequest,
    });
    if (!response) {
      if (opts.execHostEnforced || !opts.execHostFallbackAllowed) {
        await sendSystemRunDenied(opts, phase.execution, {
          reason: "companion-unavailable",
          message: "COMPANION_APP_UNAVAILABLE: macOS app exec host unreachable",
        });
        return;
      }
    } else if (!response.ok) {
      await sendSystemRunDenied(opts, phase.execution, {
        reason: normalizeDeniedReason(response.error.reason),
        message: response.error.message,
      });
      return;
    } else {
      const result: ExecHostRunResult = response.payload;
      await sendSystemRunCompleted(opts, phase.execution, result, JSON.stringify(result));
      return;
    }
  }

  if (phase.policy.approvalDecision === "allow-always" && phase.inlineEvalHit === null) {
    const patterns = phase.policy.analysisOk
      ? persistAllowAlwaysPatterns({
          approvals: phase.approvals.file,
          agentId: phase.agentId,
          segments: phase.segments,
          cwd: phase.cwd,
          env: phase.env,
          platform: process.platform,
          strictInlineEval: phase.strictInlineEval,
        })
      : [];
    if (patterns.length === 0) {
      addDurableCommandApproval(phase.approvals.file, phase.agentId, phase.commandText);
    }
  }

  recordAllowlistMatchesUse({
    approvals: phase.approvals.file,
    agentId: phase.agentId,
    matches: phase.allowlistMatches,
    command: phase.commandText,
    resolvedPath: resolveApprovalAuditTrustPath(phase.segments[0]?.resolution ?? null, phase.cwd),
  });

  if (phase.needsScreenRecording) {
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "permission:screenRecording",
      message: "PERMISSION_MISSING: screenRecording",
    });
    return;
  }

  const result = await opts.runCommand(execArgv, phase.cwd, phase.env, phase.timeoutMs);
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

export async function handleSystemRunInvoke(opts: HandleSystemRunInvokeOptions): Promise<void> {
  const parsed = await parseSystemRunPhase(opts);
  if (!parsed) {
    return;
  }
  const policyPhase = await evaluateSystemRunPolicyPhase(opts, parsed);
  if (!policyPhase) {
    return;
  }
  await executeSystemRunPhase(opts, policyPhase);
}
