/**
 * Node-host exec orchestration.
 * Combines local policy, remote node policy, auto-review, approval follow-ups,
 * and `node.invoke system.run` execution for host=node calls.
 */
import { randomUUID } from "node:crypto";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "../gateway/operator-scopes.js";
import {
  type ExecAsk,
  type ExecSecurity,
  maxAsk,
  minSecurity,
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalUnavailableDecisions,
} from "../infra/exec-approvals.js";
import {
  defaultExecAutoReviewer,
  resolveExecAutoReviewDecision,
} from "../infra/exec-auto-review.js";
import { formatExecApprovalContinuationSourceOutput } from "./bash-tools.exec-approval-output.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  isExecApprovalRunAbortedError,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import {
  formatNodeInvokeFailureFollowup,
  formatNodeInvokeFailureToolResult,
  invokeNodeSystemRun,
} from "./bash-tools.exec-host-node-failure.js";
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
import { createApprovalSlug } from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { abortable } from "./embedded-agent-runner/run/abortable.js";
import type { AgentToolResult } from "./runtime/index.js";
import { callGatewayTool } from "./tools/gateway.js";

const APPROVED_NODE_INVOKE_SCOPES = [WRITE_SCOPE, APPROVALS_SCOPE];

type NodeGatewayDispatchAuthority =
  | "current-policy"
  | "human-approval"
  | "auto-review"
  | "ask-fallback";

type NodeGatewayPolicyCheckpoint = {
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ExecSecurity;
};

async function assertCurrentNodeGatewayPolicyAllowsDispatch(params: {
  request: ExecuteNodeHostCommandParams;
  authority: NodeGatewayDispatchAuthority;
  currentPolicyAllows?: (policy: { hostSecurity: ExecSecurity; hostAsk: ExecAsk }) => boolean;
  fallbackPolicy?: NodeGatewayPolicyCheckpoint;
}): Promise<void> {
  const current = await execHostShared.resolveExecHostApprovalContext({
    agentId: params.request.agentId,
    security: params.request.security,
    ask: params.request.ask,
    host: "node",
  });
  // A human grant may bypass ask/allowlist, but never a later deny. Auto-review
  // additionally cannot stand in for a newly required human decision.
  if (current.hostSecurity === "deny") {
    throw new Error("exec denied: host=node security=deny");
  }
  if (params.authority === "human-approval") {
    return;
  }
  if (params.authority === "auto-review") {
    if (current.hostAsk === "always") {
      throw new Error("exec denied: host=node ask=always requires human approval");
    }
    return;
  }
  if (params.authority === "ask-fallback") {
    const expected = params.fallbackPolicy;
    if (
      !expected ||
      current.hostSecurity !== expected.hostSecurity ||
      current.hostAsk !== expected.hostAsk ||
      current.askFallback !== expected.askFallback
    ) {
      throw new Error("exec denied: host=node fallback policy changed before dispatch");
    }
    return;
  }
  if (!params.currentPolicyAllows?.(current)) {
    throw new Error("exec denied: host=node policy changed before dispatch");
  }
}

/**
 * Executes a command on a remote node, requesting approval when policy requires it.
 * Node-host approval combines caller policy and remote node approval snapshots.
 */
export async function executeNodeHostCommand(
  params: ExecuteNodeHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  const { hostSecurity, hostAsk, askFallback } =
    await execHostShared.resolveExecHostApprovalContext({
      agentId: params.agentId,
      security: params.security,
      ask: params.ask,
      host: "node",
    });
  const target = await resolveNodeExecutionTarget(params);
  params.signal?.throwIfAborted();
  if (
    shouldSkipNodeApprovalPrepare({
      hostSecurity,
      hostAsk,
      strictInlineEval: params.strictInlineEval,
    })
  ) {
    await assertCurrentNodeGatewayPolicyAllowsDispatch({
      request: params,
      authority: "current-policy",
      currentPolicyAllows: (current) =>
        shouldSkipNodeApprovalPrepare({
          hostSecurity: current.hostSecurity,
          hostAsk: current.hostAsk,
          strictInlineEval: params.strictInlineEval,
        }),
    });
    params.signal?.throwIfAborted();
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
  params.signal?.throwIfAborted();
  const {
    analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied,
    nodeApprovalPolicyKnown,
    nodeSecurity,
    nodeAsk,
    inlineEvalHit,
    requiresSecurityAuditSuppressionApproval,
    requiresOpenClawLifecycleApproval,
    autoReviewArgv,
    allowAlwaysPersistence,
  } = approvalAnalysis;
  const requiresInitialOpenClawLifecycleApproval =
    requiresOpenClawLifecycleApproval && !(hostSecurity === "full" && hostAsk === "off");
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
    requiresSecurityAuditSuppressionApproval ||
    requiresInitialOpenClawLifecycleApproval;
  if (requiresAsk && params.nonInteractiveApproval) {
    const text = `Exec denied (approval_required): ${params.command}`;
    return {
      content: [{ type: "text", text }],
      details: {
        status: "failed",
        exitCode: null,
        failureKind: "approval_required",
        durationMs: 0,
        aggregated: text,
        timedOut: false,
        cwd: prepared.cwd,
      },
    };
  }
  if (requiresSecurityAuditSuppressionApproval) {
    params.warnings.push(
      "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.",
    );
  }
  if (requiresInitialOpenClawLifecycleApproval) {
    params.warnings.push(
      "Warning: OpenClaw lifecycle commands require explicit approval unless exec is running in yolo mode.",
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
      toolCallId: params.toolCallId,
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

  const resolveCurrentTimeoutFallback = async (): Promise<{
    approvedByAsk: boolean;
    deniedReason: string | null;
    hostSecurity: ExecSecurity;
    hostAsk: typeof hostAsk;
    askFallback: ExecSecurity;
    requiresExplicitApproval: boolean;
  }> => {
    try {
      // A timeout is policy, not a human grant. Re-read the Gateway-owned
      // host policy at the decision point so a concurrent revoke wins.
      const current = await execHostShared.resolveExecHostApprovalContext({
        agentId: params.agentId,
        security: params.security,
        ask: params.ask,
        host: "node",
      });
      if (current.askFallback === "deny") {
        return {
          approvedByAsk: false,
          deniedReason: "approval-timeout",
          hostSecurity: current.hostSecurity,
          hostAsk: current.hostAsk,
          askFallback: current.askFallback,
          requiresExplicitApproval: false,
        };
      }
      const currentAnalysis = await analyzeNodeApprovalRequirement({
        request: { ...params, warnings: [] },
        target,
        prepared,
        hostSecurity: current.hostSecurity,
        hostAsk: current.hostAsk,
      });
      if (current.askFallback === "full") {
        return {
          approvedByAsk: true,
          deniedReason: null,
          hostSecurity: current.hostSecurity,
          hostAsk: current.hostAsk,
          askFallback: current.askFallback,
          requiresExplicitApproval:
            currentAnalysis.inlineEvalHit !== null ||
            currentAnalysis.requiresSecurityAuditSuppressionApproval ||
            currentAnalysis.requiresOpenClawLifecycleApproval,
        };
      }
      const authorizationSatisfied =
        currentAnalysis.durableApprovalSatisfied ||
        (currentAnalysis.analysisOk && currentAnalysis.allowlistSatisfied);
      return {
        approvedByAsk: authorizationSatisfied,
        deniedReason: authorizationSatisfied ? null : "approval-timeout: allowlist-miss",
        hostSecurity: current.hostSecurity,
        hostAsk: current.hostAsk,
        askFallback: current.askFallback,
        requiresExplicitApproval:
          currentAnalysis.inlineEvalHit !== null ||
          currentAnalysis.requiresSecurityAuditSuppressionApproval ||
          currentAnalysis.requiresOpenClawLifecycleApproval,
      };
    } catch {
      return {
        approvedByAsk: false,
        deniedReason: "approval-timeout: policy-unavailable",
        hostSecurity: "deny",
        hostAsk,
        askFallback: "deny",
        requiresExplicitApproval: false,
      };
    }
  };

  let inlineApprovedByAsk = false;
  let inlineApprovalDecision: "allow-once" | "allow-always" | null = null;
  let inlineApprovalSource: "ask-fallback" | undefined;
  let inlineApprovalId: string | undefined;
  let inlineDispatchAuthority: NodeGatewayDispatchAuthority = "current-policy";
  let inlineFallbackPolicy: NodeGatewayPolicyCheckpoint | undefined;
  if (requiresAsk) {
    const autoReviewHasBoundCommand = analysisOk && autoReviewArgv !== undefined;
    // Remote policy may be stricter; local auto-review cannot bypass that floor.
    const autoReviewBlockedByNodePolicy =
      params.autoReview === true &&
      hostAsk !== "always" &&
      (!nodeApprovalPolicyKnown ||
        nodeAsk === "always" ||
        (nodeSecurity !== undefined && minSecurity(hostSecurity, nodeSecurity) !== hostSecurity));
    let autoReviewRequiresHumanApproval =
      autoReviewBlockedByNodePolicy ||
      (params.autoReview === true && hostAsk !== "always" && !autoReviewHasBoundCommand) ||
      requiresSecurityAuditSuppressionApproval ||
      requiresInitialOpenClawLifecycleApproval;
    if (
      params.autoReview === true &&
      hostAsk !== "always" &&
      autoReviewHasBoundCommand &&
      !autoReviewBlockedByNodePolicy &&
      !requiresSecurityAuditSuppressionApproval &&
      !requiresInitialOpenClawLifecycleApproval
    ) {
      const reviewer = params.autoReviewer ?? defaultExecAutoReviewer;
      const autoReviewReason =
        inlineEvalHit !== null
          ? "strict-inline-eval"
          : hostSecurity === "allowlist" &&
              (!analysisOk || !allowlistSatisfied) &&
              !durableApprovalSatisfied
            ? "allowlist-miss"
            : "approval-required";
      const pendingDecision = resolveExecAutoReviewDecision(reviewer, {
        command: prepared.rawCommand,
        argv: autoReviewArgv,
        cwd: prepared.cwd,
        envKeys: Object.keys(params.requestedEnv ?? {}).toSorted(),
        host: "node",
        reason: autoReviewReason,
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
      // An injected reviewer cannot keep a cancelled node invocation or approval alive.
      const decision = params.signal
        ? await abortable(params.signal, pendingDecision)
        : await pendingDecision;
      params.signal?.throwIfAborted();
      const autoReviewAllowed = decision.decision === "allow-once" && decision.risk === "low";
      if (autoReviewAllowed) {
        const approvalId = randomUUID();
        await registerNodeApproval(approvalId, {
          requireDeliveryRoute: false,
          suppressDelivery: true,
        });
        await callGatewayTool(
          "exec.approval.resolve",
          { timeoutMs: 15_000 },
          { id: approvalId, decision: "allow-once" },
          { scopes: [APPROVALS_SCOPE], requireAgentRuntimeIdentity: true },
        );
        inlineApprovedByAsk = true;
        inlineApprovalDecision = "allow-once";
        inlineApprovalId = approvalId;
        inlineDispatchAuthority = "auto-review";
      }
      if (!autoReviewAllowed) {
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
          unavailableReason,
          preResolvedDecision,
        })
      ) {
        const {
          baseDecision,
          approvedByAsk: initialApprovedByAsk,
          deniedReason: initialDeniedReason,
        } = execHostShared.createExecApprovalDecisionState({
          decision: preResolvedDecision,
          askFallback,
        });
        let approvedByAsk = initialApprovedByAsk;
        let deniedReason = initialDeniedReason;
        const currentFallback = baseDecision.timedOut
          ? await resolveCurrentTimeoutFallback()
          : null;
        if (currentFallback) {
          approvedByAsk = currentFallback.approvedByAsk;
          deniedReason = currentFallback.deniedReason;
        }
        const strictInlineEvalDecision = execHostShared.enforceStrictInlineEvalApprovalBoundary({
          baseDecision,
          approvedByAsk,
          deniedReason,
          requiresInlineEvalApproval:
            currentFallback?.requiresExplicitApproval ?? inlineEvalHit !== null,
          requiresAutoReviewHumanApproval: autoReviewRequiresHumanApproval,
        });
        if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) {
          throw new Error(
            execHostShared.buildHeadlessExecApprovalDeniedMessage({
              trigger: params.trigger,
              host: "node",
              security: currentFallback?.hostSecurity ?? hostSecurity,
              ask: currentFallback?.hostAsk ?? hostAsk,
              askFallback: currentFallback?.askFallback ?? askFallback,
            }),
          );
        }
        inlineApprovedByAsk = strictInlineEvalDecision.approvedByAsk;
        inlineApprovalSource = preResolvedDecision === null ? "ask-fallback" : undefined;
        if (inlineApprovalSource) {
          inlineDispatchAuthority = "ask-fallback";
          inlineFallbackPolicy = currentFallback ?? undefined;
        } else {
          inlineDispatchAuthority = "human-approval";
        }
        inlineApprovalDecision = inlineApprovalSource
          ? null
          : strictInlineEvalDecision.approvedByAsk
            ? "allow-once"
            : null;
        inlineApprovalId = approvalId;
      } else {
        const followupTarget = execHostShared.buildExecApprovalFollowupTarget({
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
        });
        const sendApprovalRequestFailedFollowup = async (): Promise<void> => {
          if (!params.signal?.aborted) {
            await execHostShared.sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (node=${target.nodeId} id=${approvalId}, approval-request-failed): ${params.command}`,
            );
          }
        };
        let nodeInvocationStarted = false;
        let nodeInvocationCompleted = false;

        void (async () => {
          let decision: string | null | undefined;
          try {
            decision = await execHostShared.resolveApprovalDecisionOrUndefined({
              approvalId,
              preResolvedDecision,
              onFailure: () => void sendApprovalRequestFailedFollowup(),
            });
          } catch (error) {
            // Detached run cancellation has no awaiting tool caller to catch it.
            if (isExecApprovalRunAbortedError(error)) {
              return;
            }
            await sendApprovalRequestFailedFollowup();
            return;
          }
          if (decision === undefined || params.signal?.aborted) {
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
          const approvalSource = decision === null ? "ask-fallback" : undefined;
          let deniedReason = baseDeniedReason;
          const currentFallback = baseDecision.timedOut
            ? await resolveCurrentTimeoutFallback()
            : null;

          if (currentFallback) {
            approvedByAsk = currentFallback.approvedByAsk;
            deniedReason = currentFallback.deniedReason;
            approvalDecision = approvedByAsk ? "allow-once" : null;
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
            requiresInlineEvalApproval:
              currentFallback?.requiresExplicitApproval ?? inlineEvalHit !== null,
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
            await assertCurrentNodeGatewayPolicyAllowsDispatch({
              request: params,
              authority: approvalSource ? "ask-fallback" : "human-approval",
              fallbackPolicy: currentFallback ?? undefined,
            });
            if (params.signal?.aborted) {
              return;
            }
            // Approved follow-up invocations need approval scopes because they mutate remote node state.
            nodeInvocationStarted = true;
            const invocation = await invokeNodeSystemRun({
              invokeWaitMs: target.invokeWaitMs,
              invoke: buildNodeSystemRunInvoke({
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
                approved: approvalSource ? undefined : approvedByAsk,
                approvalDecision: approvalSource
                  ? null
                  : approvalDecision === "allow-always" && inlineEvalHit !== null
                    ? "allow-once"
                    : approvalDecision,
                approvalSource,
                runId: approvalId,
                suppressNotifyOnExit: true,
                notifyOnExit: params.notifyOnExit,
                systemRunPlan: prepared.plan,
              }),
              scopes: APPROVED_NODE_INVOKE_SCOPES,
              signal: params.signal,
            });
            nodeInvocationCompleted = true;
            if (!invocation.ok) {
              await execHostShared.sendExecApprovalFollowupResult(
                followupTarget,
                formatNodeInvokeFailureFollowup({
                  failure: invocation.failure,
                  nodeId: target.nodeId,
                  approvalId,
                  command: params.command,
                }),
              );
              return;
            }
            const raw = invocation.raw as { payload?: unknown };
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
            const output = formatExecApprovalContinuationSourceOutput([
              { label: "stdout", value: payload.stdout },
              { label: "stderr", value: payload.stderr },
              { label: "error", value: payload.error },
            ]);
            const exitLabel = payload.timedOut ? "timeout" : `code ${payload.exitCode ?? "?"}`;
            const summary = output
              ? `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})\n${output}`
              : `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})`;
            await execHostShared.sendExecApprovalFollowupResult(followupTarget, summary);
          } catch {
            if (params.signal?.aborted || nodeInvocationCompleted) {
              return;
            }
            await execHostShared.sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (node=${target.nodeId} id=${approvalId}, invoke-failed): ${params.command}`,
            );
          }
        })().catch(async (error: unknown): Promise<void> => {
          // Once dispatch starts, a delivery failure cannot mean execution was denied.
          if (
            nodeInvocationStarted ||
            params.signal?.aborted ||
            isExecApprovalRunAbortedError(error)
          ) {
            return;
          }
          await sendApprovalRequestFailedFollowup();
        });

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
  params.signal?.throwIfAborted();
  const invoke = buildNodeSystemRunInvoke({
    target,
    command: prepared.argv,
    rawCommand: prepared.transportRawCommand,
    cwd: prepared.cwd,
    agentId: prepared.agentId,
    sessionKey: prepared.sessionKey,
    approved: inlineApprovalSource ? undefined : inlineApprovedByAsk,
    approvalDecision: inlineApprovalSource ? null : inlineApprovalDecision,
    approvalSource: inlineApprovalSource,
    runId: inlineApprovalId,
    notifyOnExit: params.notifyOnExit,
    systemRunPlan: prepared.plan,
  });
  await assertCurrentNodeGatewayPolicyAllowsDispatch({
    request: params,
    authority: inlineDispatchAuthority,
    fallbackPolicy: inlineFallbackPolicy,
    currentPolicyAllows: (current) =>
      !requiresExecApproval({
        ask: current.hostAsk,
        security: current.hostSecurity,
        analysisOk,
        allowlistSatisfied,
        durableApprovalSatisfied,
      }) &&
      inlineEvalHit === null &&
      !requiresSecurityAuditSuppressionApproval &&
      !requiresInitialOpenClawLifecycleApproval,
  });
  params.signal?.throwIfAborted();
  const invocation = await invokeNodeSystemRun({
    invokeWaitMs: target.invokeWaitMs,
    invoke,
    signal: params.signal,
    ...((inlineApprovedByAsk || inlineApprovalSource) && inlineApprovalId
      ? { scopes: APPROVED_NODE_INVOKE_SCOPES }
      : {}),
  });
  if (!invocation.ok) {
    return formatNodeInvokeFailureToolResult({
      failure: invocation.failure,
      nodeId: target.nodeId,
      command: params.command,
      startedAt,
      cwd: params.workdir,
      warnings: [...params.warnings, ...(params.foregroundWarnings ?? [])],
    });
  }
  return formatNodeRunToolResult({
    raw: invocation.raw,
    startedAt,
    cwd: params.workdir,
    warnings: [...params.warnings, ...(params.foregroundWarnings ?? [])],
  });
}
