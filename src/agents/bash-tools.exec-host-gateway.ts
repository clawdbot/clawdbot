import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  addDurableCommandApproval,
  type ExecAsk,
  resolveExecApprovalAllowedDecisions,
  type ExecSecurity,
  buildEnforcedShellCommand,
  evaluateShellAllowlist,
  hasDurableExecApproval,
  persistAllowAlwaysPatterns,
  recordAllowlistMatchesUse,
  resolveApprovalAuditCandidatePath,
  requiresExecApproval,
} from "../infra/exec-approvals.js";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
} from "../infra/exec-inline-eval.js";
import type { SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
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
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";

export type ProcessGatewayAllowlistParams = {
  command: string;
  workdir: string;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  pty: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  security: ExecSecurity;
  ask: ExecAsk;
  safeBins: Set<string>;
  safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
  strictInlineEval?: boolean;
  trigger?: string;
  agentId?: string;
  sessionKey?: string;
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

export type ProcessGatewayAllowlistResult = {
  execCommandOverride?: string;
  allowWithoutEnforcedCommand?: boolean;
  pendingResult?: AgentToolResult<ExecToolDetails>;
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

function formatOutcomeExitLabel(outcome: { exitCode: number | null; timedOut: boolean }): string {
  return outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export async function processGatewayAllowlist(
  params: ProcessGatewayAllowlistParams,
): Promise<ProcessGatewayAllowlistResult> {
  const { approvals, hostSecurity, hostAsk, askFallback } = resolveExecHostApprovalContext({
    agentId: params.agentId,
    security: params.security,
    ask: params.ask,
    host: "gateway",
  });
  const allowlistEval = evaluateShellAllowlist({
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
    params.strictInlineEval === true
      ? (allowlistEval.segments
          .map((segment) =>
            detectInterpreterInlineEvalArgv(segment.resolution?.effectiveArgv ?? segment.argv),
          )
          .find((entry) => entry !== null) ?? null)
      : null;
  if (inlineEvalHit) {
    params.warnings.push(
      `Warning: strict inline-eval mode requires explicit approval for ${describeInterpreterInlineEval(
        inlineEvalHit,
      )}.`,
    );
  }
  let enforcedCommand: string | undefined;
  let allowlistPlanUnavailableReason: string | null = null;
  if (hostSecurity === "allowlist" && analysisOk && allowlistSatisfied) {
    const enforced = buildEnforcedShellCommand({
      command: params.command,
      segments: allowlistEval.segments,
      platform: process.platform,
    });
    if (!enforced.ok || !enforced.command) {
      allowlistPlanUnavailableReason = enforced.reason ?? "unsupported platform";
    } else {
      enforcedCommand = enforced.command;
    }
  }
  const recordMatchedAllowlistUse = (resolvedPath?: string) =>
    recordAllowlistMatchesUse({
      approvals: approvals.file,
      agentId: params.agentId,
      matches: allowlistMatches,
      command: params.command,
      resolvedPath,
    });
  const hasHeredocSegment = allowlistEval.segments.some((segment) =>
    segment.argv.some((token) => token.startsWith("<<")),
  );
  const requiresHeredocApproval =
    hostSecurity === "allowlist" && analysisOk && allowlistSatisfied && hasHeredocSegment;
  const requiresInlineEvalApproval = inlineEvalHit !== null;
  const requiresAllowlistPlanApproval =
    hostSecurity === "allowlist" &&
    analysisOk &&
    allowlistSatisfied &&
    !enforcedCommand &&
    allowlistPlanUnavailableReason !== null;
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
    requiresInlineEvalApproval;
  if (requiresHeredocApproval) {
    params.warnings.push(
      "Warning: heredoc execution requires explicit approval in allowlist mode.",
    );
  }
  if (requiresAllowlistPlanApproval) {
    params.warnings.push(
      `Warning: allowlist auto-execution is unavailable on ${process.platform}; explicit approval is required.`,
    );
  }

  if (requiresAsk) {
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
        warningText: params.warnings.join("\n").trim() || undefined,
        ...buildExecApprovalRequesterContext({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        }),
        resolvedPath: resolveApprovalAuditCandidatePath(
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
    if (
      shouldResolveExecApprovalUnavailableInline({
        trigger: params.trigger,
        unavailableReason,
        preResolvedDecision,
      })
    ) {
      const { baseDecision, approvedByAsk, deniedReason } = createExecApprovalDecisionState({
        decision: preResolvedDecision,
        askFallback,
      });
      const strictInlineEvalDecision = enforceStrictInlineEvalApprovalBoundary({
        baseDecision,
        approvedByAsk,
        deniedReason,
        requiresInlineEvalApproval,
      });

      if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) {
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

      recordMatchedAllowlistUse(
        resolveApprovalAuditCandidatePath(
          allowlistEval.segments[0]?.resolution ?? null,
          params.workdir,
        ),
      );
      return {
        execCommandOverride: enforcedCommand,
        allowWithoutEnforcedCommand: enforcedCommand === undefined,
      };
    }
    const resolvedPath = resolveApprovalAuditCandidatePath(
      allowlistEval.segments[0]?.resolution ?? null,
      params.workdir,
    );
    const effectiveTimeout =
      typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec;
    const followupTarget = buildExecApprovalFollowupTarget({
      approvalId,
      sessionKey: params.notifySessionKey ?? params.sessionKey,
      turnSourceChannel: params.turnSourceChannel,
      turnSourceTo: params.turnSourceTo,
      turnSourceAccountId: params.turnSourceAccountId,
      turnSourceThreadId: params.turnSourceThreadId,
      direct: params.approvalFollowupMode === "direct",
    });

    void (async () => {
      const decision = await resolveApprovalDecisionOrUndefined({
        approvalId,
        preResolvedDecision,
        onFailure: () =>
          void sendExecApprovalFollowupResult(
            followupTarget,
            `Exec denied (gateway id=${approvalId}, approval-request-failed): ${params.command}`,
          ),
      });
      if (decision === undefined) {
        return;
      }

      const {
        baseDecision,
        approvedByAsk: initialApprovedByAsk,
        deniedReason: initialDeniedReason,
      } = createExecApprovalDecisionState({
        decision,
        askFallback,
      });
      let approvedByAsk = initialApprovedByAsk;
      let deniedReason = initialDeniedReason;

      if (baseDecision.timedOut && askFallback === "allowlist") {
        if (!analysisOk || !allowlistSatisfied) {
          deniedReason = "approval-timeout (allowlist-miss)";
        } else {
          approvedByAsk = true;
        }
      } else if (decision === "allow-once") {
        approvedByAsk = true;
      } else if (decision === "allow-always") {
        approvedByAsk = true;
        if (!requiresInlineEvalApproval) {
          const patterns = persistAllowAlwaysPatterns({
            approvals: approvals.file,
            agentId: params.agentId,
            segments: allowlistEval.segments,
            cwd: params.workdir,
            env: params.env,
            platform: process.platform,
            strictInlineEval: params.strictInlineEval === true,
          });
          if (patterns.length === 0) {
            addDurableCommandApproval(approvals.file, params.agentId, params.command);
          }
        }
      }

      ({ approvedByAsk, deniedReason } = enforceStrictInlineEvalApprovalBoundary({
        baseDecision,
        approvedByAsk,
        deniedReason,
        requiresInlineEvalApproval,
      }));

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

      if (deniedReason) {
        await sendExecApprovalFollowupResult(
          followupTarget,
          `Exec denied (gateway id=${approvalId}, ${deniedReason}): ${params.command}`,
        );
        return;
      }

      recordMatchedAllowlistUse(resolvedPath ?? undefined);

      let run: Awaited<ReturnType<typeof runExecProcess>> | null = null;
      try {
        run = await runExecProcess({
          command: params.command,
          execCommand: enforcedCommand,
          workdir: params.workdir,
          env: params.env,
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
        await sendExecApprovalFollowupResult(
          followupTarget,
          `Exec denied (gateway id=${approvalId}, spawn-failed): ${params.command}`,
        );
        return;
      }

      markBackgrounded(run.session);

      const outcome = await run.promise;
      const dynamicFollowupText = await resolveGatewayExecApprovalFollowupText({
        approvalFollowup: params.approvalFollowup,
        approvalId,
        sessionId: run.session.id,
        trigger: params.trigger,
        outcome,
      });
      const approvalFollowupText = [params.approvalFollowupText, dynamicFollowupText]
        .map((text) => text?.trim())
        .filter(Boolean)
        .join("\n\n");
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
        allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: hostAsk }),
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

  recordMatchedAllowlistUse(
    resolveApprovalAuditCandidatePath(
      allowlistEval.segments[0]?.resolution ?? null,
      params.workdir,
    ),
  );

  return { execCommandOverride: enforcedCommand };
}
