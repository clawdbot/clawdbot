import { copyChannelParticipantAdmissionEvidence } from "../message-access/admission-evidence.js";
import type { AssembledChannelTurn } from "./types.js";

export function applyRouteDmScope<T extends AssembledChannelTurn["ctxPayload"]>(
  context: T,
  dmScope: string | undefined,
): T {
  if (!dmScope || context.DmScope === dmScope) {
    return context;
  }
  const scoped = { ...context, DmScope: dmScope } as T;
  // Finalized contexts carry identity evidence out-of-band; keep it attached
  // when routing replaces the object to add the authoritative DM scope.
  copyChannelParticipantAdmissionEvidence(context, scoped);
  return scoped;
}
