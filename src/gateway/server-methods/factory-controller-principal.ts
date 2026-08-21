import { createHash } from "node:crypto";
import { safeEqualSecret } from "../../security/secret-equal.js";
import type { GatewayClient } from "./shared-types.js";

export const FACTORY_CONTROLLER_CREDENTIAL_HASH_ENV =
  "OPENCLAW_FACTORY_CONTROLLER_CREDENTIAL_SHA256" as const;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function hashFactoryControllerCredential(credential: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(credential, "utf8").digest("hex")}`;
}

/**
 * Authorizes the dedicated local factory principal. Gateway bearer/device/user
 * authentication remains necessary at the router, but is deliberately not
 * sufficient for factory RPC authority.
 */
export function isAuthorizedFactoryControllerPrincipal(params: {
  client: GatewayClient | undefined;
  credential: string;
  expectedCredentialHash?: string;
}): boolean {
  const gatewayAuthenticated =
    params.client?.usesSharedGatewayAuth === true ||
    params.client?.isDeviceTokenAuth === true ||
    Boolean(params.client?.authenticatedUserId);
  if (!gatewayAuthenticated || params.credential.length < 32) {
    return false;
  }
  const expected =
    params.expectedCredentialHash ?? process.env[FACTORY_CONTROLLER_CREDENTIAL_HASH_ENV];
  if (!expected || !SHA256_PATTERN.test(expected)) {
    return false;
  }
  return safeEqualSecret(hashFactoryControllerCredential(params.credential), expected);
}
