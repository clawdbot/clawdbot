/**
 * Gateway-host exec approval and allowlist handling.
 * Evaluates shell allowlists, auto-review, durable approvals, follow-up routing,
 * and approved command execution for gateway-backed exec calls.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  buildCronExecOperationBinding,
  consumeCronStandingGrant,
  validateCronStandingGrant,
} from "../gateway/operator-approval-standing-grants.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { describeInterpreterInlineEval } from "../infra/command-analysis/inline-eval.js";
import { detectPolicyInlineEval } from "../infra/command-analysis/policy.js";
import { lookupCronRunExecSource } from "../infra/cron-run-exec-source.js";
import { emitTrustedSecurityEvent } from "../infra/diagnostic-events.js";
import {
  type AllowAlwaysPersistenceDecision,
  commitExecAuthorizationLocked,
  commandRequiresSecurityAuditSuppressionApproval,
  createExecApprovalPolicySnapshot,
  type ExecAsk,
  type ExecApprovalUsageAuthorization,
  resolveExecApprovalAllowedDecisions,
  type ExecSecurity,
  buildEnforcedShellCommand,
  evaluateShellAllowlistWithAuthorization,
  hasDurableExecApproval,
  hasExactCommandDurableExecApproval,
  minSecurity,
  resolveApprovalAuditTrustPath,
  resolveExecutionTargetTrustPath,
  resolveAllowAlwaysPersistenceDecision,
  resolveDurableExecApprovalRequirement,
  resolveExecApprovalUnavailableDecisions,
  requiresExecApproval,
} from "../infra/exec-approvals.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import {
  defaultExecAutoReviewer,
  resolveExecAutoReviewDecision,
  type ExecAutoReviewDecision,
  type ExecAutoReviewer,
} from "../infra/exec-auto-review.js";
import type { SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
import { isBlockedShellWrapperCommand } from "../infra/exec-wrapper-resolution.js";
import {
  prepareSystemRunMutableFileBinding,
  revalidateSystemRunMutableFileBinding,
  type SystemRunMutableFileBinding,
} from "../infra/system-run-approval-binding.js";
import {
  GatewayDrainingError,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { isNativeApprovalChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { markBackgrounded, tail } from "./bash-process-registry.js";
import { formatExecApprovalContinuationSourceOutput } from "./bash-tools.exec-approval-output.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import {
  buildHeadlessExecApprovalDeniedMessage,
  buildExecApprovalFollowupTarget,
  buildExecApprovalPendingToolResult,
  createExecApprovalRequestRoute,
  resolveExecApprovalWaitOutcome,
  resolveExecHostApprovalContext,
  sendExecApprovalFollowupResult,
} from "./bash-tools.exec-host-shared.js";
import { appendExecTimeoutRetryGuidance } from "./bash-tools.exec-output.js";
import {
  createApprovalSlug,
  normalizeNotifyOutput,
  runExecProcess,
} from "./bash-tools.exec-runtime.js";
import type {
  ExecElevatedDefaults,
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
  ExecToolApprovalReview,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import { abortable } from "./embedded-agent-runner/run/abortable.js";
import type { AgentToolResult } from "./runtime/index.js";

/** Full input bundle for gateway-host allowlist and approval processing. */
type ProcessGatewayAllowlistParams = {
  command: string;
  workdir: string;
  env: Record<string, string>;
  pathPrepend?: string[];
  requestedEnv?: Record<string, string>;
  pty: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview?: boolean;
  autoReviewer?: ExecAutoReviewer;
  signal?: AbortSignal;
  safeBins: Set<string>;
  safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  trigger?: string;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
  onApprovalReview?: (review: ExecToolApprovalReview) => void;
  /** Session UUID active when the approval was requested; pins the followup. */
  sessionId?: string;
  /** Session-store template, so the direct/denied followup can detect a rebind. */
  sessionStore?: string;
  bashElevated?: ExecElevatedDefaults;
  approvalReviewerDeviceId?: string;
  nonInteractiveApproval?: boolean;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  scopeKey?: string;
  approvalFollowupText?: string;
  approvalFollowup?: ExecApprovalFollowupFactory;
  approvalFollowupMode?: "agent" | "direct";
  warnings: string[];
  notifySessionKey?: string;
  approvalRunningNoticeMs: number;
  maxOutput: number;
  pendingMaxOutput: number;
  processContinuationAvailable?: boolean;
  trustedSafeBinDirs?: ReadonlySet<string>;
};

/** Gateway allowlist outcome before command execution continues. */
type ProcessGatewayAllowlistResult = {
  execCommandOverride?: string;
  allowWithoutEnforcedCommand?: boolean;
  revalidateBeforeExecution?: () => Promise<AgentToolResult<ExecToolDetails> | undefined>;
  pendingResult?: AgentToolResult<ExecToolDetails>;
  deniedResult?: AgentToolResult<ExecToolDetails>;
};

const ONE_SHOT_ALLOW_ALWAYS: AllowAlwaysPersistenceDecision = {
  kind: "one-shot",
  reasons: ["no-reusable-pattern"],
};
// Keep compound reviews bounded independently of the serialized prompt cap.
const MAX_GATEWAY_AUTO_REVIEW_CANDIDATES = 64;

function publishGatewayGuardianReview(
  params: ProcessGatewayAllowlistParams,
  status: ExecToolApprovalReview["status"],
  decision?: ExecAutoReviewDecision,
): void {
  if (!params.toolCallId) {
    return;
  }
  const approvalReviewOutcome =
    status === "in_progress" ? "reviewing" : status === "approved" ? "approved" : "denied";
  const review: ExecToolApprovalReview = {
    id: `guardian:${params.toolCallId}`,
    label: "Guardian",
    status,
    ...(decision ? { riskLevel: decision.risk, rationale: decision.rationale } : {}),
  };
  // Preserve terminal evidence before synchronous listeners can change reviewed operands.
  if (status !== "in_progress") {
    params.onApprovalReview?.(review);
  }
  if (!params.runId) {
    return;
  }
  emitAgentEvent({
    runId: params.runId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    stream: "tool",
    data: {
      phase: "review",
      name: "exec",
      toolCallId: params.toolCallId,
      hideFromChannelProgress: true,
      approvalReviewOutcome,
      review,
    },
  });
}

function hasGatewayAllowlistMiss(params: {
  hostSecurity: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
}): boolean {
  return (
    params.hostSecurity === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied) &&
    !params.durableApprovalSatisfied
  );
}

function formatOutcomeExitLabel(outcome: { exitCode: number | null; timedOut: boolean }): string {
  return outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
}

function formatBytes(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.max(0, Math.round(value))} bytes`;
}

function formatDiagnosticsContents(manifest: Record<string, unknown>): string[] {
  const contents = Array.isArray(manifest.contents) ? manifest.contents : [];
  if (contents.length === 0) {
    return [];
  }
  const lines = [`Contents (${contents.length} files):`];
  for (const entry of contents.slice(0, 12)) {
    if (!isRecord(entry)) {
      continue;
    }
    const path = typeof entry.path === "string" ? entry.path : "";
    if (!path) {
      continue;
    }
    const bytes = formatBytes(entry.bytes);
    lines.push(`- ${bytes ? `${path} (${bytes})` : path}`);
  }
  if (contents.length > 12) {
    lines.push(`- ... ${contents.length - 12} more`);
  }
  return lines;
}

function formatDiagnosticsPrivacy(manifest: Record<string, unknown>): string[] {
  const privacy = isRecord(manifest.privacy) ? manifest.privacy : null;
  if (!privacy) {
    return [];
  }
  const lines = ["Privacy:"];
  if (typeof privacy.payloadFree === "boolean") {
    lines.push(`- payload-free: ${privacy.payloadFree ? "yes" : "no"}`);
  }
  if (typeof privacy.rawLogsIncluded === "boolean") {
    lines.push(`- raw logs included: ${privacy.rawLogsIncluded ? "yes" : "no"}`);
  }
  const notes = Array.isArray(privacy.notes)
    ? privacy.notes.filter((note): note is string => typeof note === "string")
    : [];
  for (const note of notes.slice(0, 4)) {
    lines.push(`- ${note}`);
  }
  return lines.length > 1 ? lines : [];
}

function formatDiagnosticsExportSuccess(aggregated: string): string {
  const trimmed = aggregated.trim();
  if (!trimmed) {
    return "Diagnostics export completed, but no JSON output was returned.";
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return trimmed;
    }
    const manifest = isRecord(parsed.manifest) ? parsed.manifest : {};
    const lines = ["Diagnostics export created.", "", "Local Gateway bundle:"];
    const bundlePath = typeof parsed.path === "string" ? parsed.path : "";
    if (bundlePath) {
      lines.push(`Path: ${bundlePath}`);
    }
    const bytes = formatBytes(parsed.bytes);
    if (bytes) {
      lines.push(`Size: ${bytes}`);
    }
    if (typeof manifest.generatedAt === "string") {
      lines.push(`Generated at: ${manifest.generatedAt}`);
    }
    if (typeof manifest.openclawVersion === "string") {
      lines.push(`OpenClaw version: ${manifest.openclawVersion}`);
    }
    const contents = formatDiagnosticsContents(manifest);
    if (contents.length > 0) {
      lines.push("", ...contents);
    }
    const privacy = formatDiagnosticsPrivacy(manifest);
    if (privacy.length > 0) {
      lines.push("", ...privacy);
    }
    return lines.join("\n");
  } catch {
    return trimmed;
  }
}

function emitGatewayExecApprovalSecurityEvent(params: {
  action: "exec.approval.requested" | "exec.approval.approved" | "exec.approval.denied";
  outcome: "success" | "denied" | "error";
  severity: "low" | "medium" | "high";
  agentId?: string | null;
  reason?: string;
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  host: "gateway";
  segmentCount: number;
  trigger?: string;
  decision?: string | null;
}) {
  emitTrustedSecurityEvent({
    category: "approval",
    action: params.action,
    outcome: params.outcome,
    severity: params.severity,
    actor: {
      kind: "agent",
    },
    target: {
      kind: "tool",
      name: "system.exec",
      owner: params.host,
    },
    policy: {
      id: "exec.approval",
      decision:
        params.action === "exec.approval.requested"
          ? "ask"
          : params.outcome === "success"
            ? "allow"
            : "deny",
      ...(params.reason ? { reason: params.reason } : {}),
    },
    control: {
      id: "exec.approval",
      family: "approval",
    },
    ...(params.reason ? { reason: params.reason } : {}),
    attributes: {
      host: params.host,
      security: params.hostSecurity,
      ask: params.hostAsk,
      segment_count: params.segmentCount,
      has_agent_id: Boolean(params.agentId?.trim()),
      ...(params.trigger ? { trigger: params.trigger } : {}),
      ...(params.decision ? { decision: params.decision } : {}),
    },
  });
}

function formatDiagnosticsExportFailure(params: {
  outcome: { status: string; reason?: string; aggregated: string };
  exitLabel: string;
}): string {
  const output = normalizeNotifyOutput(tail(params.outcome.aggregated || "", 4000));
  const lines = [`Diagnostics export failed (${params.exitLabel}).`];
  if (params.outcome.reason) {
    lines.push(params.outcome.reason);
  }
  if (output) {
    lines.push("", output);
  }
  return lines.join("\n");
}

function buildGatewayExecApprovalFollowupSummary(params: {
  approvalId: string;
  sessionId: string;
  outcome: ExecApprovalFollowupOutcome;
  trigger?: string;
  approvalFollowupText?: string;
}): string {
  const exitLabel = formatOutcomeExitLabel(params.outcome);
  let summary: string;
  if (params.trigger === "diagnostics") {
    const diagnosticsText =
      params.outcome.status === "completed" && params.outcome.exitCode === 0
        ? formatDiagnosticsExportSuccess(params.outcome.aggregated)
        : formatDiagnosticsExportFailure({ outcome: params.outcome, exitLabel });
    const followupText = params.approvalFollowupText?.trim();
    const body = [diagnosticsText, followupText].filter(Boolean).join("\n\n");
    summary = `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})\n${body}`;
  } else {
    const output = formatExecApprovalContinuationSourceOutput([
      { label: "output", value: params.outcome.aggregated },
    ]);
    summary = output
      ? `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})\n${output}`
      : `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})`;
  }
  return appendExecTimeoutRetryGuidance(summary, params.outcome.exitReason);
}

function shouldAwaitGatewayApprovalInline(params: {
  turnSourceChannel?: string;
  approvalFollowupMode?: "agent" | "direct";
  trigger?: string;
}): boolean {
  if (params.approvalFollowupMode !== undefined) {
    return false;
  }
  // Scheduled runs cannot recover from an "approval-pending" handoff: the
  // isolated session ends and authority-close cancels the parked approval
  // seconds later. Wait inline so a connected approval client gets the full
  // approval window; allow-always there mints the standing grant and this
  // occurrence executes. Cron jobs are single-flight, so waiting cannot
  // stack runs.
  if (params.trigger === "cron") {
    return true;
  }
  // Native chat approval clients (Telegram /approve, Discord buttons,
  // etc.) resolve the approval back into the same session, so the agent can
  // wait inline and return the real exec output as the tool result. This
  // mirrors the webchat path that PR #85239 fixed; without it the agent run
  // terminates on the "approval-pending" tool result and the operator must
  // send a follow-up chat message to recover the turn (issue #93918).
  return isNativeApprovalChannel(normalizeMessageChannel(params.turnSourceChannel));
}

function buildGatewayExecApprovalDeniedToolResult(params: {
  approvalId?: string;
  deniedReason: string;
  command: string;
  cwd: string;
}): AgentToolResult<ExecToolDetails> {
  const denialContext = params.approvalId
    ? `gateway id=${params.approvalId}, ${params.deniedReason}`
    : params.deniedReason;
  const text = `Exec denied (${denialContext}): ${params.command}`;
  return {
    content: [{ type: "text", text }],
    details: {
      status: "failed",
      exitCode: null,
      durationMs: 0,
      aggregated: text,
      timedOut: params.deniedReason.includes("timeout"),
      cwd: params.cwd,
    },
  };
}

/** Rechecks a gateway approval binding at the caller's final spawn boundary. */
async function revalidateGatewayExecApprovalBinding(params: {
  binding: SystemRunMutableFileBinding;
  command: string;
  cwd: string;
}): Promise<AgentToolResult<ExecToolDetails> | undefined> {
  const current = await revalidateSystemRunMutableFileBinding({
    binding: params.binding,
    cwd: params.cwd,
  });
  return current.ok
    ? undefined
    : buildGatewayExecApprovalDeniedToolResult({
        deniedReason: current.message,
        command: params.command,
        cwd: params.cwd,
      });
}

async function resolveGatewayExecApprovalFollowupText(params: {
  approvalFollowup?: ExecApprovalFollowupFactory;
  approvalId: string;
  sessionId: string;
  trigger?: string;
  outcome: ExecApprovalFollowupOutcome;
}): Promise<string | undefined> {
  if (!params.approvalFollowup) {
    return undefined;
  }
  try {
    return await params.approvalFollowup({
      approvalId: params.approvalId,
      sessionId: params.sessionId,
      trigger: params.trigger,
      outcome: params.outcome,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Diagnostics follow-up failed: ${message}`;
  }
}

/** Processes gateway exec policy and returns execution/approval/denial outcome. */
export async function processGatewayAllowlist(
  params: ProcessGatewayAllowlistParams,
): Promise<ProcessGatewayAllowlistResult> {
  const { approvals, hostSecurity, hostAsk, askFallback } = await resolveExecHostApprovalContext({
    agentId: params.agentId,
    security: params.security,
    ask: params.ask,
    host: "gateway",
  });
  const evaluationPolicySnapshot = createExecApprovalPolicySnapshot({
    file: approvals.file,
    agentId: params.agentId,
  });
  const fallbackSecurity = minSecurity(hostSecurity, askFallback);
  const allowlistEval = await evaluateShellAllowlistWithAuthorization({
    command: params.command,
    allowlist: approvals.allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.workdir,
    env: params.env,
    platform: process.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
  });
  const allowlistMatches = allowlistEval.allowlistMatches;
  const analysisOk = allowlistEval.analysisOk;
  const allowlistSatisfied =
    hostSecurity === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
  const durableApprovalSatisfied = hasDurableExecApproval({
    analysisOk,
    segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
    allowlist: approvals.allowlist,
    commandText: params.command,
  });
  const inlineEvalHit =
    params.strictInlineEval === true ? detectPolicyInlineEval(allowlistEval.segments) : null;
  const allowAlwaysPersistence = resolveAllowAlwaysPersistenceDecision({
    segments: allowlistEval.segments,
    cwd: params.workdir,
    env: params.env,
    platform: process.platform,
    commandText: params.command,
    strictInlineEval: params.strictInlineEval === true,
    authorizationPlan: allowlistEval.authorizationPlan,
    runtimePayload: inlineEvalHit !== null,
  });
  if (inlineEvalHit) {
    params.warnings.push(
      `Warning: strict inline-eval mode requires reviewer or explicit approval for ${describeInterpreterInlineEval(
        inlineEvalHit,
      )}.`,
    );
  }
  const exactCommandDurableApprovalSatisfied = hasExactCommandDurableExecApproval({
    allowlist: approvals.allowlist,
    commandText: params.command,
  });
  const allowlistAuthorizationSatisfied = analysisOk && allowlistEval.allowlistSatisfied;
  const shouldPrepareAllowlistExecution =
    hostSecurity === "allowlist" || fallbackSecurity === "allowlist";
  const gatewayEnforcedCommand =
    shouldPrepareAllowlistExecution && analysisOk
      ? process.platform === "win32"
        ? buildEnforcedShellCommand({
            command: params.command,
            segments: allowlistEval.segments,
            platform: process.platform,
          })
        : allowlistEval.authorizationPlan
          ? buildAuthorizedShellCommandFromPlan({
              plan: allowlistEval.authorizationPlan,
              mode: "enforced",
              segmentSatisfiedBy: allowlistEval.segmentSatisfiedBy,
            })
          : { ok: false as const, reason: "authorization plan unavailable" }
      : null;
  let enforcedCommand: string | undefined;
  let allowlistPlanUnavailableReason: string | null = null;
  if (hostSecurity === "allowlist" && analysisOk && allowlistSatisfied) {
    const enforced = gatewayEnforcedCommand ?? {
      ok: false,
      reason: "authorization plan unavailable",
    };
    if (!enforced.ok || !enforced.command) {
      allowlistPlanUnavailableReason =
        ("reason" in enforced ? enforced.reason : undefined) ?? "unsupported platform";
    } else {
      enforcedCommand = enforced.command;
    }
  }
  const fallbackEnforcedCommand =
    fallbackSecurity === "allowlist" &&
    allowlistAuthorizationSatisfied &&
    gatewayEnforcedCommand?.ok === true
      ? gatewayEnforcedCommand.command
      : undefined;
  const fallbackAllowlistAuthorizationSatisfied =
    fallbackSecurity === "allowlist" &&
    (allowlistAuthorizationSatisfied || exactCommandDurableApprovalSatisfied);
  const fallbackAllowlistPlanSatisfied =
    exactCommandDurableApprovalSatisfied || fallbackEnforcedCommand !== undefined;
  // Timeout fallback is current policy, not human approval. Require the live
  // allowlist basis plus an enforceable plan before treating it as executable.
  const applyTimedOutAllowlistFallback = (state: {
    baseDecision: { timedOut: boolean };
    approvedByAsk: boolean;
    deniedReason: string | null;
  }) => {
    if (!state.baseDecision.timedOut || fallbackSecurity !== "allowlist") {
      return state;
    }
    if (!fallbackAllowlistAuthorizationSatisfied) {
      return {
        ...state,
        approvedByAsk: false,
        deniedReason: "approval-timeout: allowlist-miss",
      };
    }
    if (!fallbackAllowlistPlanSatisfied) {
      return {
        ...state,
        approvedByAsk: false,
        deniedReason: "approval-timeout: execution-plan-miss",
      };
    }
    return { ...state, approvedByAsk: true, deniedReason: null };
  };
  const commitExecutionAuthorization = (options: {
    source: ExecApprovalUsageAuthorization["source"];
    resolvedPath?: string;
    allowAlwaysDecision?: AllowAlwaysPersistenceDecision;
  }) => {
    const policyAuthorization =
      options.source === "current-policy" || options.source === "ask-fallback";
    // Exact trust can be the sole basis for bypassing an unavailable execution
    // plan, so derive the durable requirement from the final commit source.
    const durableApprovalRequired =
      options.source === "current-policy"
        ? hostSecurity === "allowlist" &&
          durableApprovalSatisfied &&
          (!analysisOk ||
            !allowlistSatisfied ||
            (exactCommandDurableApprovalSatisfied && allowlistPlanUnavailableReason !== null))
        : options.source === "ask-fallback"
          ? fallbackSecurity === "allowlist" &&
            exactCommandDurableApprovalSatisfied &&
            fallbackEnforcedCommand === undefined
          : false;
    const durableApprovalRequirement = resolveDurableExecApprovalRequirement({
      durableApprovalRequired,
      allowlist: approvals.allowlist,
      commandText: params.command,
    });
    const delayedAuthorization =
      options.source === "explicit-approval" || options.source === "auto-review";
    return commitExecAuthorizationLocked({
      agentId: params.agentId,
      matches: allowlistMatches,
      command: params.command,
      resolvedPath: options.resolvedPath,
      authorization: {
        source: options.source,
        security: options.source === "ask-fallback" ? fallbackSecurity : hostSecurity,
        ask: hostAsk,
        allowlistSatisfied: allowlistAuthorizationSatisfied || durableApprovalSatisfied,
        ...(delayedAuthorization ? { policySnapshot: evaluationPolicySnapshot } : {}),
        requireAutoAllowSkills:
          policyAuthorization && allowlistEval.segmentSatisfiedBy.includes("skills"),
        requireExactCommandApproval:
          policyAuthorization && durableApprovalRequirement === "exact-command",
        requireDurableAllowlistApproval:
          policyAuthorization && durableApprovalRequirement === "segment-allowlist",
      },
      ...(options.allowAlwaysDecision ? { allowAlwaysDecision: options.allowAlwaysDecision } : {}),
    });
  };
  const hasHeredocSegment = allowlistEval.segments.some((segment) =>
    segment.argv.some((token) => token.startsWith("<<")),
  );
  const requiresHeredocApproval =
    hasHeredocSegment && hostSecurity === "allowlist" && analysisOk && allowlistSatisfied;
  const timedOutFallbackRequiresHeredocApproval =
    hasHeredocSegment && fallbackAllowlistAuthorizationSatisfied;
  const requiresInlineEvalApproval = inlineEvalHit !== null;
  // Exact-command durable trust must bypass plan approval: allow-always here
  // persists an `=command:` grant for the raw command text, so unenforceability
  // is moot and re-prompting would make that grant permanently ineffective.
  // Pattern-based durable trust stays gated because enforcement cannot pin the
  // resolved executables for an unenforceable plan.
  const requiresAllowlistPlanApproval =
    hostSecurity === "allowlist" &&
    analysisOk &&
    allowlistSatisfied &&
    !exactCommandDurableApprovalSatisfied &&
    !enforcedCommand &&
    allowlistPlanUnavailableReason !== null;
  const requiresSecurityAuditSuppressionApproval =
    commandRequiresSecurityAuditSuppressionApproval({
      command: params.command,
      cwd: params.workdir,
      env: params.env,
      segments: allowlistEval.segments,
    }) && !(hostSecurity === "full" && hostAsk === "off");
  const policyRequiresAsk =
    requiresExecApproval({
      ask: hostAsk,
      security: hostSecurity,
      analysisOk,
      allowlistSatisfied,
      durableApprovalSatisfied,
    }) ||
    requiresAllowlistPlanApproval ||
    requiresHeredocApproval ||
    requiresInlineEvalApproval ||
    requiresSecurityAuditSuppressionApproval;
  const denyHeadlessApproval = (): ProcessGatewayAllowlistResult => {
    const text = params.approvalFollowupText
      ? `${params.approvalFollowupText}\nCommand: ${params.command}`
      : `Exec denied (approval_required): ${params.command}`;
    return {
      deniedResult: {
        content: [{ type: "text", text }],
        details: {
          status: "failed",
          exitCode: null,
          failureKind: "approval_required",
          durationMs: 0,
          aggregated: text,
          timedOut: false,
          cwd: params.workdir,
        },
      },
    };
  };
  if (requiresHeredocApproval) {
    params.warnings.push(
      "Warning: heredoc execution requires reviewer or explicit approval in allowlist mode.",
    );
  }
  if (requiresAllowlistPlanApproval) {
    params.warnings.push(
      `Warning: allowlist auto-execution is unavailable on ${process.platform}; reviewer or explicit approval is required.`,
    );
  }
  if (policyRequiresAsk && params.nonInteractiveApproval) {
    return denyHeadlessApproval();
  }
  const shouldDenyUnpromptedShellExpansion =
    requiresAllowlistPlanApproval &&
    allowlistPlanUnavailableReason === "shell expansion in enforced arguments" &&
    hostAsk === "off" &&
    askFallback === "deny";
  if (shouldDenyUnpromptedShellExpansion) {
    const deniedReason = "ask-fallback-deny: execution-plan-miss";
    // The allowlist matched, but the gateway cannot bind an enforceable command.
    // With prompting disabled, apply the fail-closed fallback before registration.
    emitGatewayExecApprovalSecurityEvent({
      action: "exec.approval.denied",
      outcome: "denied",
      severity: "medium",
      agentId: params.agentId,
      reason: deniedReason,
      hostSecurity,
      hostAsk,
      host: "gateway",
      segmentCount: allowlistEval.segments.length,
      trigger: params.trigger,
    });
    return {
      deniedResult: buildGatewayExecApprovalDeniedToolResult({
        deniedReason,
        command: params.command,
        cwd: params.workdir,
      }),
    };
  }
  let mutableFileBinding: SystemRunMutableFileBinding | undefined;
  const durableApprovalRequiresBinding =
    hostSecurity === "allowlist" &&
    durableApprovalSatisfied &&
    (!analysisOk ||
      !allowlistSatisfied ||
      (exactCommandDurableApprovalSatisfied && allowlistPlanUnavailableReason !== null));
  if (policyRequiresAsk || durableApprovalRequiresBinding) {
    // Durable text grants cannot authorize future bytes. Prepare before they
    // suppress prompting so mutable operands always return to one-shot review.
    const prepared = await prepareSystemRunMutableFileBinding({
      command: analysisOk
        ? { kind: "segments", segments: allowlistEval.segments }
        : { kind: "shell", text: params.command },
      cwd: params.workdir,
      env: params.env,
    });
    if (!prepared.ok) {
      return {
        deniedResult: buildGatewayExecApprovalDeniedToolResult({
          deniedReason: prepared.message,
          command: params.command,
          cwd: params.workdir,
        }),
      };
    }
    mutableFileBinding = prepared.binding;
  }
  const mutableFileApprovalRequiresOneShot = (mutableFileBinding?.operands.length ?? 0) > 0;
  // Cron standing grants: a prior allow-always for this exact job + operation
  // minted a scoped SQLite grant instead of a JSON allowlist digest. Consult it
  // before prompting; any validation failure falls through to the normal prompt
  // path (fail closed to prompting, never to silent execution or denial).
  // Special approval classes (inline eval, heredoc, audit suppression) and
  // mutable operands keep prompting — mirroring one-shot durable-trust guards.
  const cronExecutionSource =
    params.runId && params.agentId ? lookupCronRunExecSource(params.runId) : undefined;
  const cronStandingGrantEligible =
    policyRequiresAsk &&
    // Mirror durable-approval semantics: ask "always" and security "deny"
    // always keep their prompt/deny behavior regardless of standing trust.
    hostAsk !== "always" &&
    hostSecurity !== "deny" &&
    cronExecutionSource !== undefined &&
    cronExecutionSource.agentId === params.agentId &&
    !mutableFileApprovalRequiresOneShot &&
    !requiresInlineEvalApproval &&
    !requiresHeredocApproval &&
    !requiresSecurityAuditSuppressionApproval;
  if (cronStandingGrantEligible) {
    const grantLookup = {
      agentId: cronExecutionSource.agentId,
      cronJobId: cronExecutionSource.jobId,
      jobConfigRevision: cronExecutionSource.jobConfigRevision,
      operationBinding: buildCronExecOperationBinding({
        command: params.command,
        cwd: params.workdir,
        env: params.requestedEnv,
      }),
    };
    let grantCheck: ReturnType<typeof validateCronStandingGrant> | undefined;
    try {
      grantCheck = validateCronStandingGrant(grantLookup);
    } catch {
      grantCheck = undefined;
    }
    if (grantCheck?.outcome === "consumed") {
      const emitGrantEvent = (approved: boolean, reason: string) =>
        emitGatewayExecApprovalSecurityEvent({
          action: approved ? "exec.approval.approved" : "exec.approval.denied",
          outcome: approved ? "success" : "denied",
          severity: "medium",
          agentId: params.agentId,
          reason,
          hostSecurity,
          hostAsk,
          host: "gateway",
          segmentCount: allowlistEval.segments.length,
          trigger: params.trigger,
          decision: "standing-grant",
        });
      return {
        execCommandOverride: enforcedCommand,
        // Durable authority is recorded only at the final effect: awaited
        // pre-spawn work (script preflight) can outlive a revocation or job
        // edit, so the grant is re-verified and consumed right before the
        // process spawns and any failure denies instead of executing.
        revalidateBeforeExecution: async () => {
          let grantUse: ReturnType<typeof consumeCronStandingGrant> | undefined;
          try {
            grantUse = consumeCronStandingGrant(grantLookup);
          } catch {
            grantUse = undefined;
          }
          if (grantUse?.outcome === "consumed") {
            emitGrantEvent(
              true,
              `standing-grant grant=${grantUse.grant.grantId} approval=${grantUse.grant.mintedByApprovalId}`,
            );
            return undefined;
          }
          const invalidReason = grantUse?.outcome ?? "grant-store-unavailable";
          emitGrantEvent(false, `standing-grant-invalidated ${invalidReason}`);
          return buildGatewayExecApprovalDeniedToolResult({
            deniedReason: `standing grant no longer valid (${invalidReason}); the next occurrence will prompt for approval again`,
            command: params.command,
            cwd: params.workdir,
          });
        },
      };
    }
  }
  const requiresAsk =
    policyRequiresAsk || (durableApprovalRequiresBinding && mutableFileApprovalRequiresOneShot);
  // Mutable operands and unenforceable patterns cannot authorize later cwd/env bindings.
  const approvalAllowAlwaysPersistence =
    mutableFileApprovalRequiresOneShot ||
    (requiresAllowlistPlanApproval && allowAlwaysPersistence.kind === "patterns")
      ? ONE_SHOT_ALLOW_ALWAYS
      : allowAlwaysPersistence;
  const approvalAllowedDecisions = resolveExecApprovalAllowedDecisions({
    ask: hostAsk,
    allowAlwaysPersistence: approvalAllowAlwaysPersistence,
  });
  const approvalUnavailableDecisions = resolveExecApprovalUnavailableDecisions({
    ask: hostAsk,
    allowAlwaysPersistence: approvalAllowAlwaysPersistence,
  });
  const unavailableDecisionRequestParams =
    approvalUnavailableDecisions.length > 0
      ? { unavailableDecisions: approvalUnavailableDecisions }
      : {};
  if (requiresSecurityAuditSuppressionApproval) {
    params.warnings.push(
      "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.",
    );
  }
  if (requiresAsk) {
    if (params.nonInteractiveApproval) {
      return denyHeadlessApproval();
    }
    if (!mutableFileBinding) {
      return {
        deniedResult: buildGatewayExecApprovalDeniedToolResult({
          deniedReason: "SYSTEM_RUN_DENIED: mutable file approval binding is unavailable",
          command: params.command,
          cwd: params.workdir,
        }),
      };
    }
    const approvalMutableFileBinding = mutableFileBinding;
    const revalidateBeforeExecution =
      approvalMutableFileBinding.operands.length > 0
        ? () =>
            revalidateGatewayExecApprovalBinding({
              binding: approvalMutableFileBinding,
              command: params.command,
              cwd: params.workdir,
            })
        : undefined;
    const authorizationCandidates = allowlistEval.authorizationPlan?.ok
      ? allowlistEval.authorizationPlan.groups.flatMap((group) => group.candidates)
      : [];
    const executableCandidates = authorizationCandidates.filter(
      (_candidate, index) => allowlistEval.segmentSatisfiedBy[index] !== "safeBuiltins",
    );
    const autoReviewSingleSegment =
      authorizationCandidates.length === 1 ? executableCandidates[0]?.sourceSegment : undefined;
    const autoReviewResolvedPath = autoReviewSingleSegment
      ? resolveExecutionTargetTrustPath(autoReviewSingleSegment.resolution, params.workdir)
      : undefined;
    const autoReviewEnforcedCommand =
      gatewayEnforcedCommand?.ok === true ? gatewayEnforcedCommand.command : undefined;
    const autoReviewHasExecutableBinding =
      authorizationCandidates.length <= MAX_GATEWAY_AUTO_REVIEW_CANDIDATES &&
      executableCandidates.length > 0 &&
      autoReviewEnforcedCommand !== undefined &&
      executableCandidates.every(({ sourceSegment }) =>
        Boolean(
          sourceSegment.resolution?.policyBlocked !== true &&
          (sourceSegment.resolution?.wrapperChain?.length ?? 0) === 0 &&
          !isBlockedShellWrapperCommand(sourceSegment.argv) &&
          resolveExecutionTargetTrustPath(sourceSegment.resolution, params.workdir),
        ),
      );
    const canAutoReviewApprovalMiss =
      params.autoReview === true &&
      hostAsk !== "always" &&
      autoReviewHasExecutableBinding &&
      !requiresHeredocApproval &&
      !requiresSecurityAuditSuppressionApproval;
    let autoReviewRequiresHumanApproval =
      (params.autoReview === true && hostAsk !== "always" && !autoReviewHasExecutableBinding) ||
      requiresAllowlistPlanApproval ||
      requiresHeredocApproval ||
      requiresSecurityAuditSuppressionApproval;
    if (canAutoReviewApprovalMiss && autoReviewEnforcedCommand) {
      const reviewer = params.autoReviewer ?? defaultExecAutoReviewer;
      publishGatewayGuardianReview(params, "in_progress");
      const pendingDecision = resolveExecAutoReviewDecision(reviewer, {
        command: autoReviewEnforcedCommand,
        argv: autoReviewSingleSegment?.argv,
        resolvedPath: autoReviewResolvedPath,
        cwd: params.workdir,
        envKeys: Object.keys(params.requestedEnv ?? {}).toSorted(),
        host: "gateway",
        reason: requiresInlineEvalApproval
          ? "strict-inline-eval"
          : hasGatewayAllowlistMiss({
                hostSecurity,
                analysisOk,
                allowlistSatisfied,
                durableApprovalSatisfied,
              })
            ? "allowlist-miss"
            : "approval-required",
        analysis: {
          parsed: analysisOk,
          allowlistMatched: allowlistSatisfied,
          durableApprovalMatched: durableApprovalSatisfied,
          inlineEval: requiresInlineEvalApproval,
          heredoc: requiresHeredocApproval,
        },
        agent: {
          id: params.agentId,
          sessionKey: params.sessionKey,
        },
      });
      let decision: Awaited<typeof pendingDecision>;
      try {
        // Custom reviewers may never settle; cancellation must not retain approval authority.
        decision = params.signal
          ? await abortable(params.signal, pendingDecision)
          : await pendingDecision;
        params.signal?.throwIfAborted();
      } catch (error) {
        publishGatewayGuardianReview(params, "aborted");
        throw error;
      }
      publishGatewayGuardianReview(
        params,
        decision.decision === "allow-once" ? "approved" : "denied",
        decision,
      );
      if (
        decision.decision === "allow-once" &&
        decision.risk === "low" &&
        autoReviewEnforcedCommand
      ) {
        const deniedResult = await revalidateGatewayExecApprovalBinding({
          binding: approvalMutableFileBinding,
          command: params.command,
          cwd: params.workdir,
        });
        if (deniedResult) {
          return { deniedResult };
        }
        params.warnings.push(
          `Exec auto-review allowed once (risk=${decision.risk}): ${decision.rationale}`,
        );
        emitGatewayExecApprovalSecurityEvent({
          action: "exec.approval.approved",
          outcome: "success",
          severity: "medium",
          agentId: params.agentId,
          hostSecurity,
          hostAsk,
          host: "gateway",
          segmentCount: allowlistEval.segments.length,
          trigger: params.trigger,
          decision: "auto-review",
        });
        await commitExecutionAuthorization({
          source: "auto-review",
          resolvedPath: autoReviewResolvedPath,
        });
        return {
          execCommandOverride: autoReviewEnforcedCommand,
          ...(revalidateBeforeExecution ? { revalidateBeforeExecution } : {}),
        };
      }
      params.warnings.push(
        `Exec auto-review deferred to human approval (risk=${decision.risk}): ${decision.rationale}`,
      );
      autoReviewRequiresHumanApproval = true;
    }

    const registerGatewayApproval = async (approvalId: string) =>
      await registerExecApprovalRequestForHostOrThrow({
        approvalId,
        command: params.command,
        env: params.requestedEnv,
        workdir: params.workdir,
        host: "gateway",
        security: hostSecurity,
        ask: hostAsk,
        ...unavailableDecisionRequestParams,
        commandHighlighting: params.commandHighlighting,
        warningText: params.warnings.join("\n").trim() || undefined,
        ...buildExecApprovalRequesterContext({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        }),
        sessionId: params.sessionId,
        runId: params.runId,
        toolCallId: params.toolCallId,
        trigger: params.trigger,
        approvalReviewerDeviceIds: params.approvalReviewerDeviceId
          ? [params.approvalReviewerDeviceId]
          : undefined,
        resolvedPath: resolveApprovalAuditTrustPath(
          allowlistEval.segments[0]?.resolution ?? null,
          params.workdir,
        ),
        ...buildExecApprovalTurnSourceContext(params),
      });
    const approvalRoute = await createExecApprovalRequestRoute({
      warnings: params.warnings,
      approvalRunningNoticeMs: params.approvalRunningNoticeMs,
      createApprovalSlug,
      turnSourceChannel: params.turnSourceChannel,
      turnSourceAccountId: params.turnSourceAccountId,
      register: registerGatewayApproval,
      askFallback,
      resolveTimedOut: (state) => {
        const adjusted = applyTimedOutAllowlistFallback(state);
        return {
          approvedByAsk: adjusted.approvedByAsk,
          deniedReason: adjusted.deniedReason,
        };
      },
      requiresExplicitApproval: requiresInlineEvalApproval,
      requiresAutoReviewHumanApproval:
        autoReviewRequiresHumanApproval ||
        requiresHeredocApproval ||
        timedOutFallbackRequiresHeredocApproval,
    });
    const {
      approvalId,
      approvalSlug,
      warningText,
      expiresAtMs,
      preResolvedDecision,
      initiatingSurface,
      sentApproverDms,
      unavailableReason,
    } = approvalRoute;
    emitGatewayExecApprovalSecurityEvent({
      action: "exec.approval.requested",
      outcome: "success",
      severity: "low",
      agentId: params.agentId,
      hostSecurity,
      hostAsk,
      host: "gateway",
      segmentCount: allowlistEval.segments.length,
      trigger: params.trigger,
    });
    if (approvalRoute.kind === "inline") {
      const strictInlineEvalDecision = approvalRoute.state;

      if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) {
        const inlineDeniedReason = strictInlineEvalDecision.deniedReason ?? "approval-required";
        emitGatewayExecApprovalSecurityEvent({
          action: "exec.approval.denied",
          outcome: "denied",
          severity: "medium",
          agentId: params.agentId,
          reason: inlineDeniedReason,
          hostSecurity,
          hostAsk,
          host: "gateway",
          segmentCount: allowlistEval.segments.length,
          trigger: params.trigger,
          decision: preResolvedDecision,
        });
        throw new Error(
          buildHeadlessExecApprovalDeniedMessage({
            trigger: params.trigger,
            host: "gateway",
            security: hostSecurity,
            ask: hostAsk,
            askFallback,
          }),
        );
      }

      const currentBinding = await revalidateSystemRunMutableFileBinding({
        binding: approvalMutableFileBinding,
        cwd: params.workdir,
      });
      if (!currentBinding.ok) {
        return {
          deniedResult: buildGatewayExecApprovalDeniedToolResult({
            approvalId,
            deniedReason: currentBinding.message,
            command: params.command,
            cwd: params.workdir,
          }),
        };
      }

      emitGatewayExecApprovalSecurityEvent({
        action: "exec.approval.approved",
        outcome: "success",
        severity: "medium",
        agentId: params.agentId,
        hostSecurity,
        hostAsk,
        host: "gateway",
        segmentCount: allowlistEval.segments.length,
        trigger: params.trigger,
        decision: null,
      });
      await commitExecutionAuthorization({
        source: "ask-fallback",
        resolvedPath: resolveApprovalAuditTrustPath(
          allowlistEval.segments[0]?.resolution ?? null,
          params.workdir,
        ),
      });
      const execCommandOverride =
        fallbackSecurity === "allowlist" ? fallbackEnforcedCommand : enforcedCommand;
      return {
        execCommandOverride,
        allowWithoutEnforcedCommand: execCommandOverride === undefined,
        ...(revalidateBeforeExecution ? { revalidateBeforeExecution } : {}),
      };
    }
    const resolvedPath = resolveApprovalAuditTrustPath(
      allowlistEval.segments[0]?.resolution ?? null,
      params.workdir,
    );
    const resolveApprovalForExecution = async (onFailure: () => void | Promise<void>) => {
      const approvalOutcome = await resolveExecApprovalWaitOutcome({
        approvalId,
        preResolvedDecision,
        signal: params.signal,
        askFallback,
        resolveTimedOut: (state) => {
          const adjusted = applyTimedOutAllowlistFallback(state);
          return {
            approvedByAsk: adjusted.approvedByAsk,
            deniedReason: adjusted.deniedReason,
          };
        },
        requiresExplicitApproval: requiresInlineEvalApproval,
        requiresAutoReviewHumanApproval:
          autoReviewRequiresHumanApproval ||
          requiresHeredocApproval ||
          timedOutFallbackRequiresHeredocApproval,
      });
      if (approvalOutcome.kind === "run-aborted") {
        return {
          deniedReason: "run-aborted",
          requestFailed: false,
          runAborted: true,
          authorizationSource: "explicit-approval" as const,
          allowAlwaysDecision: undefined,
        };
      }
      if (approvalOutcome.kind === "request-failed") {
        await onFailure();
        emitGatewayExecApprovalSecurityEvent({
          action: "exec.approval.denied",
          outcome: "error",
          severity: "high",
          agentId: params.agentId,
          reason: "approval-request-failed",
          hostSecurity,
          hostAsk,
          host: "gateway",
          segmentCount: allowlistEval.segments.length,
          trigger: params.trigger,
        });
        return {
          deniedReason: "approval-request-failed",
          requestFailed: true,
          authorizationSource: "explicit-approval" as const,
          allowAlwaysDecision: undefined,
        };
      }

      const { decision, state: resolvedDecision } = approvalOutcome;
      const { approvedByAsk } = resolvedDecision;
      let { deniedReason } = resolvedDecision;

      if (
        !approvedByAsk &&
        hasGatewayAllowlistMiss({
          hostSecurity,
          analysisOk,
          allowlistSatisfied,
          durableApprovalSatisfied,
        })
      ) {
        deniedReason = deniedReason ?? "allowlist-miss";
      }

      if (!deniedReason && approvedByAsk) {
        const currentBinding = await revalidateSystemRunMutableFileBinding({
          binding: approvalMutableFileBinding,
          cwd: params.workdir,
        });
        if (!currentBinding.ok) {
          deniedReason = currentBinding.message;
        }
      }

      emitGatewayExecApprovalSecurityEvent({
        action: deniedReason ? "exec.approval.denied" : "exec.approval.approved",
        outcome: deniedReason ? "denied" : "success",
        severity: "medium",
        agentId: params.agentId,
        reason: deniedReason ?? undefined,
        hostSecurity,
        hostAsk,
        host: "gateway",
        segmentCount: allowlistEval.segments.length,
        trigger: params.trigger,
        decision,
      });
      return {
        deniedReason,
        requestFailed: false,
        authorizationSource:
          decision === null ? ("ask-fallback" as const) : ("explicit-approval" as const),
        // Cron contexts mint a scoped standing grant in the durable resolution
        // transaction instead of writing an unbounded JSON allowlist digest.
        allowAlwaysDecision:
          decision === "allow-always" && !cronExecutionSource
            ? approvalAllowAlwaysPersistence
            : undefined,
        execCommandOverride:
          decision === null && fallbackSecurity === "allowlist"
            ? fallbackEnforcedCommand
            : enforcedCommand,
      };
    };

    if (unavailableReason === null && shouldAwaitGatewayApprovalInline(params)) {
      if (params.runId) {
        emitAgentEvent({
          runId: params.runId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          stream: "lifecycle",
          data: { phase: "waiting-approval", approvalId, toolCallId: params.toolCallId },
        });
      }
      let approvalDecision: Awaited<ReturnType<typeof resolveApprovalForExecution>>;
      try {
        approvalDecision = await resolveApprovalForExecution(() => undefined);
      } finally {
        if (params.runId) {
          emitAgentEvent({
            runId: params.runId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            stream: "lifecycle",
            data: { phase: "approval-resolved", approvalId, toolCallId: params.toolCallId },
          });
        }
      }
      // A run-abort cancellation must propagate as cancellation, not resolve
      // into an ordinary denial the aborted run would keep processing. The
      // abort owner cancels approvals before firing the controller, so the
      // signal is aborted by the time the released waiter reaches us.
      if (approvalDecision.runAborted) {
        params.signal?.throwIfAborted();
      }
      if (approvalDecision.deniedReason) {
        return {
          deniedResult: buildGatewayExecApprovalDeniedToolResult({
            approvalId,
            deniedReason: approvalDecision.deniedReason,
            command: params.command,
            cwd: params.workdir,
          }),
        };
      }

      params.signal?.throwIfAborted();
      await commitExecutionAuthorization({
        source: approvalDecision.authorizationSource,
        resolvedPath: resolvedPath ?? undefined,
        ...(approvalDecision.allowAlwaysDecision
          ? { allowAlwaysDecision: approvalDecision.allowAlwaysDecision }
          : {}),
      });
      // The commit awaits: an abort that lands during it must not admit the
      // process (mirrors the detached path's post-commit check).
      params.signal?.throwIfAborted();
      return {
        execCommandOverride: approvalDecision.execCommandOverride,
        allowWithoutEnforcedCommand: approvalDecision.execCommandOverride === undefined,
        ...(revalidateBeforeExecution ? { revalidateBeforeExecution } : {}),
      };
    }

    const effectiveTimeout =
      typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec;
    const followupTarget = buildExecApprovalFollowupTarget({
      approvalId,
      agentId: params.agentId,
      sessionKey: params.notifySessionKey ?? params.sessionKey,
      expectedSessionId: params.sessionId,
      sessionStore: params.sessionStore,
      bashElevated: params.bashElevated,
      turnSourceChannel: params.turnSourceChannel,
      turnSourceTo: params.turnSourceTo,
      turnSourceAccountId: params.turnSourceAccountId,
      turnSourceThreadId: params.turnSourceThreadId,
      direct: params.approvalFollowupMode === "direct",
    });
    const denyApprovalStateWriteFailure = async () => {
      emitGatewayExecApprovalSecurityEvent({
        action: "exec.approval.denied",
        outcome: "error",
        severity: "high",
        agentId: params.agentId,
        reason: "approval-state-write-failed",
        hostSecurity,
        hostAsk,
        host: "gateway",
        segmentCount: allowlistEval.segments.length,
        trigger: params.trigger,
      });
      await sendExecApprovalFollowupResult(
        followupTarget,
        `Exec denied (gateway id=${approvalId}, approval-state-write-failed): ${params.command}`,
      );
    };
    const sendApprovalRequestFailedFollowup = async () => {
      if (!params.signal?.aborted) {
        await sendExecApprovalFollowupResult(
          followupTarget,
          `Exec denied (gateway id=${approvalId}, approval-request-failed): ${params.command}`,
        );
      }
    };
    let gatewayInvocationStarted = false;

    void (async () => {
      const approvalDecision = await resolveApprovalForExecution(sendApprovalRequestFailedFollowup);
      if (approvalDecision.requestFailed) {
        return;
      }
      if (approvalDecision.runAborted) {
        return;
      }
      if (params.signal?.aborted) {
        return;
      }

      if (approvalDecision.deniedReason) {
        await sendExecApprovalFollowupResult(
          followupTarget,
          `Exec denied (gateway id=${approvalId}, ${approvalDecision.deniedReason}): ${params.command}`,
        );
        return;
      }

      let admitted:
        | { status: "started"; run: Awaited<ReturnType<typeof runExecProcess>> }
        | { status: "approval-state-write-failed" }
        | { status: "operand-drift"; message: string }
        | { status: "run-aborted" }
        | { status: "spawn-failed" };
      try {
        admitted = await runWithGatewayIndependentRootWorkAdmission(async () => {
          // Admission can queue: recheck abort before writing authorization so
          // an abort that wins while waiting cannot persist an allow-always.
          if (params.signal?.aborted) {
            return { status: "run-aborted" as const };
          }
          try {
            await commitExecutionAuthorization({
              source: approvalDecision.authorizationSource,
              resolvedPath: resolvedPath ?? undefined,
              ...(approvalDecision.allowAlwaysDecision
                ? { allowAlwaysDecision: approvalDecision.allowAlwaysDecision }
                : {}),
            });
          } catch {
            return { status: "approval-state-write-failed" as const };
          }
          if (params.signal?.aborted) {
            return { status: "run-aborted" as const };
          }

          const currentBinding = await revalidateSystemRunMutableFileBinding({
            binding: approvalMutableFileBinding,
            cwd: params.workdir,
          });
          if (!currentBinding.ok) {
            return {
              status: "operand-drift" as const,
              message: currentBinding.message,
            };
          }
          if (params.signal?.aborted) {
            return { status: "run-aborted" as const };
          }

          let run: Awaited<ReturnType<typeof runExecProcess>>;
          try {
            gatewayInvocationStarted = true;
            run = await runExecProcess({
              command: params.command,
              execCommand: approvalDecision.execCommandOverride,
              workdir: params.workdir,
              env: params.env,
              pathPrepend: params.pathPrepend,
              sandbox: undefined,
              containerWorkdir: null,
              usePty: params.pty,
              warnings: params.warnings,
              maxOutput: params.maxOutput,
              pendingMaxOutput: params.pendingMaxOutput,
              notifyOnExit: false,
              notifyOnExitEmptySuccess: false,
              scopeKey: params.scopeKey,
              sessionKey: params.notifySessionKey ?? params.sessionKey,
              timeoutSec: effectiveTimeout,
            });
          } catch {
            return { status: "spawn-failed" as const };
          }

          // Keep the admitted root until the registry owns the live process.
          // Suspension must observe one side of this handoff at every instant.
          markBackgrounded(run.session);
          return { status: "started" as const, run };
        });
      } catch (error) {
        if (
          error instanceof GatewayDrainingError ||
          (error instanceof Error && error.message === "gateway is draining for restart")
        ) {
          await sendExecApprovalFollowupResult(
            followupTarget,
            `Exec denied (gateway id=${approvalId}, gateway-draining): ${params.command}`,
          );
          return;
        }
        // Detached approval work must always settle through a follow-up. Treat
        // any unexpected admission failure as a spawn failure, never an
        // unhandled rejection from this fire-and-forget chain.
        admitted = { status: "spawn-failed" };
      }

      if (admitted.status === "approval-state-write-failed") {
        await denyApprovalStateWriteFailure();
        return;
      }
      if (admitted.status === "run-aborted") {
        return;
      }
      if (admitted.status === "operand-drift") {
        await sendExecApprovalFollowupResult(followupTarget, admitted.message);
        return;
      }
      if (admitted.status === "spawn-failed") {
        await sendExecApprovalFollowupResult(
          followupTarget,
          `Exec denied (gateway id=${approvalId}, spawn-failed): ${params.command}`,
        );
        return;
      }

      const { run } = admitted;

      const outcome = await run.promise;
      const dynamicFollowupText = await resolveGatewayExecApprovalFollowupText({
        approvalFollowup: params.approvalFollowup,
        approvalId,
        sessionId: run.session.id,
        trigger: params.trigger,
        outcome,
      });
      const approvalFollowupText = normalizeStringEntries([
        params.approvalFollowupText ?? "",
        dynamicFollowupText ?? "",
      ]).join("\n\n");
      const summary = buildGatewayExecApprovalFollowupSummary({
        approvalId,
        sessionId: run.session.id,
        outcome,
        trigger: params.trigger,
        approvalFollowupText,
      });
      await sendExecApprovalFollowupResult(followupTarget, summary);
    })()
      .catch(async (): Promise<void> => {
        // Once dispatch starts, a delivery failure cannot mean execution was denied.
        if (gatewayInvocationStarted || params.signal?.aborted) {
          return;
        }
        await sendApprovalRequestFailedFollowup();
      })
      .catch(() => undefined);

    return {
      pendingResult: buildExecApprovalPendingToolResult({
        host: "gateway",
        command: params.command,
        cwd: params.workdir,
        warningText,
        approvalId,
        approvalSlug,
        expiresAtMs,
        initiatingSurface,
        sentApproverDms,
        unavailableReason,
        allowedDecisions: approvalAllowedDecisions,
        processContinuationAvailable: params.processContinuationAvailable,
      }),
    };
  }

  if (
    hasGatewayAllowlistMiss({
      hostSecurity,
      analysisOk,
      allowlistSatisfied,
      durableApprovalSatisfied,
    })
  ) {
    throw new Error("exec denied: allowlist miss");
  }

  await commitExecutionAuthorization({
    source: "current-policy",
    resolvedPath: resolveApprovalAuditTrustPath(
      allowlistEval.segments[0]?.resolution ?? null,
      params.workdir,
    ),
  });

  return { execCommandOverride: enforcedCommand };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
