import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FACTORY_CONTROLLER_CREDENTIAL_HASH_ENV,
  isAuthorizedFactoryControllerPrincipal,
} from "./factory-controller-principal.js";
import type { GatewayClient } from "./shared-types.js";

const CREDENTIAL = "factory-controller-test-credential-000001";
const CREDENTIAL_HASH = `sha256:${createHash("sha256").update(CREDENTIAL).digest("hex")}`;
const AUTHENTICATED_CLIENT = {
  transportRemoteIp: "127.0.0.1",
  usesSharedGatewayAuth: true,
} as GatewayClient;

describe("factory controller principal", () => {
  it("requires both Gateway authentication and the exact dedicated credential", () => {
    expect(
      isAuthorizedFactoryControllerPrincipal({
        client: AUTHENTICATED_CLIENT,
        credential: CREDENTIAL,
        expectedCredentialHash: CREDENTIAL_HASH,
      }),
    ).toBe(true);
    expect(
      isAuthorizedFactoryControllerPrincipal({
        client: AUTHENTICATED_CLIENT,
        credential: "forged-factory-controller-credential-0001",
        expectedCredentialHash: CREDENTIAL_HASH,
      }),
    ).toBe(false);
    expect(
      isAuthorizedFactoryControllerPrincipal({
        client: { transportRemoteIp: "127.0.0.1" } as GatewayClient,
        credential: CREDENTIAL,
        expectedCredentialHash: CREDENTIAL_HASH,
      }),
    ).toBe(false);
  });

  it("fails closed when the configured digest is absent or malformed", () => {
    expect(
      isAuthorizedFactoryControllerPrincipal({
        client: AUTHENTICATED_CLIENT,
        credential: CREDENTIAL,
        expectedCredentialHash: "",
      }),
    ).toBe(false);
    expect(
      isAuthorizedFactoryControllerPrincipal({
        client: AUTHENTICATED_CLIENT,
        credential: CREDENTIAL,
        expectedCredentialHash: "sha256:not-a-digest",
      }),
    ).toBe(false);
    expect(FACTORY_CONTROLLER_CREDENTIAL_HASH_ENV).toBe(
      "OPENCLAW_FACTORY_CONTROLLER_CREDENTIAL_SHA256",
    );
  });
});
