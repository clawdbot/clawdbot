import { canonicalizeLegacySessionKey, isLegacyGroupSessionKey } from "./src/session-contract.js";

export const whatsappLegacySessionSurface = {
  isLegacyGroupSessionKey,
  canonicalizeLegacySessionKey,
};
