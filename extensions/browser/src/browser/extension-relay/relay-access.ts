import type { RelayOwnerClient } from "./owner-client.js";
import type { ExtensionRelayHandle } from "./relay-server.js";

export type BorrowedRelayAccess = {
  ownership: "borrowed";
  port: number;
  token: string;
  /** The requesting profile's policy; the listener's policy is never changed. */
  allowLegacyAuth: boolean;
  client: RelayOwnerClient;
  close: () => Promise<void>;
};
export type ExtensionRelayResource = ExtensionRelayHandle | BorrowedRelayAccess;

// Prepared by the profile lifecycle only. This registry never discovers keys or listeners.
const borrowedCdpAccess = new Map<
  string,
  { relay: BorrowedRelayAccess; assertCurrent: () => void }
>();

export function registerBorrowedRelayCdpAccess(
  cdpUrl: string,
  relay: BorrowedRelayAccess,
  assertCurrent: () => void,
): () => void {
  const entry = { relay, assertCurrent };
  borrowedCdpAccess.set(cdpUrl.replace(/\/$/u, ""), entry);
  return () => {
    const key = cdpUrl.replace(/\/$/u, "");
    if (borrowedCdpAccess.get(key) === entry) {
      borrowedCdpAccess.delete(key);
    }
  };
}

export function getBorrowedRelayCdpAccess(cdpUrl: string): BorrowedRelayAccess | undefined {
  const entry = borrowedCdpAccess.get(cdpUrl.replace(/\/$/u, ""));
  if (!entry) {
    return undefined;
  }
  entry.assertCurrent();
  entry.relay.client.assertCurrent();
  return entry.relay;
}
