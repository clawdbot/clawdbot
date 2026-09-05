import type { WorkerSkillWorkshopParams } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { sameWorkerSessionTurnClaim, type WorkerSessionTurnClaim } from "./placement-record.js";

type Registration = {
  claim: WorkerSessionTurnClaim;
  tool: AnyAgentTool;
  assertCurrent: () => void;
  calls: Map<string, { digest: string; result: ReturnType<AnyAgentTool["execute"]> }>;
};
const active = new Map<string, Registration>();

/** The launch owner retains the closure; the worker receives no profile or role bearer grant. */
export function registerWorkerSkillAuthoring(
  claim: WorkerSessionTurnClaim,
  tool: AnyAgentTool,
  assertCurrent: () => void,
): () => void {
  const registration: Registration = { claim, tool, assertCurrent, calls: new Map() };
  if (active.has(claim.sessionId)) {
    throw new Error("Worker skill authoring already has an active owner.");
  }
  active.set(claim.sessionId, registration);
  return () => {
    if (active.get(claim.sessionId) === registration) {
      active.delete(claim.sessionId);
    }
  };
}

export async function invokeWorkerSkillAuthoring(
  claim: WorkerSessionTurnClaim,
  request: WorkerSkillWorkshopParams,
) {
  const registration = active.get(claim.sessionId);
  if (!registration || !sameWorkerSessionTurnClaim(registration.claim, claim)) {
    throw new Error("Worker skill authoring expired. Send a fresh attributed message.");
  }
  registration.assertCurrent();
  const digest = JSON.stringify(request);
  const previous = registration.calls.get(request.toolCallId);
  if (previous && previous.digest !== digest) {
    throw new Error("Workshop tool call id was reused with different arguments.");
  }
  if (!previous && registration.calls.size >= 64) {
    throw new Error("This turn reached its Workshop operation limit. Continue in a fresh turn.");
  }
  const result =
    previous?.result ?? registration.tool.execute(request.toolCallId, request.arguments);
  registration.calls.set(request.toolCallId, { digest, result });
  const value = await result;
  registration.assertCurrent();
  return value;
}
