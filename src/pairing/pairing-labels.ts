// Resolves human-readable labels for paired channel identities.
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import type { PairingChannel } from "./pairing-store.types.js";

// Pairing label helpers. Channel adapters can customize the id label shown in
// owner approval prompts; legacy channels fall back to userId.
export function resolvePairingIdLabel(channel: PairingChannel): string {
  return getPairingAdapter(channel)?.idLabel ?? "userId";
}
