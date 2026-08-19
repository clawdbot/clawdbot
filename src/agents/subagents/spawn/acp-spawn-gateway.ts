import type { ExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import type { AcpSpawnBootstrapDeliveryPlan } from "./acp-spawn-bootstrap-delivery.js";
import {
  buildSubagentExecutionSessionSpawnContext,
  withSubagentGatewayExecutionIdentity,
} from "./subagent-spawn-execution-identity.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

export async function launchAcpChildThroughGateway(params: {
  attachments?: unknown[];
  childIdem: string;
  deliveryPlan: AcpSpawnBootstrapDeliveryPlan;
  label?: string;
  lineage: Parameters<typeof buildSubagentExecutionSessionSpawnContext>[0];
  parentExecutionIdentityToken?: ExecutionIdentityAdmissionToken;
  participantStorePath: string;
  runTimeoutSeconds: number;
  sessionKey: string;
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
  recordSessionParticipantBestEffort({
    actor: { type: "agent", id: params.lineage.parentAgentId },
    agentId: params.lineage.targetAgentId,
    sessionKey: params.sessionKey,
    source: "agent",
    storePath: params.participantStorePath,
  });
  return response;
}
