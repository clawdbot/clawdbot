import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnterpriseIdentityProviderAdapter } from "../plugins/enterprise-identity-provider-types.js";
import {
  clearEnterpriseOidcJwksCacheForTest,
  verifyEnterpriseOidcIdentity,
} from "./memory-enterprise-verifier.js";

const now = 1_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = pair.publicKey.export({ format: "jwk" });
const adapter: EnterpriseIdentityProviderAdapter = {
  providerPrefix: "entra",
  authorities: [
    {
      issuer: "https://login.example/tenant-a/v2.0",
      tenantId: "tenant-a",
      audiences: ["openclaw-memory"],
      jwksUri: "https://login.example/tenant-a/keys",
      algorithm: "RS256",
      tenantBinding: { kind: "claim", claim: "tid", value: "tenant-a" },
      assurance: { maxAuthenticationAgeMs: 60_000, requiredAmrValues: ["mfa"] },
      authorizationCodeFlow: {
        clientId: "openclaw-memory",
        authorizationEndpoint: "https://login.example/tenant-a/authorize",
        tokenEndpoint: "https://login.example/tenant-a/token",
        redirectUri: "https://gateway.example/memory/oidc/callback",
        scopes: ["openid"],
      },
      membership: {
        kind: "oidc-claim",
        claim: "groups",
        required: true,
        roleGroupIds: ["writers", "admins"],
        maxGroups: 200,
        incompleteIndicators: [
          { kind: "truthy-claim", claim: "hasgroups" },
          { kind: "nested-key", claim: "_claim_names", key: "groups" },
        ],
      },
      maxSnapshotAgeMs: 60_000,
    },
  ],
};

const workspaceAdapter: EnterpriseIdentityProviderAdapter = {
  providerPrefix: "google-workspace",
  authorities: [
    {
      issuer: "https://accounts.google.com",
      tenantId: "example.com",
      audiences: ["workspace-memory-client"],
      jwksUri: "https://accounts.google.com/keys",
      algorithm: "RS256",
      tenantBinding: { kind: "issuer", tenantId: "example.com" },
      assurance: { maxAuthenticationAgeMs: 60_000 },
      authorizationCodeFlow: {
        clientId: "workspace-memory-client",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        redirectUri: "https://gateway.example/memory/oidc/callback",
        scopes: ["openid", "email"],
      },
      requiredClaims: [
        { claim: "email_verified", value: true },
        { claim: "hd", value: "example.com" },
      ],
      membership: {
        kind: "google-workspace-directory",
        verifiedEmailClaim: "email",
        roleGroupResourceNames: ["groups/role-writers"],
        maxGroups: 100,
      },
      maxSnapshotAgeMs: 60_000,
    },
  ],
  acquireDirectoryAccessToken: async () => ({
    kind: "available",
    accessToken: "test-only-access-token",
  }),
};

function token(claims: Record<string, unknown>, key = pair.privateKey, keyId = "key-a"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: adapter.authorities[0]!.issuer,
      aud: "openclaw-memory",
      tid: "tenant-a",
      sub: "alice-upstream",
      groups: ["writers", "admins"],
      nonce: "entra-nonce",
      auth_time: Math.floor((now - 2_000) / 1_000),
      amr: ["pwd", "mfa"],
      iat: Math.floor((now - 1_000) / 1_000),
      exp: Math.floor((now + 30_000) / 1_000),
      ...claims,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}

function verifyToken(value: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ keys: [{ ...publicJwk, kid: "key-a", use: "sig" }] }),
    })),
  );
  return verifyEnterpriseOidcIdentity({
    adapter,
    token: value,
    expectedNonce: "entra-nonce",
    now,
  });
}

function workspaceToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-a", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: "workspace-memory-client",
      sub: "google-subject",
      email: "alice@example.com",
      email_verified: true,
      hd: "example.com",
      nonce: "workspace-nonce",
      auth_time: Math.floor((now - 2_000) / 1_000),
      iat: Math.floor((now - 1_000) / 1_000),
      exp: Math.floor((now + 30_000) / 1_000),
      ...claims,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`;
}

afterEach(() => {
  clearEnterpriseOidcJwksCacheForTest();
  vi.unstubAllGlobals();
});

describe("enterprise OIDC identity verification", () => {
  it("constructs facts only after core validates the signed issuer, audience, tenant, expiry, and freshness", async () => {
    await expect(verifyToken(token({}))).resolves.toMatchObject({
      kind: "verified",
      identity: {
        providerId: "entra",
        subject: "alice-upstream",
        groups: ["admins", "writers"],
        expiresAt: now + 30_000,
      },
    });
  });

  it.each([
    ["wrong-issuer", { iss: "https://attacker.example/tenant-a" }, "wrong-issuer"],
    ["wrong-audience", { aud: "somewhere-else" }, "wrong-audience"],
    ["wrong-tenant", { tid: "tenant-b" }, "wrong-tenant"],
    ["expired", { exp: Math.floor((now - 1) / 1_000) }, "expired"],
    ["stale", { iat: Math.floor((now - 61_000) / 1_000) }, "stale-snapshot"],
  ])("denies %s claims", async (_name, claims, reason) => {
    await expect(verifyToken(token(claims))).resolves.toEqual({ kind: "denied", reason });
  });

  it("rejects a multi-audience token whose authorized party is not the configured client", async () => {
    await expect(
      verifyToken(
        token({
          aud: ["openclaw-memory", "another-client"],
          azp: "another-client",
        }),
      ),
    ).resolves.toEqual({ kind: "denied", reason: "wrong-audience" });
  });

  it("rejects malformed mixed-type audience arrays before authorized-party validation", async () => {
    await expect(
      verifyToken(
        token({
          aud: ["openclaw-memory", 7],
        }),
      ),
    ).resolves.toEqual({ kind: "denied", reason: "wrong-audience" });
  });

  it("denies a valid-looking token whose signature was not made by the registered key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(verifyToken(token({}, other.privateKey))).resolves.toEqual({
      kind: "denied",
      reason: "invalid-signature",
    });
  });

  it("fails closed when the registered provider cannot supply its signing keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await expect(
      verifyEnterpriseOidcIdentity({
        adapter,
        token: token({}),
        expectedNonce: "entra-nonce",
        now,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "provider-unavailable" });
  });

  it("refreshes cached signing keys once when an issuer rotates to a new key id", async () => {
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotatedJwk = rotated.publicKey.export({ format: "jwk" });
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ keys: [{ ...publicJwk, kid: "key-a", use: "sig" }] }),
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      verifyEnterpriseOidcIdentity({
        adapter,
        token: token({}),
        expectedNonce: "entra-nonce",
        now,
      }),
    ).resolves.toMatchObject({ kind: "verified" });

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [
          { ...publicJwk, kid: "key-a", use: "sig" },
          { ...rotatedJwk, kid: "key-b", use: "sig" },
        ],
      }),
    });
    await expect(
      verifyEnterpriseOidcIdentity({
        adapter,
        token: token({}, rotated.privateKey, "key-b"),
        expectedNonce: "entra-nonce",
        now,
      }),
    ).resolves.toMatchObject({ kind: "verified" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires the exact one-time Gateway nonce when a transaction binds the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ keys: [{ ...publicJwk, kid: "key-a", use: "sig" }] }),
      })),
    );
    await expect(
      verifyEnterpriseOidcIdentity({
        adapter,
        token: token({ nonce: "issued-nonce" }),
        expectedNonce: "other-nonce",
        now,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "wrong-nonce" });
    // TypeScript callers cannot omit expectedNonce; this guards the JavaScript
    // boundary too, so a future direct-token path cannot silently reopen it.
    await expect(
      verifyEnterpriseOidcIdentity({ adapter, token: token({}), now } as never),
    ).resolves.toEqual({ kind: "denied", reason: "wrong-nonce" });
  });

  it.each([
    ["missing groups", { groups: undefined }, "incomplete-membership-snapshot"],
    ["Entra overage flag", { hasgroups: true }, "incomplete-membership-snapshot"],
    [
      "Entra distributed groups",
      { _claim_names: { groups: "src1" } },
      "incomplete-membership-snapshot",
    ],
    ["non-array groups", { groups: "src1" }, "incomplete-membership-snapshot"],
    ["missing authentication time", { auth_time: undefined }, "wrong-assurance"],
    ["stale authentication", { auth_time: Math.floor((now - 61_000) / 1_000) }, "wrong-assurance"],
    ["wrong authentication method", { amr: ["pwd"] }, "wrong-assurance"],
  ])(
    "denies %s rather than admitting an incomplete or weak snapshot",
    async (_name, claims, reason) => {
      await expect(verifyToken(token(claims))).resolves.toEqual({ kind: "denied", reason });
    },
  );

  it("uses a core-owned Cloud Identity request for Workspace membership and retains only configured group ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        if (String(input) === "https://accounts.google.com/keys") {
          return {
            ok: true,
            json: async () => ({ keys: [{ ...publicJwk, kid: "key-a", use: "sig" }] }),
          };
        }
        expect(String(input)).toContain(
          "https://cloudidentity.googleapis.com/v1/groups/-/memberships:searchTransitiveGroups",
        );
        return {
          ok: true,
          json: async () => ({
            memberships: [{ group: "groups/role-writers" }, { group: "groups/unconfigured" }],
          }),
        };
      }),
    );

    await expect(
      verifyEnterpriseOidcIdentity({
        adapter: workspaceAdapter,
        token: workspaceToken({}),
        expectedNonce: "workspace-nonce",
        now,
      }),
    ).resolves.toMatchObject({
      kind: "verified",
      identity: {
        providerId: "google-workspace",
        subject: "google-subject",
        groups: ["groups/role-writers"],
      },
    });
  });

  it("scopes a configured Workspace directory lookup to its canonical customer", async () => {
    const workspaceAuthority = workspaceAdapter.authorities[0]!;
    if (workspaceAuthority.membership.kind !== "google-workspace-directory") {
      throw new Error("workspace test fixture must use a directory membership authority");
    }
    const customerScopedAdapter: EnterpriseIdentityProviderAdapter = {
      ...workspaceAdapter,
      authorities: [
        {
          ...workspaceAuthority,
          membership: {
            ...workspaceAuthority.membership,
            customerId: "C012345",
          },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        if (String(input) === "https://accounts.google.com/keys") {
          return {
            ok: true,
            json: async () => ({ keys: [{ ...publicJwk, kid: "key-a", use: "sig" }] }),
          };
        }
        const url = new URL(String(input));
        expect(url.searchParams.get("query")).toContain("parent == 'customers/C012345'");
        return { ok: true, json: async () => ({ memberships: [] }) };
      }),
    );

    await expect(
      verifyEnterpriseOidcIdentity({
        adapter: customerScopedAdapter,
        token: workspaceToken({}),
        expectedNonce: "workspace-nonce",
        now,
      }),
    ).resolves.toMatchObject({ kind: "verified", identity: { groups: [] } });
  });

  it.each([
    ["unverified email", { email_verified: false }, "missing-required-claim"],
    ["wrong Workspace domain", { hd: "attacker.example" }, "missing-required-claim"],
    ["missing verified email", { email: undefined }, "incomplete-membership-snapshot"],
  ])(
    "denies Workspace %s before directory membership can be admitted",
    async (_name, claims, reason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ keys: [{ ...publicJwk, kid: "key-a", use: "sig" }] }),
        })),
      );
      await expect(
        verifyEnterpriseOidcIdentity({
          adapter: workspaceAdapter,
          token: workspaceToken(claims),
          expectedNonce: "workspace-nonce",
          now,
        }),
      ).resolves.toEqual({ kind: "denied", reason });
    },
  );
});
