import { requirePairingAdapter } from "../providers/plugins/pairing.js";
import type { PairingProvider } from "./pairing-store.js";

export function resolvePairingIdLabel(provider: PairingProvider): string {
  return requirePairingAdapter(provider).idLabel;
}
