import type { WorkerSessionsSendParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  callAgentToolGatewayRequest,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { getRuntimeConfig } from "../../config/config.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerTurnExecutionIdentity } from "./placement-turn-claim-events.js";
import { WorkerSessionToolOutcomeUnknownError } from "./worker-session-tool-result.js";
import {
  resolveWorkerSessionToolSource as exactSource,
  resolveWorkerSessionToolTarget as exactAuthorizedTarget,
  type WorkerSessionToolSource as ExactSource,
  type WorkerSessionToolTarget as ExactTarget,
} from "./worker-session-tool-topology.js";

export async function executeWorkerSessionSend(
  placements: WorkerSessionPlacementStore,
  operation: {
    source: ExactSource;
    identity: WorkerConnectionIdentity;
    target: ExactTarget;
    request: WorkerSessionsSendParams;
    idempotencyKey: string;
    signal?: AbortSignal;
    workerIdentity?: WorkerTurnExecutionIdentity;
  },
) {
  operation.signal?.throwIfAborted();
  exactSource({ identity: operation.identity, placements });
  const config = getRuntimeConfig();
  const executeFencedSend = async () => {
    const assertCurrentTarget = () => {
      const target = exactAuthorizedTarget({
        source: operation.source,
        requestedSessionKey: operation.request.sessionKey,
      });
      if (
        target.sessionId !== operation.target.sessionId ||
        target.topologyParent?.sessionKey !== operation.target.topologyParent?.sessionKey ||
        target.topologyParent?.sessionId !== operation.target.topologyParent?.sessionId
      ) {
        throw new Error("Worker sessions_send target incarnation changed");
      }
    };
    assertCurrentTarget();
    const tool = createSessionsSendTool({
      agentSessionKey: operation.source.sessionKey,
      agentChannel: sessionDeliveryChannel(operation.source.entry),
      expectedTargetSessionId: operation.target.sessionId,
      idempotencyKey: operation.idempotencyKey,
      config,
      ...(operation.signal ? { signal: operation.signal } : {}),
      callGateway: async (request) => {
        const workerIdentity = operation.workerIdentity;
        workerIdentity?.receiptAuthority();
        const gatewayRequest = {
          ...request,
          ...(operation.signal ? { signal: operation.signal } : {}),
        };
        return await callAgentToolGatewayRequest(
          workerIdentity
            ? withAgentToolGatewayRuntimeIdentity(gatewayRequest, {
                kind: "agentRuntime",
                agentId: workerIdentity.agentId,
                sessionKey: workerIdentity.sessionKey,
                operationalRunInstance: workerIdentity.operationalRunInstance,
                delegatedAuthority: {
                  kind: "worker",
                  ...workerIdentity.delegatedAuthority,
                  turnClaim: workerIdentity.turnClaim,
                },
                executionIdentity: workerIdentity.executionIdentityToken,
              })
            : gatewayRequest,
        );
      },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      operation.workerIdentity?.receiptAuthority();
      try {
        operation.signal?.throwIfAborted();
        exactSource({ identity: operation.identity, placements });
        assertCurrentTarget();
        return await tool.execute(operation.request.toolCallId, {
          sessionKey: operation.target.sessionKey,
          message: operation.request.message,
          ...(operation.request.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: operation.request.timeoutSeconds }),
        });
      } catch (error) {
        if (attempt === 1) {
          throw new WorkerSessionToolOutcomeUnknownError(error);
        }
      }
    }
    throw new WorkerSessionToolOutcomeUnknownError(
      new Error("Worker sessions_send did not return a result"),
    );
  };
  const topologyParent = operation.target.topologyParent;
  if (!topologyParent) {
    return await executeFencedSend();
  }
  // Sibling authority exists only while the exact shared parent exists. Hold
  // that third incarnation through target admission and the message effect.
  return await runWithScopedSessionAccess({
    cfg: config,
    expectedSessionId: topologyParent.sessionId,
    targetSessionKey: topologyParent.sessionKey,
    ...(operation.signal ? { signal: operation.signal } : {}),
    run: executeFencedSend,
  });
}
