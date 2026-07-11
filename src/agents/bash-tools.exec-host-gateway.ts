/**
 * Gateway-host exec approval and allowlist handling.
 * Evaluates shell allowlists, auto-review, durable approvals, follow-up routing,
 * and approved command execution for gateway-backed exec calls.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { describeInterpreterInlineEval } from "../infra/command-analysis/inline-eval.js";
import { detectPolicyInlineEval } from "../infra/command-analysis/policy.js";
import { emitTrustedSecurityEvent } from "../infra/diagnostic-events.js";
import {
  type AllowAlwaysPersistenceDecision,
  commitExecAuthorizationLocked,
  commandRequiresSecurityAuditSuppressionApproval,
  createExecApprovalPolicySnapshot,
  type ExecAsk,
  type ExecApprovalUsageAuthorization,
  resolveExecApprovalAllowedDecisions,
  type ExecCommandSegment,
  type ExecSecurity,
  type ExecSegmentSatisfiedBy,
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
import type { ExecAuthorizationPlan } from "../infra/exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import {
  defaultExecAutoReviewer,
  type ExecAutoReviewer,
  type ExecAutoReviewInput,
} from "../infra/exec-auto-review.js";
import type { SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
import {
  GatewayDrainingError,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { isNativeApprovalChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { markBackgrounded, tail } from "./bash-process-registry.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import {
  buildDefaultExecApprovalRequestArgs,
  buildHeadlessExecApprovalDeniedMessage,
  buildExecApprovalFollowupTarget,
  buildExecApprovalPendingToolResult,
  createExecApprovalDecisionState,
  createAndRegisterDefaultExecApprovalRequest,
  enforceStrictInlineEvalApprovalBoundary,
  resolveApprovalDecisionOrUndefined,
  resolveExecHostApprovalContext,
  sendExecApprovalFollowupResult,
  shouldResolveExecApprovalUnavailableInline,
} from "./bash-tools.exec-host-shared.js";
import {
  DEFAULT_NOTIFY_TAIL_CHARS,
  createApprovalSlug,
  normalizeNotifyOutput,
  runExecProcess,
} from "./bash-tools.exec-runtime.js";
import type {
  ExecElevatedDefaults,
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
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
  /** Session UUID active when the approval was requested; pins the followup. */
  sessionId?: string;
  /** Session-store template, so the direct/denied followup can detect a rebind. */
  sessionStore?: string;
  bashElevated?: ExecElevatedDefaults;
  approvalReviewerDeviceId?: string;
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
  trustedSafeBinDirs?: ReadonlySet<string>;
};

/** Gateway allowlist outcome before command execution continues. */
type ProcessGatewayAllowlistResult = {
  execCommandOverride?: string;
  allowWithoutEnforcedCommand?: boolean;
  pendingResult?: AgentToolResult<ExecToolDetails>;
  deniedResult?: AgentToolResult<ExecToolDetails>;
};

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

function resolveGatewayAutoReviewReason(params: {
  requiresInlineEvalApproval: boolean;
  requiresHeredocApproval: boolean;
  requiresAllowlistPlanApproval: boolean;
  hostSecurity: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
}): ExecAutoReviewInput["reason"] {
  if (params.requiresInlineEvalApproval) {
    return "strict-inline-eval";
  }
  if (params.requiresHeredocApproval) {
    return "heredoc";
  }
  if (params.requiresAllowlistPlanApproval) {
    return "execution-plan-miss";
  }
  if (
    hasGatewayAllowlistMiss({
      hostSecurity: params.hostSecurity,
      analysisOk: params.analysisOk,
      allowlistSatisfied: params.allowlistSatisfied,
      durableApprovalSatisfied: params.durableApprovalSatisfied,
    })
  ) {
    return "allowlist-miss";
  }
  return "approval-required";
}

function createOneShotAllowAlwaysDecision(): AllowAlwaysPersistenceDecision {
  return { kind: "one-shot", reasons: ["no-reusable-pattern"] };
}

function resolveGatewayEffectiveAllowAlwaysPersistence(params: {
  command: string;
  allowAlwaysPersistence: AllowAlwaysPersistenceDecision;
  requiresAllowlistPlanApproval: boolean;
}): AllowAlwaysPersistenceDecision {
  if (!params.requiresAllowlistPlanApproval) {
    return params.allowAlwaysPersistence;
  }
  if (params.allowAlwaysPersistence.kind !== "patterns") {
    return params.allowAlwaysPersistence;
  }
  // If the gateway cannot rebuild an enforceable command, a reusable grant
  // would only be keyed by command text and could run under a different cwd/env.
  return createOneShotAllowAlwaysDecision();
}

function resolveGatewayEnforcedCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  authorizationPlan?: ExecAuthorizationPlan;
  segmentSatisfiedBy?: readonly ExecSegmentSatisfiedBy[];
}): { ok: boolean; command?: string; reason?: string } {
  return process.platform === "win32"
    ? buildEnforcedShellCommand({
        command: params.command,
        segments: params.segments,
        platform: process.platform,
      })
    : params.authorizationPlan
      ? buildAuthorizedShellCommandFromPlan({
          plan: params.authorizationPlan,
          mode: "enforced",
          segmentSatisfiedBy: params.segmentSatisfiedBy,
        })
      : { ok: false, reason: "authorization plan unavailable" };
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
  if (params.trigger === "diagnostics") {
    const diagnosticsText =
      params.outcome.status === "completed" && params.outcome.exitCode === 0
        ? formatDiagnosticsExportSuccess(params.outcome.aggregated)
        : formatDiagnosticsExportFailure({ outcome: params.outcome, exitLabel });
    const followupText = params.approvalFollowupText?.trim();
    const body = [diagnosticsText, followupText].filter(Boolean).join("\n\n");
    return `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})\n${body}`;
  }

  const output = normalizeNotifyOutput(
    tail(params.outcome.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  return output
    ? `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})\n${output}`
    : `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})`;
}

function shouldAwaitGatewayApprovalInline(params: {
  turnSourceChannel?: string;
  approvalFollowupMode?: "agent" | "direct";
}): boolean {
  if (params.approvalFollowupMode !== undefined) {
    return false;
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
  approvalId: string;
  deniedReason: string;
  command: string;
  cwd: string;
}): AgentToolResult<ExecToolDetails> {
  const text = `Exec denied (gateway id=${params.approvalId}, ${params.deniedReason}): ${params.command}`;
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
      ? resolveGatewayEnforcedCommand({
          command: params.command,
          segments: allowlistEval.segments,
          authorizationPlan: allowlistEval.authorizationPlan,
          segmentSatisfiedBy: allowlistEval.segmentSatisfiedBy,
        })
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
  const requiresAsk =
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
  const effectiveAllowAlwaysPersistence = resolveGatewayEffectiveAllowAlwaysPersistence({
    command: params.command,
    allowAlwaysPersistence,
    requiresAllowlistPlanApproval,
  });
  const approvalAllowedDecisions = resolveExecApprovalAllowedDecisions({
    ask: hostAsk,
    allowAlwaysPersistence: effectiveAllowAlwaysPersistence,
  });
  const approvalUnavailableDecisions = resolveExecApprovalUnavailableDecisions({
    ask: hostAsk,
    allowAlwaysPersistence: effectiveAllowAlwaysPersistence,
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
    const [autoReviewSegment] = allowlistEval.segments;
    const autoReviewArgv =
      allowlistEval.segments.length === 1 &&
      (autoReviewSegment?.raw === undefined ||
        autoReviewSegment.raw.trim() === params.command.trim())
        ? autoReviewSegment.argv
        : undefined;
    const autoReviewHasBoundCommand = analysisOk && autoReviewArgv !== undefined;
    // A model approval is valid only for the executable resolved during review;
    // otherwise a later PATH lookup could run different code.
    const autoReviewEnforcedCommand =
      gatewayEnforcedCommand?.ok === true ? gatewayEnforcedCommand.command : undefined;
    const autoReviewResolvedPath = autoReviewHasBoundCommand
      ? resolveExecutionTargetTrustPath(autoReviewSegment?.resolution ?? null, params.workdir)
      : undefined;
    const autoReviewHasExecutableBinding =
      autoReviewHasBoundCommand &&
      autoReviewEnforcedCommand !== undefined &&
      autoReviewResolvedPath !== undefined;
    const canAutoReviewApprovalMiss =
      params.autoReview === true &&
      hostAsk !== "always" &&
      autoReviewHasExecutableBinding &&
      !requiresSecurityAuditSuppressionApproval;
    let autoReviewRequiresHumanApproval =
      (params.autoReview === true && hostAsk !== "always" && !autoReviewHasExecutableBinding) ||
      requiresAllowlistPlanApproval ||
      requiresHeredocApproval ||
      requiresSecurityAuditSuppressionApproval;
    if (canAutoReviewApprovalMiss) {
      const reviewer = params.autoReviewer ?? defaultExecAutoReviewer;
      const decision = await reviewer({
        command: params.command,
        argv: autoReviewArgv,
        resolvedPath: autoReviewResolvedPath,
        cwd: params.workdir,
        envKeys: Object.keys(params.requestedEnv ?? {}).toSorted(),
        host: "gateway",
        reason: resolveGatewayAutoReviewReason({
          requiresInlineEvalApproval,
          requiresHeredocApproval,
          requiresAllowlistPlanApproval,
          hostSecurity,
          analysisOk,
          allowlistSatisfied,
          durableApprovalSatisfied,
        }),
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
      params.signal?.throwIfAborted();
      if (
        decision.decision === "allow-once" &&
        decision.risk === "low" &&
        autoReviewEnforcedCommand
      ) {
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
          resolvedPath: resolveApprovalAuditTrustPath(
            allowlistEval.segments[0]?.resolution ?? null,
            params.workdir,
          ),
        });
        return {
          execCommandOverride: autoReviewEnforcedCommand,
        };
      }
      params.warnings.push(
        `Exec auto-review deferred to human approval (risk=${decision.risk}): ${decision.rationale}`,
      );
      autoReviewRequiresHumanApproval = true;
    }

    const requestArgs = buildDefaultExecApprovalRequestArgs({
      warnings: params.warnings,
      approvalRunningNoticeMs: params.approvalRunningNoticeMs,
      createApprovalSlug,
      turnSourceChannel: params.turnSourceChannel,
      turnSourceAccountId: params.turnSourceAccountId,
    });
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
        approvalReviewerDeviceIds: params.approvalReviewerDeviceId
          ? [params.approvalReviewerDeviceId]
          : undefined,
        resolvedPath: resolveApprovalAuditTrustPath(
          allowlistEval.segments[0]?.resolution ?? null,
          params.workdir,
        ),
        ...buildExecApprovalTurnSourceContext(params),
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
    } = await createAndRegisterDefaultExecApprovalRequest({
      ...requestArgs,
      register: registerGatewayApproval,
    });
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
    if (
      shouldResolveExecApprovalUnavailableInline({
        trigger: params.trigger,
        unavailableReason,
        preResolvedDecision,
      })
    ) {
      const { baseDecision, approvedByAsk, deniedReason } = applyTimedOutAllowlistFallback(
        createExecApprovalDecisionState({
          decision: preResolvedDecision,
          askFallback,
        }),
      );
      const strictInlineEvalDecision = enforceStrictInlineEvalApprovalBoundary({
        baseDecision,
        approvedByAsk,
        deniedReason,
        requiresInlineEvalApproval,
        requiresAutoReviewHumanApproval:
          autoReviewRequiresHumanApproval ||
          requiresHeredocApproval ||
          timedOutFallbackRequiresHeredocApproval,
      });

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
        decision: preResolvedDecision,
      });
      await commitExecutionAuthorization({
        source: preResolvedDecision === null ? "ask-fallback" : "explicit-approval",
        resolvedPath: resolveApprovalAuditTrustPath(
          allowlistEval.segments[0]?.resolution ?? null,
          params.workdir,
        ),
        ...(preResolvedDecision === "allow-always"
          ? { allowAlwaysDecision: effectiveAllowAlwaysPersistence }
          : {}),
      });
      const execCommandOverride =
        preResolvedDecision === null && fallbackSecurity === "allowlist"
          ? fallbackEnforcedCommand
          : enforcedCommand;
      return {
        execCommandOverride,
        allowWithoutEnforcedCommand: execCommandOverride === undefined,
      };
    }
    const resolvedPath = resolveApprovalAuditTrustPath(
      allowlistEval.segments[0]?.resolution ?? null,
      params.workdir,
    );
    const resolveApprovalForExecution = async (onFailure: () => void) => {
      const decision = await resolveApprovalDecisionOrUndefined({
        approvalId,
        preResolvedDecision,
        onFailure,
      });
      if (decision === undefined) {
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

      const initialDecisionState = createExecApprovalDecisionState({
        decision,
        askFallback,
      });
      const {
        baseDecision,
        approvedByAsk: baseApprovedByAsk,
        deniedReason: baseDeniedReason,
      } = applyTimedOutAllowlistFallback(initialDecisionState);
      let approvedByAsk = baseApprovedByAsk;
      let deniedReason = baseDeniedReason;

      if (decision === "allow-once") {
        approvedByAsk = true;
      } else if (decision === "allow-always") {
        approvedByAsk = true;
      }

      const strictBoundaryDecision = enforceStrictInlineEvalApprovalBoundary({
        baseDecision,
        approvedByAsk,
        deniedReason,
        requiresInlineEvalApproval,
        requiresAutoReviewHumanApproval:
          autoReviewRequiresHumanApproval ||
          requiresHeredocApproval ||
          timedOutFallbackRequiresHeredocApproval,
      });
      approvedByAsk = strictBoundaryDecision.approvedByAsk;
      deniedReason = strictBoundaryDecision.deniedReason;

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
        allowAlwaysDecision:
          decision === "allow-always" ? effectiveAllowAlwaysPersistence : undefined,
        execCommandOverride:
          decision === null && fallbackSecurity === "allowlist"
            ? fallbackEnforcedCommand
            : enforcedCommand,
      };
    };

    if (unavailableReason === null && shouldAwaitGatewayApprovalInline(params)) {
      const approvalDecision = await resolveApprovalForExecution(() => undefined);
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

      await commitExecutionAuthorization({
        source: approvalDecision.authorizationSource,
        resolvedPath: resolvedPath ?? undefined,
        ...(approvalDecision.allowAlwaysDecision
          ? { allowAlwaysDecision: approvalDecision.allowAlwaysDecision }
          : {}),
      });
      return {
        execCommandOverride: approvalDecision.execCommandOverride,
        allowWithoutEnforcedCommand: approvalDecision.execCommandOverride === undefined,
      };
    }

    const effectiveTimeout =
      typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec;
    const followupTarget = buildExecApprovalFollowupTarget({
      approvalId,
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

    void (async () => {
      let approvalDecision: Awaited<ReturnType<typeof resolveApprovalForExecution>>;
      try {
        approvalDecision = await resolveApprovalForExecution(
          () =>
            void sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (gateway id=${approvalId}, approval-request-failed): ${params.command}`,
            ),
        );
      } catch {
        await denyApprovalStateWriteFailure();
        return;
      }
      if (approvalDecision.requestFailed) {
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
        | { status: "spawn-failed" };
      try {
        admitted = await runWithGatewayIndependentRootWorkAdmission(async () => {
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

          let run: Awaited<ReturnType<typeof runExecProcess>>;
          try {
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
    })();

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
