import type { callGateway } from "../gateway/call.js";
import { isSessionLifecycleChangedGatewayError } from "./subagent-session-cleanup.js";
import {
  loadSubagentSessionEntry,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

type FrozenSessionIdentity = {
  sessionId: string;
  lifecycleRevision: string;
};

export function createSubagentSweepSessionCleanup(call: typeof callGateway) {
  const freezeSessionIdentity = (
    childSessionKey: string,
    storeCache: SubagentSessionStoreCache,
  ): FrozenSessionIdentity | undefined => {
    const sessionEntry = loadSubagentSessionEntry({ childSessionKey, storeCache });
    const sessionId = sessionEntry?.sessionId?.trim();
    const lifecycleRevision = sessionEntry?.lifecycleRevision?.trim();
    return sessionId && lifecycleRevision ? { sessionId, lifecycleRevision } : undefined;
  };

  const deleteSession = async (
    childSessionKey: string,
    identity: FrozenSessionIdentity,
  ): Promise<"deleted" | "changed"> => {
    try {
      await call({
        method: "sessions.delete",
        params: {
          key: childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: false,
          expectedSessionId: identity.sessionId,
          expectedLifecycleRevision: identity.lifecycleRevision,
        },
        timeoutMs: 10_000,
      });
      return "deleted";
    } catch (error) {
      if (isSessionLifecycleChangedGatewayError(error)) {
        return "changed";
      }
      throw error;
    }
  };

  return { deleteSession, freezeSessionIdentity };
}
