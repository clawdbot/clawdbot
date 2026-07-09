/**
 * Node-host exec orchestration.
 * Combines local policy, remote node policy, auto-review, approval follow-ups,
 * and `node.invoke system.run` execution for host=node calls.
 */
import { randomUUID } from "node:crypto";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "../gateway/operator-scopes.js";
import type { InterpreterInlineEvalHit } from "../infra/command-analysis/inline-eval.js";
import {
  type ExecSecurity,
  maxAsk,
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalUnavailableDecisions,
} from "../infra/exec-approvals.js";
import { defaultExecAutoReviewer, type ExecAutoReviewInput } from "../infra/exec-auto-review.js";
import { tail } from "./bash-process-registry.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import {
  analyzeNodeApprovalRequirement,
  buildNodeSystemRunInvoke,
  formatNodeRunToolResult,
  invokeNodeSystemRunDirect,
  prepareNodeSystemRun,
  resolveNodeExecutionTarget,
  shouldSkipNodeApprovalPrepare,
} from "./bash-tools.exec-host-node-phases.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import * as execHostShared from "./bash-tools.exec-host-shared.js";
import {
  DEFAULT_NOTIFY_TAIL_CHARS,
  createApprovalSlug,
  normalizeNotifyOutput,
} from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { callGatewayTool } from "./tools/gateway.js";

const APPROVED_NODE_INVOKE_SCOPES = [WRITE_SCOPE, APPROVALS_SCOPE];

function resolveNodeAutoReviewReason(params: {
  inlineEvalHit: InterpreterInlineEvalHit | null;
  hostSecurity: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
}): ExecAutoReviewInput["reason"] {
  if (params.inlineEvalHit !== null) {
    return "strict-inline-eval";
  }
  if (
    params.hostSecurity === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied) &&
    !params.durableApprovalSatisfied
  ) {
    return "allowlist-miss";
  }
  return "approval-required";
}

function execSecurityFloorRank(security: ExecSecurity): number {
  switch (security) {
    case "full":
      return 0;
    case "allowlist":
      return 1;
    case "deny":
      return 2;
  }
  throw new Error("Unsupported exec security floor");
}

function nodePolicyBlocksAutoReview(params: {
  hostSecurity: ExecSecurity;
  nodeApprovalPolicyKnown: boolean;
  nodeSecurity?: ExecSecurity;
  nodeAsk?: "off" | "on-miss" | "always";
}): boolean {
  // Remote node policy can be stricter than local host policy; do not auto-approve across that gap.
  return (
    !params.nodeApprovalPolicyKnown ||
    params.nodeAsk === "always" ||
    (params.nodeSecurity !== undefined &&
      execSecurityFloorRank(params.nodeSecurity) > execSecurityFloorRank(params.hostSecurity))
  );
}

/**
 * Executes a command on a remote node, requesting approval when policy requires it.
 * Node-host approval combines caller policy and remote node approval snapshots.
 */
export async function executeNodeHostCommand(
  params: ExecuteNodeHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  const { hostSecurity, hostAsk, askFallback } = execHostShared.resolveExecHostApprovalContext({
    agentId: params.agentId,
    security: params.security,
    ask: params.ask,
    host: "node",
  });
  const target = await resolveNodeExecutionTarget(params);
  if (
    shouldSkipNodeApprovalPrepare({
      hostSecurity,
      hostAsk,
      strictInlineEval: params.strictInlineEval,
    })
  ) {
    return await invokeNodeSystemRunDirect({ request: params, target });
  }

  const prepared = await prepareNodeSystemRun({ request: params, target });
  const approvalAnalysis = await analyzeNodeApprovalRequirement({
    request: params,
    target,
    prepared,
    hostSecurity,
    hostAsk,
  });
  const {
    analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied,
    nodeApprovalPolicyKnown,
    nodeSecurity,
    nodeAsk,
    inlineEvalHit,
    requiresSecurityAuditSuppressionApproval,
    autoReviewArgv,
    allowAlwaysPersistence,
  } = approvalAnalysis;
  const approvalDecisionAsk =
    nodeApprovalPolicyKnown && nodeAsk !== undefined ? maxAsk(hostAsk, nodeAsk) : "always";
  const allowedDecisions = resolveExecApprovalAllowedDecisions({
    ask: approvalDecisionAsk,
    allowAlwaysPersistence,
  });
  const unavailableDecisions = resolveExecApprovalUnavailableDecisions({
    ask: approvalDecisionAsk,
    allowAlwaysPersistence,
  });
  const unavailableDecisionRequestParams =
    unavailableDecisions.length > 0 ? { unavailableDecisions } : {};
  const requiresAsk =
    requiresExecApproval({
      ask: hostAsk,
      security: hostSecurity,
      analysisOk,
      allowlistSatisfied,
      durableApprovalSatisfied,
    }) ||
    inlineEvalHit !== null ||
    requiresSecurityAuditSuppressionApproval;
  if (requiresSecurityAuditSuppressionApproval) {
    params.warnings.push(
      "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.",
    );
  }
  const registerNodeApproval = async (
    approvalId: string,
    options: { requireDeliveryRoute?: boolean; suppressDelivery?: boolean } = {},
  ) =>
    await registerExecApprovalRequestForHostOrThrow({
      approvalId,
      systemRunPlan: prepared.plan,
      env: target.env,
      workdir: prepared.cwd,
      host: "node",
      nodeId: target.nodeId,
      security: hostSecurity,
      ask: hostAsk,
      ...unavailableDecisionRequestParams,
      commandHighlighting: params.commandHighlighting,
      ...buildExecApprovalRequesterContext({
        agentId: prepared.agentId,
        sessionKey: prepared.sessionKey,
      }),
      approvalReviewerDeviceIds: params.approvalReviewerDeviceId
        ? [params.approvalReviewerDeviceId]
        : undefined,
      ...(options.requireDeliveryRoute !== undefined
        ? { requireDeliveryRoute: options.requireDeliveryRoute }
        : {}),
      ...(options.suppressDelivery !== undefined
        ? { suppressDelivery: options.suppressDelivery }
        : {}),
      ...buildExecApprovalTurnSourceContext(params),
    });

  let inlineApprovedByAsk = false;
  let inlineApprovalDecision: "allow-once" | "allow-always" | null = null;
  let inlineApprovalId: string | undefined;
  if (requiresAsk) {
    const autoReviewHasBoundCommand = analysisOk && autoReviewArgv !== undefined;
    const autoReviewBlockedByNodePolicy =
      params.autoReview === true &&
      hostAsk !== "always" &&
      nodePolicyBlocksAutoReview({
        hostSecurity,
        nodeApprovalPolicyKnown,
        nodeSecurity,
        nodeAsk,
      });
    let autoReviewRequiresHumanApproval =
      autoReviewBlockedByNodePolicy ||
      (params.autoReview === true && hostAsk !== "always" && !autoReviewHasBoundCommand) ||
      requiresSecurityAuditSuppressionApproval;
    if (
      params.autoReview === true &&
      hostAsk !== "always" &&
      autoReviewHasBoundCommand &&
      !autoReviewBlockedByNodePolicy &&
      !requiresSecurityAuditSuppressionApproval
    ) {
      const reviewer = params.autoReviewer ?? defaultExecAutoReviewer;
      const decision = await reviewer({
        command: prepared.rawCommand,
        argv: autoReviewArgv,
        cwd: prepared.cwd,
        envKeys: Object.keys(params.requestedEnv ?? {}).toSorted(),
        host: "node",
        reason: resolveNodeAutoReviewReason({
          inlineEvalHit,
          hostSecurity,
          analysisOk,
          allowlistSatisfied,
          durableApprovalSatisfied,
        }),
        analysis: {
          parsed: analysisOk,
          allowlistMatched: allowlistSatisfied,
          durableApprovalMatched: durableApprovalSatisfied,
          inlineEval: inlineEvalHit !== null,
        },
        agent: {
          id: prepared.agentId,
          sessionKey: prepared.sessionKey,
        },
      });
      if (decision.decision === "allow-once") {
        const approvalId = randomUUID();
        await registerNodeApproval(approvalId, {
          requireDeliveryRoute: false,
          suppressDelivery: true,
        });
        await callGatewayTool(
          "exec.approval.resolve",
          { timeoutMs: 15_000 },
          { id: approvalId, decision: "allow-once" },
          { scopes: [APPROVALS_SCOPE] },
        );
        inlineApprovedByAsk = true;
        inlineApprovalDecision = "allow-once";
        inlineApprovalId = approvalId;
      }
      if (decision.decision !== "allow-once") {
        autoReviewRequiresHumanApproval = true;
        params.warnings.push(
          `Exec auto-review deferred to human approval (risk=${decision.risk}): ${decision.rationale}`,
        );
      }
    }

    if (!inlineApprovedByAsk) {
      // Human approval may complete after this tool call returns, so follow-up delivery owns invocation.
      const requestArgs = execHostShared.buildDefaultExecApprovalRequestArgs({
        warnings: params.warnings,
        approvalRunningNoticeMs: params.approvalRunningNoticeMs,
        createApprovalSlug,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceAccountId: params.turnSourceAccountId,
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
      } = await execHostShared.createAndRegisterDefaultExecApprovalRequest({
        ...requestArgs,
        register: registerNodeApproval,
      });
      if (
        execHostShared.shouldResolveExecApprovalUnavailableInline({
          trigger: params.trigger,
          unavailableReason,
          preResolvedDecision,
        })
      ) {
        const { baseDecision, approvedByAsk, deniedReason } =
          execHostShared.createExecApprovalDecisionState({
            decision: preResolvedDecision,
            askFallback,
          });
        const strictInlineEvalDecision = execHostShared.enforceStrictInlineEvalApprovalBoundary({
          baseDecision,
          approvedByAsk,
          deniedReason,
          requiresInlineEvalApproval: inlineEvalHit !== null,
          requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
        });
        if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) {
          throw new Error(
            execHostShared.buildHeadlessExecApprovalDeniedMessage({
              trigger: params.trigger,
              host: "node",
              security: hostSecurity,
              ask: hostAsk,
              askFallback,
            }),
          );
        }
        inlineApprovedByAsk = strictInlineEvalDecision.approvedByAsk;
        inlineApprovalDecision = strictInlineEvalDecision.approvedByAsk ? "allow-once" : null;
        inlineApprovalId = approvalId;
      } else {
        const followupTarget = execHostShared.buildExecApprovalFollowupTarget({
          approvalId,
          sessionKey: params.notifySessionKey ?? params.sessionKey,
          expectedSessionId: params.sessionId,
          sessionStore: params.sessionStore,
          bashElevated: params.bashElevated,
          turnSourceChannel: params.turnSourceChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
        });

        void (async () => {
          const decision = await execHostShared.resolveApprovalDecisionOrUndefined({
            approvalId,
            preResolvedDecision,
            onFailure: () =>
              void execHostShared.sendExecApprovalFollowupResult(
                followupTarget,
                `Exec denied (node=${target.nodeId} id=${approvalId}, approval-request-failed): ${params.command}`,
              ),
          });
          if (decision === undefined) {
            return;
          }

          const {
            baseDecision,
            approvedByAsk: initialApprovedByAsk,
            deniedReason: baseDeniedReason,
          } = execHostShared.createExecApprovalDecisionState({
            decision,
            askFallback,
          });
          let approvedByAsk = initialApprovedByAsk;
          let approvalDecision: "allow-once" | "allow-always" | null = null;
          let deniedReason = baseDeniedReason;

          if (baseDecision.timedOut && askFallback === "full" && approvedByAsk) {
            approvalDecision = "allow-once";
          } else if (decision === "allow-once") {
            approvedByAsk = true;
            approvalDecision = "allow-once";
          } else if (decision === "allow-always") {
            approvedByAsk = true;
            approvalDecision = "allow-always";
          }

          const strictBoundaryDecision = execHostShared.enforceStrictInlineEvalApprovalBoundary({
            baseDecision,
            approvedByAsk,
            deniedReason,
            requiresInlineEvalApproval: inlineEvalHit !== null,
            requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
          });
          approvedByAsk = strictBoundaryDecision.approvedByAsk;
          deniedReason = strictBoundaryDecision.deniedReason;
          if (deniedReason) {
            approvalDecision = null;
          }

          if (deniedReason) {
            await execHostShared.sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (node=${target.nodeId} id=${approvalId}, ${deniedReason}): ${params.command}`,
            );
            return;
          }

          try {
            // Approved follow-up invocations need approval scopes because they mutate remote node state.
            const raw = await callGatewayTool(
              "node.invoke",
              { timeoutMs: target.invokeTimeoutMs },
              buildNodeSystemRunInvoke({
                target,
                command: prepared.argv,
                rawCommand: prepared.transportRawCommand,
                cwd: prepared.cwd,
                agentId: prepared.agentId,
                sessionKey: prepared.sessionKey,
                turnSourceChannel: params.turnSourceChannel,
                turnSourceTo: params.turnSourceTo,
                turnSourceAccountId: params.turnSourceAccountId,
                turnSourceThreadId: params.turnSourceThreadId,
                approved: approvedByAsk,
                approvalDecision:
                  approvalDecision === "allow-always" && inlineEvalHit !== null
                    ? "allow-once"
                    : approvalDecision,
                runId: approvalId,
                suppressNotifyOnExit: true,
                notifyOnExit: params.notifyOnExit,
                systemRunPlan: prepared.plan,
              }),
              { scopes: APPROVED_NODE_INVOKE_SCOPES },
            );
            const payload =
              raw?.payload && typeof raw.payload === "object"
                ? (raw.payload as {
                    stdout?: string;
                    stderr?: string;
                    error?: string | null;
                    exitCode?: number | null;
                    timedOut?: boolean;
                  })
                : {};
            const combined = [payload.stdout, payload.stderr, payload.error]
              .filter(Boolean)
              .join("\n");
            const output = normalizeNotifyOutput(tail(combined, DEFAULT_NOTIFY_TAIL_CHARS));
            const exitLabel = payload.timedOut ? "timeout" : `code ${payload.exitCode ?? "?"}`;
            const summary = output
              ? `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})\n${output}`
              : `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})`;
            await execHostShared.sendExecApprovalFollowupResult(followupTarget, summary);
          } catch {
            await execHostShared.sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (node=${target.nodeId} id=${approvalId}, invoke-failed): ${params.command}`,
            );
          }
        })();

        return execHostShared.buildExecApprovalPendingToolResult({
          host: "node",
          command: params.command,
          cwd: params.workdir,
          warningText,
          approvalId,
          approvalSlug,
          expiresAtMs,
          initiatingSurface,
          sentApproverDms,
          unavailableReason,
          allowedDecisions,
          nodeId: target.nodeId,
        });
      }
    }
  }

  const startedAt = Date.now();
  const invoke = buildNodeSystemRunInvoke({
    target,
    command: prepared.argv,
    rawCommand: prepared.transportRawCommand,
    cwd: prepared.cwd,
    agentId: prepared.agentId,
    sessionKey: prepared.sessionKey,
    approved: inlineApprovedByAsk,
    approvalDecision: inlineApprovalDecision,
    runId: inlineApprovalId,
    notifyOnExit: params.notifyOnExit,
    systemRunPlan: prepared.plan,
  });
  const raw =
    inlineApprovedByAsk && inlineApprovalId
      ? await callGatewayTool("node.invoke", { timeoutMs: target.invokeTimeoutMs }, invoke, {
          scopes: APPROVED_NODE_INVOKE_SCOPES,
        })
      : await callGatewayTool("node.invoke", { timeoutMs: target.invokeTimeoutMs }, invoke);
  return formatNodeRunToolResult({
    raw,
    startedAt,
    cwd: params.workdir,
    warnings: [...params.warnings, ...(params.foregroundWarnings ?? [])],
  });
}
