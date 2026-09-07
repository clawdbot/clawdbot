// Android node capability policy source fixture describes gateway connection inputs.
import type { GatewayConnectionDetails } from "../../../src/gateway/call.js";

// Test helper for deciding when Android node policy config should be fetched remotely.

/** Return true when gateway details represent a remote node, not local loopback. */
export function shouldFetchRemotePolicyConfig(details: GatewayConnectionDetails): boolean {
  return details.urlSource !== "local loopback";
}
