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
  // The route rewrite changes admission scope. Preserve the private carrier
  // operation so the replacement records unknown instead of reusing authority.
  copyChannelParticipantAdmissionEvidence(context, scoped);
  return scoped;
}
