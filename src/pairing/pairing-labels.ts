import { requirePairingAdapter } from "../channels/plugins/pairing.js";
import type { PairingChannel } from "./pairing-store.js";

export function resolvePairingIdLabel(channel: PairingChannel): string {
  return requirePairingAdapter(channel).idLabel;
}
