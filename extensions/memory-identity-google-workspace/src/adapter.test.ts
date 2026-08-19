import { describe, expect, it, vi } from "vitest";
import { createGoogleWorkspaceEnterpriseIdentityProvider } from "./adapter.js";

describe("Google Workspace enterprise identity adapter", () => {
  it("returns only static OIDC policy and an ephemeral-directory-token callback", async () => {
    const adapter = createGoogleWorkspaceEnterpriseIdentityProvider({
      hostedDomain: "example.com",
      clientId: "client-id",
      clientSecret: "test-client-secret",
      redirectUri: "https://gateway.example/memory/oidc/callback",
      delegatedAdminEmail: "admin@example.com",
      roleGroupResourceNames: ["groups/writers"],
    });
    await expect(adapter.resolveAuthorizationCodeClientSecret?.()).resolves.toBe(
      "test-client-secret",
    );
    const authority = adapter.authorities[0]!;

    expect(authority).toMatchObject({
      issuer: "https://accounts.google.com",
      requiredClaims: [
        { claim: "email_verified", value: true },
        { claim: "hd", value: "example.com" },
      ],
      membership: {
        kind: "google-workspace-directory",
        roleGroupResourceNames: ["groups/writers"],
      },
    });
    await expect(adapter.acquireDirectoryAccessToken?.()).resolves.toEqual({
      kind: "unavailable",
      reason: "directory credentials are unavailable",
    });
  });

  it("rejects ambiguous tenant and group configuration before the directory token is acquired", () => {
    expect(() =>
      createGoogleWorkspaceEnterpriseIdentityProvider({
        hostedDomain: "not a domain",
        clientId: "client-id",
        clientSecret: "test-client-secret",
        delegatedAdminEmail: "admin@example.com",
        roleGroupResourceNames: ["groups/writers"],
      }),
    ).toThrow("hostedDomain");
    expect(() =>
      createGoogleWorkspaceEnterpriseIdentityProvider({
        hostedDomain: "example.com",
        clientId: "client-id",
        clientSecret: "test-client-secret",
        delegatedAdminEmail: "admin@other.example",
        roleGroupResourceNames: ["writers"],
      }),
    ).toThrow("delegatedAdminEmail");
  });

  it("defers a configured SecretRef to the Gateway-owned resolver", async () => {
    const resolveDirectoryServiceAccount = vi.fn(async () => undefined);
    const adapter = createGoogleWorkspaceEnterpriseIdentityProvider(
      {
        hostedDomain: "example.com",
        clientId: "client-id",
        clientSecret: { source: "env", provider: "default", id: "GOOGLE_CLIENT_SECRET" },
        redirectUri: "https://gateway.example/memory/oidc/callback",
        delegatedAdminEmail: "admin@example.com",
        directoryServiceAccount: { source: "env", provider: "default", id: "GOOGLE_DWD_JSON" },
        roleGroupResourceNames: ["groups/writers"],
      },
      {
        resolveDirectoryServiceAccount,
        resolveClientSecret: vi.fn(async () => "test-client-secret"),
      },
    );

    await expect(adapter.acquireDirectoryAccessToken?.()).resolves.toEqual({
      kind: "unavailable",
      reason: "directory credentials are unavailable",
    });
    expect(resolveDirectoryServiceAccount).toHaveBeenCalledWith({
      source: "env",
      provider: "default",
      id: "GOOGLE_DWD_JSON",
    });
    await expect(adapter.resolveAuthorizationCodeClientSecret?.()).resolves.toBe(
      "test-client-secret",
    );
  });
});
