import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway } from "./context.ts";

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Gateway wait aborted", "AbortError");
}

export function waitForGatewayClient(
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">,
  signal: AbortSignal,
): Promise<GatewayBrowserClient> {
  const current = gateway.snapshot.client;
  if (current && gateway.snapshot.phase === "connected") {
    return Promise.resolve(current);
  }
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    let settled = false;
    const cleanup = () => {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    unsubscribe = gateway.subscribe((snapshot) => {
      if (snapshot.phase === "connected" && snapshot.client) {
        settled = true;
        cleanup();
        resolve(snapshot.client);
      }
    });
    if (settled) {
      unsubscribe();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}
