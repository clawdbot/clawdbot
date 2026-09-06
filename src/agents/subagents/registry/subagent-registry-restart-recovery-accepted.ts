import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { resolveInternalSessionEffectsTarget } from "../../internal-session-effects.js";
import { isRestartRecoveryLifecycleCurrent } from "./subagent-registry-restart-recovery-helpers.js";
import {
  confirmAcceptedRecoveryResumption,
  settleAcceptedRecoverySession,
  shouldConfirmAcceptedRecoveryResumption,
} from "./subagent-registry-restart-recovery-session.js";
import type {
  RestartRecoveryParams,
  RestartRecoveryResult,
} from "./subagent-registry-restart-recovery-types.js";
import type {
  SubagentRestartRecoveryReceipt,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export async function reconcileAcceptedRecovery(params: {
  agentId: string;
  attempts: number;
  childSessionKey: string;
  currentSessionId?: string;
  currentSessionLifecycleRevision?: string;
  clearAcceptedRecovery: RestartRecoveryParams["clearAcceptedRecovery"];
  clearPendingNotice: RestartRecoveryParams["clearPendingNotice"];
  entry: SubagentRunRecord;
  getRun: RestartRecoveryParams["getRun"];
  gatewayRuntime: GatewayRecoveryRuntime | undefined;
  isCurrent: RestartRecoveryParams["isCurrent"];
  now: number;
  receipt: SubagentRestartRecoveryReceipt;
  replaceRun: RestartRecoveryParams["replaceRun"];
  resumeAcceptedRecovery: RestartRecoveryParams["resumeAcceptedRecovery"];
  runId: string;
  storePath: string;
  warn: RestartRecoveryParams["warn"];
}): Promise<RestartRecoveryResult> {
  let owner = params.entry;
  if (!isRestartRecoveryLifecycleCurrent(params.receipt)) {
    return {
      status: "terminal",
      error: "retired Gateway lifecycle",
      suppressSessionEffects: true,
      target: { runId: owner.runId, entry: owner },
    };
  }
  const resolveGatewayContext = params.gatewayRuntime
    ? getGatewayContextResolver(params.gatewayRuntime)
    : undefined;
  const ownsRecoveryGateway = () =>
    resolveGatewayContext?.()?.recoveryRuntime === params.gatewayRuntime &&
    params.gatewayRuntime !== undefined;
  if (!ownsRecoveryGateway()) {
    return { status: "deferred" };
  }
  if (params.runId !== params.receipt.idempotencyKey) {
    let remapped = false;
    let remapError: unknown;
    try {
      remapped =
        params.isCurrent(params.runId, params.entry) &&
        params.replaceRun({
          previousRunId: params.runId,
          nextRunId: params.receipt.idempotencyKey,
          fallback: params.entry,
          expected: params.entry,
          transcriptTarget: resolveInternalSessionEffectsTarget({
            agentId: params.agentId,
            runId: params.receipt.idempotencyKey,
            storePath: params.storePath,
          }),
          task: params.entry.task,
          restartRecovery: params.receipt,
          preserveRequesterSettleWake: true,
          // A replacement execution belongs to the Gateway that accepted it.
          // Its predecessor must retain its closed resolver for stale callbacks.
          gatewayContextResolver: resolveGatewayContext,
          persistenceFailure: "return-false",
        });
    } catch (error) {
      remapError = error;
    }
    if (!remapped) {
      params.warn("accepted subagent restart recovery could not remap its exact row", {
        runId: params.runId,
        childSessionKey: params.childSessionKey,
        ...(remapError ? { error: remapError } : {}),
      });
      return {
        status: "deferred",
      };
    }
    const successor = params.getRun(params.receipt.idempotencyKey);
    if (
      !successor ||
      successor.execution.restartRecovery !== params.receipt ||
      !params.isCurrent(successor.runId, successor)
    ) {
      params.warn("accepted subagent restart recovery lost its remapped owner", {
        runId: params.runId,
        childSessionKey: params.childSessionKey,
      });
      return { status: "deferred" };
    }
    owner = successor;
  }
  const ownsAcceptedTarget = () =>
    params.isCurrent(owner.runId, owner) &&
    owner.execution.restartRecovery === params.receipt &&
    isRestartRecoveryLifecycleCurrent(params.receipt) &&
    ownsRecoveryGateway();

  if (
    !params.currentSessionId ||
    params.currentSessionId !== params.receipt.sessionId ||
    (params.receipt.sessionLifecycleRevision !== undefined &&
      params.currentSessionLifecycleRevision !== params.receipt.sessionLifecycleRevision)
  ) {
    return {
      status: "terminal",
      error:
        "accepted subagent restart recovery lost its exact session before ownership settlement",
      suppressSessionEffects: true,
      target: { runId: owner.runId, entry: owner },
    };
  }

  try {
    if (
      !(await settleAcceptedRecoverySession({
        attempts: params.attempts,
        childSessionKey: params.childSessionKey,
        isOwnerCurrent: ownsAcceptedTarget,
        sessionId: params.receipt.sessionId,
        sessionLifecycleRevision: params.receipt.sessionLifecycleRevision,
        now: params.now,
        runId: owner.runId,
        storePath: params.storePath,
      }))
    ) {
      if (!isRestartRecoveryLifecycleCurrent(params.receipt)) {
        return {
          status: "terminal",
          error: "retired Gateway lifecycle",
          suppressSessionEffects: true,
          target: { runId: owner.runId, entry: owner },
        };
      }
      params.warn("accepted subagent restart recovery session changed during settlement", {
        runId: owner.runId,
        childSessionKey: params.childSessionKey,
      });
      return { status: "deferred" };
    }
  } catch (error) {
    if (!isRestartRecoveryLifecycleCurrent(params.receipt)) {
      return {
        status: "terminal",
        error: "retired Gateway lifecycle",
        suppressSessionEffects: true,
        target: { runId: owner.runId, entry: owner },
      };
    }
    params.warn("accepted subagent restart recovery could not clear its abort marker", {
      runId: owner.runId,
      childSessionKey: params.childSessionKey,
      error,
    });
    return { status: "deferred" };
  }
  if (!isRestartRecoveryLifecycleCurrent(params.receipt)) {
    return {
      status: "terminal",
      error: "retired Gateway lifecycle",
      suppressSessionEffects: true,
      target: { runId: owner.runId, entry: owner },
    };
  }
  const noticeRequired = shouldConfirmAcceptedRecoveryResumption(owner);
  try {
    if (
      !ownsAcceptedTarget() ||
      !params.clearAcceptedRecovery({
        runId: owner.runId,
        expected: owner,
        sessionId: params.receipt.sessionId,
        idempotencyKey: params.receipt.idempotencyKey,
        pendingNoticeIdempotencyKey: noticeRequired ? params.receipt.idempotencyKey : undefined,
      })
    ) {
      params.warn("accepted subagent restart recovery could not retire its receipt", {
        runId: owner.runId,
        childSessionKey: params.childSessionKey,
      });
      return { status: "deferred" };
    }
  } catch (error) {
    params.warn("accepted subagent restart recovery could not persist receipt retirement", {
      error,
      runId: owner.runId,
      childSessionKey: params.childSessionKey,
    });
    return { status: "deferred" };
  }
  const ownsSettledTarget = () =>
    params.isCurrent(owner.runId, owner) &&
    owner.execution.restartRecovery === undefined &&
    isRestartRecoveryLifecycleCurrent(params.receipt) &&
    ownsRecoveryGateway();
  const ownsPendingNoticeTarget = () =>
    ownsSettledTarget() && owner.resumptionNotice?.idempotencyKey === params.receipt.idempotencyKey;
  if (noticeRequired) {
    const resumptionConfirmed = await confirmAcceptedRecoveryResumption({
      childSessionKey: params.childSessionKey,
      gatewayRuntime: params.gatewayRuntime,
      idempotencyKey: params.receipt.idempotencyKey,
      isOwnerCurrent: ownsPendingNoticeTarget,
      owner,
      warn: params.warn,
    });
    if (resumptionConfirmed) {
      try {
        if (
          !ownsPendingNoticeTarget() ||
          !params.clearPendingNotice({
            runId: owner.runId,
            expected: owner,
            idempotencyKey: params.receipt.idempotencyKey,
          })
        ) {
          return { status: "deferred" };
        }
      } catch (error) {
        params.warn("accepted subagent restart recovery could not retire older notice debt", {
          runId: owner.runId,
          childSessionKey: params.childSessionKey,
          error,
        });
        return { status: "deferred" };
      }
    }
  }
  if (
    !ownsSettledTarget() ||
    !params.resumeAcceptedRecovery({
      runId: owner.runId,
      expected: owner,
    })
  ) {
    params.warn("accepted subagent restart recovery lost its settled owner", {
      runId: owner.runId,
      childSessionKey: params.childSessionKey,
    });
    return { status: "deferred" };
  }
  return { status: "accepted" };
}
