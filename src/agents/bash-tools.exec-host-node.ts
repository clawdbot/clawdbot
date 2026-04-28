import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
} from "../infra/exec-approvals.js";
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
import { callGatewayTool } from "./tools/gateway.js";

export type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";

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
  const { analysisOk, allowlistSatisfied, durableApprovalSatisfied, inlineEvalHit } =
    approvalAnalysis;
  const requiresAsk =
    requiresExecApproval({
      ask: hostAsk,
      security: hostSecurity,
      analysisOk,
      allowlistSatisfied,
      durableApprovalSatisfied,
    }) || inlineEvalHit !== null;

  let inlineApprovedByAsk = false;
  let inlineApprovalDecision: "allow-once" | "allow-always" | null = null;
  let inlineApprovalId: string | undefined;
  if (requiresAsk) {
    const requestArgs = execHostShared.buildDefaultExecApprovalRequestArgs({
      warnings: params.warnings,
      approvalRunningNoticeMs: params.approvalRunningNoticeMs,
      createApprovalSlug,
      turnSourceChannel: params.turnSourceChannel,
      turnSourceAccountId: params.turnSourceAccountId,
    });
    const registerNodeApproval = async (approvalId: string) =>
      await registerExecApprovalRequestForHostOrThrow({
        approvalId,
        systemRunPlan: prepared.plan,
        env: target.env,
        workdir: prepared.cwd,
        host: "node",
        nodeId: target.nodeId,
        security: hostSecurity,
        ask: hostAsk,
        ...buildExecApprovalRequesterContext({
          agentId: prepared.agentId,
          sessionKey: prepared.sessionKey,
        }),
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
          deniedReason: initialDeniedReason,
        } = execHostShared.createExecApprovalDecisionState({
          decision,
          askFallback,
        });
        let approvedByAsk = initialApprovedByAsk;
        let approvalDecision: "allow-once" | "allow-always" | null = null;
        let deniedReason = initialDeniedReason;

        if (baseDecision.timedOut && askFallback === "full" && approvedByAsk) {
          approvalDecision = "allow-once";
        } else if (decision === "allow-once") {
          approvedByAsk = true;
          approvalDecision = "allow-once";
        } else if (decision === "allow-always") {
          approvedByAsk = true;
          approvalDecision = "allow-always";
        }

        ({ approvedByAsk, deniedReason } = execHostShared.enforceStrictInlineEvalApprovalBoundary({
          baseDecision,
          approvedByAsk,
          deniedReason,
          requiresInlineEvalApproval: inlineEvalHit !== null,
        }));
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
          const raw = await callGatewayTool(
            "node.invoke",
            { timeoutMs: target.invokeTimeoutMs },
            buildNodeSystemRunInvoke({
              target,
              command: prepared.argv,
              rawCommand: prepared.rawCommand,
              cwd: prepared.cwd,
              agentId: prepared.agentId,
              sessionKey: prepared.sessionKey,
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
          const output = normalizeNotifyOutput(combined.slice(-DEFAULT_NOTIFY_TAIL_CHARS));
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
        allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: hostAsk }),
        nodeId: target.nodeId,
      });
    }
  }

  const startedAt = Date.now();
  const raw = await callGatewayTool(
    "node.invoke",
    { timeoutMs: target.invokeTimeoutMs },
    buildNodeSystemRunInvoke({
      target,
      command: prepared.argv,
      rawCommand: prepared.rawCommand,
      cwd: prepared.cwd,
      agentId: prepared.agentId,
      sessionKey: prepared.sessionKey,
      approved: inlineApprovedByAsk,
      approvalDecision: inlineApprovalDecision,
      runId: inlineApprovalId,
      notifyOnExit: params.notifyOnExit,
      systemRunPlan: prepared.plan,
    }),
  );
  return formatNodeRunToolResult({ raw, startedAt, cwd: params.workdir });
}
