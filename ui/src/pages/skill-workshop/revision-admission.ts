import { readSkillProposalRevisionChangedError } from "@openclaw/gateway-protocol";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type {
  SkillWorkshopRevisionAdmissionBinding,
  SkillWorkshopRevisionAdmissionEntry,
} from "../../app/skill-workshop-revision-admissions.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { SkillProposalInspectResult } from "./proposal-records.ts";
import { resolveSkillWorkshopRevisionTarget } from "./revision-session.ts";

export async function requestSkillWorkshopRevisionAdmission(params: {
  context: ApplicationContext;
  entry: SkillWorkshopRevisionAdmissionEntry;
  materialize: (
    binding: SkillWorkshopRevisionAdmissionBinding,
  ) => SkillWorkshopRevisionAdmissionEntry | null;
}) {
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
  let entry = params.entry;
  if (!entry.expectedRevisionHash) {
    const result = await client.request<SkillProposalInspectResult>("skills.proposals.inspect", {
      agentId: normalizeAgentId(entry.proposalAgentId),
      proposalId: entry.proposalId,
    });
    if (!isCurrent()) {
      throw new Error("Revision request was interrupted before proposal inspection completed.");
    }
    const expectedRevisionHash = result.revisionHash?.trim();
    if (!expectedRevisionHash) {
      throw new Error("The proposal revision binding is unavailable.");
    }
    const origin = result.record.origin;
    const materialized = params.materialize({
      expectedRevisionHash,
      ...(origin?.agentId ? { proposalOriginAgentId: origin.agentId } : {}),
      ...(origin?.sessionKey ? { proposalOriginSessionKey: origin.sessionKey } : {}),
    });
    if (!materialized) {
      throw new Error("Revision recovery is no longer available.");
    }
    entry = materialized;
  }
  if (!entry.expectedRevisionHash) {
    throw new Error("Revision recovery is no longer available.");
  }
  const target = await resolveSkillWorkshopRevisionTarget(entry, params.context, isCurrent);
  if (!target) {
    throw new Error("Revision request was interrupted before admission.");
  }
  const result = await client
    .request<{ status: "started" | "in_flight" | "ok" | "timeout" | "error" }>(
      "skills.proposals.requestRevision",
      {
        agentId: normalizeAgentId(entry.proposalOriginAgentId ?? entry.proposalAgentId),
        targetAgentId: target.targetAgentId,
        proposalId: entry.proposalId,
        expectedRevisionHash: entry.expectedRevisionHash,
        instructions: entry.instructions,
        sessionKey: target.sessionKey,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        idempotencyKey: entry.idempotencyKey,
      },
    )
    .catch((error: unknown) => {
      if (readSkillProposalRevisionChangedError(error)) {
        return { status: "revision-changed" as const };
      }
      throw error;
    });
  if (result.status === "revision-changed") {
    return result;
  }
  if (result.status !== "started" && result.status !== "in_flight" && result.status !== "ok") {
    throw new Error(`Gateway returned ${result.status} before admitting the revision request.`);
  }
  return { sessionKey: target.sessionKey, status: "admitted" as const };
}
