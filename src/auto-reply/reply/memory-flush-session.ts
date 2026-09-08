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

/** Memory inference owns a detached view; an admission excludes its waiting user. */
export async function prepareMemoryFlushSession(params: {
  admission?: UserTurnTranscriptAdmissionReceipt;
  source: SessionTranscriptRuntimeTarget & { agentId: string; sessionKey: string };
  runId: string;
  workspaceDir: string;
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
  await waitForSessionTranscriptProjection(params.source, params.signal);
  params.signal?.throwIfAborted();
  const sessionManager = withSessionContextAdmission(params.source, params.admission, () =>
    SessionManager.openDetachedBounded(params.source, {
      cwd: params.workspaceDir,
      maxBytes: MAX_VISIBLE_MESSAGE_MAX_BYTES,
      maxEvents: MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      onTruncated: () => {
        throw new Error("Memory flush exceeds the bounded conversation view.");
      },
    }),
  );
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
