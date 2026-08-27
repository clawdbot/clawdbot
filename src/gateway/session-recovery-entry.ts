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
  actor?: NonNullable<InternalSessionEntry["createdActor"]>;
}): InternalSessionEntry & { sessionId: string } {
  const source = params.source;
  const entry = mergeSessionEntry(undefined, {
    ...inheritSessionSelection(source),
    ...buildSessionCreationStamp({
      via: "operator",
      actor: params.actor,
      ...(source.sandbox ? { sandbox: source.sandbox } : {}),
    }),
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
    ...(source.execSecurity ? { execSecurity: source.execSecurity } : {}),
    ...(source.execAsk ? { execAsk: source.execAsk } : {}),
  });
  return { ...entry, ...buildMainSessionRecoveryClearPatch(entry), sessionId: params.sessionId };
}
