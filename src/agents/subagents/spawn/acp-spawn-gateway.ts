import type { ExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import type { AcpSpawnBootstrapDeliveryPlan } from "./acp-spawn-bootstrap-delivery.js";
import type { AcpSpawnInitializedRuntime } from "./acp-spawn-runtime.js";
import { terminateAcceptedCollectorRun } from "./subagent-spawn-cleanup.js";
import {
  buildSubagentExecutionSessionSpawnContext,
  withSubagentGatewayExecutionIdentity,
} from "./subagent-spawn-execution-identity.js";
import { callSubagentGateway, readGatewayRunId } from "./subagent-spawn-gateway.js";

type AcceptedRunCleanupOwnership = Awaited<ReturnType<typeof terminateAcceptedCollectorRun>>;

export async function launchAcpChildThroughGateway(params: {
  attachments?: unknown[];
  childIdem: string;
  deliveryPlan: AcpSpawnBootstrapDeliveryPlan;
  initializedSession: AcpSpawnInitializedRuntime;
  label?: string;
  lineage: Parameters<typeof buildSubagentExecutionSessionSpawnContext>[0];
  onAcceptedRunTermination: (ownership: AcceptedRunCleanupOwnership) => void;
  parentExecutionIdentityToken?: ExecutionIdentityAdmissionToken;
  runTimeoutSeconds: number;
  sessionKey: string;
  signal?: AbortSignal;
  task: string;
}) {
  const response = await callSubagentGateway(
    withSubagentGatewayExecutionIdentity(
      {
        method: "agent",
        params: {
          message: params.task,
          sessionKey: params.sessionKey,
          channel: params.deliveryPlan.channel,
          to: params.deliveryPlan.to,
          accountId: params.deliveryPlan.accountId,
          threadId: params.deliveryPlan.threadId,
          idempotencyKey: params.childIdem,
          deliver: params.deliveryPlan.useInlineDelivery,
          lane: AGENT_LANE_SUBAGENT,
          acpTurnSource: "manual_spawn",
          timeout: params.runTimeoutSeconds,
          label: params.label || undefined,
          ...(params.attachments ? { attachments: params.attachments } : {}),
        },
        timeoutMs: 10_000,
      },
      {
        sessionSpawnContext: buildSubagentExecutionSessionSpawnContext(params.lineage),
        parentExecutionIdentityToken: params.parentExecutionIdentityToken,
      },
    ),
  );
  if (params.signal?.aborted) {
    const ownership = await terminateAcceptedCollectorRun({
      childSessionKey: params.sessionKey,
      gatewayRunId: readGatewayRunId(response) ?? params.childIdem,
      expectedSessionId: params.initializedSession.sessionId,
      expectedLifecycleRevision: params.initializedSession.sessionEntry?.lifecycleRevision,
      releaseSessionAfterAbort: true,
    });
    params.onAcceptedRunTermination(ownership);
    params.signal.throwIfAborted();
  }
  recordSessionParticipantBestEffort({
    actor: { type: "agent", id: params.lineage.parentAgentId },
    agentId: params.lineage.targetAgentId,
    sessionKey: params.sessionKey,
    source: "agent",
    storePath: params.initializedSession.storePath,
  });
  return response;
}
