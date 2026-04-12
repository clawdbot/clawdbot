import { getPairingAdapter } from "../channels/plugins/pairing.js";
import type { PairingChannel } from "./pairing-store.types.js";

export function resolvePairingIdLabel(channel: PairingChannel): string {
  return getPairingAdapter(channel)?.idLabel ?? "userId";
}
