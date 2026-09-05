import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";

/** Builds the fresh runtime identity paired with a recovered transcript. */
export function buildRestartRecoverySuccessorEntry(params: {
  sessionId: string;
  source: InternalSessionEntry;
  creation: Pick<Parameters<typeof buildSessionCreationStamp>[0], "actor" | "sandbox">;
}): InternalSessionEntry & { sessionId: string } {
  const source = params.source;
  const entry = mergeSessionEntry(undefined, {
    ...inheritSessionSelection(source),
    ...buildSessionCreationStamp({ via: "operator", ...params.creation }),
    delivery: normalizeSessionDeliveryState(),
    sessionId: params.sessionId,
    previousSessionId: source.sessionId,
    spawnDepth: 0,
    ...(source.agentHarnessId ? { agentHarnessId: source.agentHarnessId } : {}),
    ...(source.modelSelectionLocked === true ? { modelSelectionLocked: true as const } : {}),
    ...(source.pluginOwnerId ? { pluginOwnerId: source.pluginOwnerId } : {}),
    ...(source.visibility ? { visibility: source.visibility } : {}),
    ...(source.spawnedCwd ? { spawnedCwd: source.spawnedCwd } : {}),
    ...(source.execHost ? { execHost: source.execHost } : {}),
    ...(source.execNode ? { execNode: source.execNode } : {}),
    ...(source.execCwd ? { execCwd: source.execCwd } : {}),
  });
  return { ...entry, ...buildMainSessionRecoveryClearPatch(entry), sessionId: params.sessionId };
}
