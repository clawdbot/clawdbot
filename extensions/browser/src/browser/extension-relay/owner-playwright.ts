import type { Browser } from "playwright-core";
import { connectOverCdpTransport } from "../pw-session-cdp-transport.js";
import type { RelayOperationReference } from "./owner-client.js";
import { getBorrowedRelayCdpAccess, type BorrowedRelayAccess } from "./relay-access.js";

// Navigation recovery gets its own reference-bound connection. DOM references remain
// on the ordinary cached Page/Frame and are never copied into this operation cache.
const operationConnections = new WeakMap<RelayOperationReference, Promise<Browser>>();

export async function closeRelayOperationConnection(
  reference: RelayOperationReference,
): Promise<void> {
  const pending = operationConnections.get(reference);
  if (!pending) {
    return;
  }
  await (await pending).close();
  if (operationConnections.get(reference) === pending) {
    operationConnections.delete(reference);
  }
}

export async function connectRelayBrowser(
  relay: BorrowedRelayAccess,
  cdpUrl: string,
  reference?: RelayOperationReference,
): Promise<Browser> {
  const existing = reference && operationConnections.get(reference);
  if (existing) {
    const browser = await existing;
    relay.client.assertCurrent();
    if (!(await reference.resolve())) {
      throw new Error("Captured relay connection was superseded");
    }
    return browser;
  }
  const pending = (async () => {
    const transport = await (reference ? reference.openTransport() : relay.client.openTransport());
    const browser = await connectOverCdpTransport(cdpUrl, {
      timeout: 5_000,
      headers: {},
      preparedTransport: transport,
    });
    try {
      if (
        getBorrowedRelayCdpAccess(cdpUrl) !== relay ||
        (reference && !(await reference.resolve()))
      ) {
        throw new Error("Captured relay connection was superseded");
      }
      return browser;
    } catch (error) {
      await browser.close();
      throw error;
    }
  })();
  if (reference) {
    operationConnections.set(reference, pending);
    void pending.catch(() => {
      if (operationConnections.get(reference) === pending) {
        operationConnections.delete(reference);
      }
    });
  }
  return await pending;
}
