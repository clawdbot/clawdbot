import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SkillWorkshopRevisionAdmissionEntry } from "../../app/skill-workshop-revision-admissions.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { resolveSkillWorkshopRevisionTarget } from "./revision-session.ts";

export async function requestSkillWorkshopRevisionAdmission(params: {
  context: ApplicationContext;
  entry: SkillWorkshopRevisionAdmissionEntry;
}): Promise<{ sessionKey: string }> {
  const source = params.context.gateway.snapshot;
  const client = source.client;
  if (!client) {
    throw new Error("Gateway is not connected.");
  }
  const isCurrent = () => {
    const current: ApplicationGatewaySnapshot = params.context.gateway.snapshot;
    return (
      current.phase === "connected" && current.client === client && current.hello === source.hello
    );
  };
  const target = await resolveSkillWorkshopRevisionTarget(params.entry, params.context, isCurrent);
  if (!target) {
    throw new Error("Revision request was interrupted before admission.");
  }
  const result = await client.request<{
    status: "started" | "in_flight" | "ok" | "timeout" | "error";
  }>("skills.proposals.requestRevision", {
    agentId: normalizeAgentId(params.entry.proposalOriginAgentId ?? params.entry.proposalAgentId),
    targetAgentId: target.targetAgentId,
    proposalId: params.entry.proposalId,
    expectedRevisionHash: params.entry.expectedRevisionHash,
    instructions: params.entry.instructions,
    sessionKey: target.sessionKey,
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    idempotencyKey: params.entry.idempotencyKey,
  });
  if (result.status !== "started" && result.status !== "in_flight" && result.status !== "ok") {
    throw new Error(`Gateway returned ${result.status} before admitting the revision request.`);
  }
  return { sessionKey: target.sessionKey };
}
