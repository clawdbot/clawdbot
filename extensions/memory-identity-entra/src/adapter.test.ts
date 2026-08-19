import { describe, expect, it } from "vitest";
import { createEntraEnterpriseIdentityProvider } from "./adapter.js";

describe("Entra enterprise identity adapter", () => {
  it("derives the exact tenant-bound authority and fail-closed overage signals", async () => {
    const adapter = createEntraEnterpriseIdentityProvider({
      tenantId: "00000000-0000-0000-0000-000000000010",
      clientId: "00000000-0000-0000-0000-000000000011",
      clientSecret: "test-client-secret",
      redirectUri: "https://gateway.example/memory/oidc/callback",
      roleGroupIds: [
        "00000000-0000-0000-0000-000000000012",
        "00000000-0000-0000-0000-000000000013",
      ],
    });
    await expect(adapter.resolveAuthorizationCodeClientSecret?.()).resolves.toBe(
      "test-client-secret",
    );
    const authority = adapter.authorities[0]!;

    expect(authority).toMatchObject({
      issuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000010/v2.0",
      audiences: ["00000000-0000-0000-0000-000000000011"],
      tenantBinding: {
        kind: "claim",
        claim: "tid",
        value: "00000000-0000-0000-0000-000000000010",
      },
      membership: {
        claim: "groups",
        roleGroupIds: [
          "00000000-0000-0000-0000-000000000012",
          "00000000-0000-0000-0000-000000000013",
        ],
        incompleteIndicators: [
          { kind: "truthy-claim", claim: "hasgroups" },
          { kind: "nested-key", claim: "_claim_names", key: "groups" },
        ],
      },
    });
  });

  it("rejects mutable labels and malformed Entra object IDs before provider registration", () => {
    expect(() =>
      createEntraEnterpriseIdentityProvider({
        tenantId: "tenant-name",
        clientId: "00000000-0000-0000-0000-000000000011",
        clientSecret: "test-client-secret",
        roleGroupIds: ["00000000-0000-0000-0000-000000000012"],
      }),
    ).toThrow("tenantId");
    expect(() =>
      createEntraEnterpriseIdentityProvider({
        tenantId: "00000000-0000-0000-0000-000000000010",
        clientId: "00000000-0000-0000-0000-000000000011",
        clientSecret: "test-client-secret",
        roleGroupIds: ["memory-writers"],
      }),
    ).toThrow("roleGroupIds");
  });
});
