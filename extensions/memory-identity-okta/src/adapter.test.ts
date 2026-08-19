import { describe, expect, it } from "vitest";
import { createOktaEnterpriseIdentityProvider } from "./adapter.js";

describe("Okta enterprise identity adapter", () => {
  it("uses the exact custom authorization-server issuer as the tenant boundary", async () => {
    const adapter = createOktaEnterpriseIdentityProvider({
      issuer: "https://example.okta.com/oauth2/memory",
      clientId: "client-id",
      clientSecret: "test-client-secret",
      redirectUri: "https://gateway.example/memory/oidc/callback",
      groupIdsClaim: "openclaw_group_ids",
      roleGroupIds: ["00g00000000000000001"],
    });
    await expect(adapter.resolveAuthorizationCodeClientSecret?.()).resolves.toBe(
      "test-client-secret",
    );
    const authority = adapter.authorities[0]!;

    expect(authority).toMatchObject({
      issuer: "https://example.okta.com/oauth2/memory",
      jwksUri: "https://example.okta.com/oauth2/memory/v1/keys",
      tenantBinding: { kind: "issuer", tenantId: "https://example.okta.com/oauth2/memory" },
      membership: { claim: "openclaw_group_ids", roleGroupIds: ["00g00000000000000001"] },
    });
  });

  it("rejects an org authorization server and mutable group labels", () => {
    expect(() =>
      createOktaEnterpriseIdentityProvider({
        issuer: "https://example.okta.com",
        clientId: "client-id",
        clientSecret: "test-client-secret",
        groupIdsClaim: "openclaw_group_ids",
        roleGroupIds: ["00g00000000000000001"],
      }),
    ).toThrow("custom authorization-server issuer");
    expect(() =>
      createOktaEnterpriseIdentityProvider({
        issuer: "https://example.okta.com/oauth2/memory",
        clientId: "client-id",
        clientSecret: "test-client-secret",
        groupIdsClaim: "groups",
        roleGroupIds: ["memory-writers"],
      }),
    ).toThrow("immutable Okta group IDs");
  });
});
