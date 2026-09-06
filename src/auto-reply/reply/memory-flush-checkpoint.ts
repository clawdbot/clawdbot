import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import {
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
} from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import { withSessionContextAdmission } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";

/** A required checkpoint reads prior conversation without adopting the pending user. */
export async function prepareMemoryFlushCheckpoint(params: {
  admission: UserTurnTranscriptAdmissionReceipt;
  source: SessionTranscriptRuntimeTarget & { agentId: string; sessionKey: string };
  runId: string;
  workspaceDir: string;
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
  await waitForSessionTranscriptProjection(params.source, params.signal);
  params.signal?.throwIfAborted();
  const sessionManager = withSessionContextAdmission(params.source, params.admission, () => {
    const source = SessionManager.openBounded(params.source, {
      cwd: params.workspaceDir,
      maxBytes: MAX_VISIBLE_MESSAGE_MAX_BYTES,
      maxEvents: MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      onTruncated: () => {
        throw new Error("Required memory checkpoint exceeds the bounded prior-context view.");
      },
    });
    // The navigation owner resolves opaque parents and retained compaction boundaries.
    // Copy its projection, never discard those facts by copying raw bounded events.
    return SessionManager.fromEntries(
      [source.getHeader(), ...source.getBranch()],
      params.workspaceDir,
    );
  });
  const identity = resolveInternalSessionEffectsIdentity({
    agentId: params.source.agentId,
    runId: params.runId,
  });
  return {
    ...identity,
    sessionFile: identity.sessionKey,
    sessionTarget: {
      agentId: params.source.agentId,
      storePath: params.source.storePath,
      ...identity,
    },
    sessionManager,
    sessionPersistence: "detached",
  } satisfies Pick<
    RunEmbeddedAgentParams,
    "sessionId" | "sessionKey" | "sessionTarget" | "sessionManager" | "sessionPersistence"
  > & { sessionFile: string };
}
