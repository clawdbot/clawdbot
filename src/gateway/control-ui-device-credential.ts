// Principal-bound Control UI HTTP credential.
//
// A Control UI browser reaching the Gateway through managed Tailscale Serve
// authenticates its websocket with verified tailnet identity plus a device
// keypair proof, but that lane deliberately skips pairing, so `ensureDeviceToken`
// has no paired row to bind and the browser ends up holding no credential for its
// later HTTP reads. This fills exactly that gap: the connect handshake mints one
// after the device proof is verified, and the consolidated Control UI read
// authorizer accepts it where a paired-device token would otherwise be required.
//
// Nothing about it is ambient: a request that never completed the authenticated
// websocket connect cannot produce one, and the credential carries only the read
// scope the Control UI read surfaces need.
// Its reach is the tailnet principal that minted it: issuance records the
// whois-verified login of the connect, redemption re-resolves the presenting
// request's own verified login and refuses anything else. So a copy lifted off
// that browser is useless off the tailnet (no managed-Serve ingress, no verified
// identity) *and* useless to a different tailnet user reaching the same ingress.
// It is not bound to a browser or a TLS session: another client running as the
// same principal through the same managed Serve ingress can still replay it for
// its TTL.
//
// Lifecycle, stated exactly: one is minted per authenticated connect, lives
// `CONTROL_UI_DEVICE_CREDENTIAL_TTL_MS` (12h), and is never refreshed in place.
// There is no refresh frame and no renewal endpoint — the only thing that mints
// a replacement is another authenticated connect, so a browser holding one
// socket open past the deadline would present an expired bearer. Keeping that
// from happening is the Control UI's job: it reads `httpCredentialExpiresAtMs`
// out of hello-ok and reconnects before the deadline
// (`ui/src/app/control-ui-credential-renewal.ts`). A Gateway restart rotates the
// secret below and invalidates every outstanding credential the same way.
import { randomBytes } from "node:crypto";
import { createControlUiSignedToken, readControlUiSignedToken } from "./control-ui-signed-token.js";
import { READ_SCOPE } from "./operator-scopes.js";

const CONTROL_UI_DEVICE_CREDENTIAL_SCOPE = "control-ui-device-http";
const CONTROL_UI_DEVICE_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1000;
// Process-lifetime secret: a Gateway restart invalidates every outstanding
// credential, and the browser reconnects to mint a replacement.
const controlUiDeviceCredentialSecret = randomBytes(32);

function normalizePrincipal(principal: string | null | undefined): string {
  return typeof principal === "string" ? principal.trim() : "";
}

/**
 * Mint the post-connect HTTP credential for a device that proved its keypair,
 * bound to the verified tailnet principal of the connect that requested it.
 * Without such a principal there is nothing to bind, so nothing is minted.
 */
export function issueControlUiDeviceCredential(params: {
  deviceId: string;
  principal: string | null | undefined;
  authGeneration: string | undefined;
  nowMs?: number;
}): { credential: string; expiresAtMs: number } | null {
  const deviceId = params.deviceId.trim();
  const principal = normalizePrincipal(params.principal);
  if (!deviceId || !principal) {
    return null;
  }
  const signed = createControlUiSignedToken({
    secret: controlUiDeviceCredentialSecret,
    scope: CONTROL_UI_DEVICE_CREDENTIAL_SCOPE,
    claims: { deviceId, principal, authGeneration: params.authGeneration ?? null },
    ttlMs: CONTROL_UI_DEVICE_CREDENTIAL_TTL_MS,
    ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
  });
  return signed ? { credential: signed.token, expiresAtMs: signed.expiresAtMs } : null;
}

/** Operator scopes a presented credential authorizes, or null when it is not one. */
export async function verifyControlUiDeviceCredential(params: {
  credential: string | null | undefined;
  authGeneration: string | undefined;
  /**
   * Verified tailnet principal of the request presenting the credential.
   * Resolved only once the signed claims check out, so tokens that are not this
   * kind of credential never pull a whois lookup into the authorizer.
   */
  resolvePresentedPrincipal: () => Promise<string | undefined>;
  nowMs?: number;
}): Promise<string[] | null> {
  const claims = readControlUiSignedToken({
    secret: controlUiDeviceCredentialSecret,
    scope: CONTROL_UI_DEVICE_CREDENTIAL_SCOPE,
    token: params.credential,
    ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
  });
  // An intact device binding is what makes this a credential at all, and rotating
  // the shared gateway secret retires the credentials it was issued under.
  if (!claims || typeof claims.deviceId !== "string" || !claims.deviceId) {
    return null;
  }
  if (claims.authGeneration !== (params.authGeneration ?? null)) {
    return null;
  }
  const boundPrincipal = normalizePrincipal(
    typeof claims.principal === "string" ? claims.principal : null,
  );
  if (!boundPrincipal) {
    return null;
  }
  // Tailnet logins are compared case-insensitively here for the same reason
  // `resolveManagedTailscaleIngress` does it when cross-checking whois.
  const presentedPrincipal = normalizePrincipal(await params.resolvePresentedPrincipal());
  if (!presentedPrincipal || presentedPrincipal.toLowerCase() !== boundPrincipal.toLowerCase()) {
    return null;
  }
  return [READ_SCOPE];
}
