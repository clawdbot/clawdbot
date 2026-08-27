import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { getOwnedSessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import type { SessionTranscriptDeliveryMirror } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Transcript append data emitted after an outbound send completes.
 */
export type OutboundMirror = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
};

/**
 * Delivery-layer mirror data with optional group/channel correlation metadata.
 */
export type DeliveryMirror = OutboundMirror & {
  /** Whether this message is being sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier for correlation with received events */
  groupId?: string;
};

/** Resolves the ambient run fence for a mirror without overriding an explicit generation. */
export function resolveOutboundMirrorWriterFence(
  cfg: OpenClawConfig,
  mirror: OutboundMirror,
): { expectedLifecycleRevision?: string; expectedWriterRunId?: string } {
  const writerFence = mirror.agentId
    ? getOwnedSessionTranscriptWriterFence({
        sessionKey: mirror.sessionKey,
        sessionTarget: {
          agentId: mirror.agentId,
          sessionId: mirror.expectedSessionId,
          sessionKey: mirror.sessionKey,
          storePath: resolveSessionStorePathCore(cfg.session?.store, {
            agentId: mirror.agentId,
          }),
        },
      })
    : getOwnedSessionTranscriptWriterFence({ sessionKey: mirror.sessionKey });
  return {
    ...(mirror.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: mirror.expectedLifecycleRevision }
      : writerFence?.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
        : {}),
    ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
  };
}
