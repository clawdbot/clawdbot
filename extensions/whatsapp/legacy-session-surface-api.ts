// Whatsapp API module exposes the plugin public contract.
import { canonicalizeLegacySessionKey, isLegacyGroupSessionKey } from "./src/session-contract.js";

export const whatsappLegacySessionSurface = {
  isLegacyGroupSessionKey,
  canonicalizeLegacySessionKey,
};
