// Prints the local node host device identity for pairing verification.
import {
  loadDeviceIdentityIfPresent,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { defaultRuntime } from "../../runtime.js";

/**
 * Read-only by design: the SSH-verified pairing probe calls this remotely and
 * must never mint a fresh identity on a host that has not run the node host.
 */
export function runNodeIdentityShow(opts: { json?: boolean }) {
  const identity = loadDeviceIdentityIfPresent();
  if (!identity) {
    defaultRuntime.error(
      "no node device identity found (start the node host once with `openclaw node run` or `openclaw node install`)",
    );
    defaultRuntime.exit(1);
    return;
  }
  const payload = {
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
  };
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(payload));
    return;
  }
  defaultRuntime.log(`deviceId:  ${payload.deviceId}`);
  defaultRuntime.log(`publicKey: ${payload.publicKey}`);
}
