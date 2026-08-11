import type { callGateway } from "../../../gateway/call.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import {
  loadSubagentSessionEntry,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

type FrozenSessionIdentity = {
  sessionId: string;
  lifecycleRevision: string;
};

export function createSubagentSweepSessionLifecycle(gatewayCall: typeof callGateway) {
  function freezeSessionIdentity(
    childSessionKey: string,
    storeCache: SubagentSessionStoreCache,
  ): FrozenSessionIdentity | undefined {
    const sessionEntry = loadSubagentSessionEntry({ childSessionKey, storeCache });
    const sessionId = sessionEntry?.sessionId?.trim();
    const lifecycleRevision = sessionEntry?.lifecycleRevision?.trim();
    return sessionId && lifecycleRevision ? { sessionId, lifecycleRevision } : undefined;
  }

  async function deleteSession(
    childSessionKey: string,
    identity: FrozenSessionIdentity,
  ): Promise<"deleted" | "changed"> {
    let failure: unknown;
    const outcome = await deleteSubagentSessionForCleanup({
      callGateway: gatewayCall,
      childSessionKey,
      expectedSessionId: identity.sessionId,
      expectedLifecycleRevision: identity.lifecycleRevision,
      onError: (error) => {
        failure = error;
      },
    });
    if (outcome === "failed") {
      throw failure;
    }
    return outcome;
  }

  return { deleteSession, freezeSessionIdentity };
}
