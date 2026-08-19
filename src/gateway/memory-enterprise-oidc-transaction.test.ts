import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnterpriseIdentityProviderAuthorityRegistry } from "../plugins/enterprise-identity-provider-authority-registry.js";
import type { EnterpriseIdentityProviderAdapter } from "../plugins/enterprise-identity-provider-types.js";
import { clearEnterpriseOidcJwksCacheForTest } from "../state/memory-enterprise-verifier.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  clearGatewayEnterpriseOidcTransactionsForTest,
  completeGatewayEnterpriseIdentityAuthorizationCallback,
  completeGatewayEnterpriseIdentityAuthorization,
  startGatewayEnterpriseIdentityAuthorization,
} from "./memory-enterprise-oidc-transaction.js";
import type { GatewayClient } from "./server-methods/types.js";

const now = 1_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = pair.publicKey.export({ format: "jwk" });
const roots: string[] = [];

const adapter: EnterpriseIdentityProviderAdapter = {
  providerPrefix: "entra",
  resolveAuthorizationCodeClientSecret: async () => "test-client-secret",
  authorities: [
    {
      issuer: "https://login.example/tenant-a/v2.0",
      tenantId: "tenant-a",
      audiences: ["openclaw-memory"],
      jwksUri: "https://login.example/tenant-a/keys",
      algorithm: "RS256",
      tenantBinding: { kind: "claim", claim: "tid", value: "tenant-a" },
      assurance: { maxAuthenticationAgeMs: 60_000 },
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
        roleGroupIds: ["writers"],
        maxGroups: 200,
      },
      maxSnapshotAgeMs: 60_000,
    },
  ],
};

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-memory-enterprise-oidc-"));
  roots.push(root);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: root } };
}

function client(profileId: string): GatewayClient {
  return {
    authenticatedUserProfile: { profileId },
    connect: { scopes: [] },
  } as unknown as GatewayClient;
}

function registry() {
  const authorityRegistry = createEnterpriseIdentityProviderAuthorityRegistry({
    operatorAllowlist: ["entra"],
  });
  authorityRegistry.seal([
    { pluginId: "memory-identity-entra", provider: adapter, source: "test" },
  ]);
  return authorityRegistry;
}

function addUser(email: string, principalId: string, env: NodeJS.ProcessEnv): string {
  const profile = ensureProfileForEmail(email, { env });
  openOpenClawStateDatabase({ env })
    .db.prepare(
      `INSERT INTO memory_principals
       (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
       VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
    )
    .run(principalId, profile.id, `revision:${principalId}`, now);
  return profile.id;
}

function idToken(nonce: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-a", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://login.example/tenant-a/v2.0",
      aud: "openclaw-memory",
      tid: "tenant-a",
      sub: "enterprise-alice",
      nonce,
      groups: ["writers"],
      auth_time: Math.floor((now - 2_000) / 1_000),
      iat: Math.floor((now - 1_000) / 1_000),
      exp: Math.floor((now + 30_000) / 1_000),
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`;
}

afterEach(() => {
  clearGatewayEnterpriseOidcTransactionsForTest();
  clearEnterpriseOidcJwksCacheForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Gateway enterprise OIDC transaction", () => {
  it("bounds pending browser transactions per profile and globally", async () => {
    const authorityRegistry = registry();
    for (let index = 0; index < 16; index += 1) {
      await expect(
        startGatewayEnterpriseIdentityAuthorization({
          client: client("profile:one"),
          providerPrefix: "entra",
          authorityRegistry,
          now,
        }),
      ).resolves.toMatchObject({ authorizationUrl: expect.any(String) });
    }
    await expect(
      startGatewayEnterpriseIdentityAuthorization({
        client: client("profile:one"),
        providerPrefix: "entra",
        authorityRegistry,
        now,
      }),
    ).rejects.toThrow("too many pending requests");

    clearGatewayEnterpriseOidcTransactionsForTest();
    for (let index = 0; index < 256; index += 1) {
      await startGatewayEnterpriseIdentityAuthorization({
        client: client(`profile:${index}`),
        providerPrefix: "entra",
        authorityRegistry,
        now,
      });
    }
    await expect(
      startGatewayEnterpriseIdentityAuthorization({
        client: client("profile:overflow"),
        providerPrefix: "entra",
        authorityRegistry,
        now,
      }),
    ).rejects.toThrow("temporarily busy");
  });

  it("binds code, nonce, and resulting link to the initiating Gateway profile exactly once", async () => {
    const { env } = fixture();
    const aliceProfileId = addUser("alice@example.com", "principal:alice", env);
    const authorityRegistry = registry();
    const start = await startGatewayEnterpriseIdentityAuthorization({
      client: client(aliceProfileId),
      providerPrefix: "entra",
      authorityRegistry,
      now,
    });
    const nonce = new URL(start.authorizationUrl).searchParams.get("nonce");
    expect(nonce).toBeTruthy();
    expect(start.authorizationUrl).toContain("code_challenge_method=S256");
    expect(new URL(start.authorizationUrl).searchParams.get("max_age")).toBe("60");
    const fetch = vi.fn(async (input: URL | string, _init?: RequestInit) => {
      if (String(input) === "https://login.example/tenant-a/token") {
        return { ok: true, json: async () => ({ id_token: idToken(nonce!) }) };
      }
      return {
        ok: true,
        json: async () => ({ keys: [{ ...publicJwk, kid: "key-a", use: "sig" }] }),
      };
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      completeGatewayEnterpriseIdentityAuthorization({
        client: client(aliceProfileId),
        providerPrefix: "entra",
        state: start.state,
        code: "authorization-code",
        authorityRegistry,
        options: { env },
        now,
      }),
    ).resolves.toMatchObject({ kind: "linked", providerId: "entra" });
    const tokenCall = fetch.mock.calls.find(
      ([input]) => String(input) === "https://login.example/tenant-a/token",
    );
    expect(tokenCall?.[1]).toMatchObject({
      headers: {
        authorization: "Basic b3BlbmNsYXctbWVtb3J5OnRlc3QtY2xpZW50LXNlY3JldA==",
      },
    });
    expect(
      new URLSearchParams(String((tokenCall?.[1] as RequestInit | undefined)?.body)).has(
        "client_id",
      ),
    ).toBe(false);
    await expect(
      completeGatewayEnterpriseIdentityAuthorization({
        client: client(aliceProfileId),
        providerPrefix: "entra",
        state: start.state,
        code: "authorization-code",
        authorityRegistry,
        options: { env },
        now,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "transaction-invalid" });
  });

  it("rejects a receipt replayed by a different Gateway profile before token exchange", async () => {
    const { env } = fixture();
    const aliceProfileId = addUser("alice@example.com", "principal:alice", env);
    const bobProfileId = addUser("bob@example.com", "principal:bob", env);
    const authorityRegistry = registry();
    const start = await startGatewayEnterpriseIdentityAuthorization({
      client: client(aliceProfileId),
      providerPrefix: "entra",
      authorityRegistry,
      now,
    });
    await expect(
      completeGatewayEnterpriseIdentityAuthorization({
        client: client(bobProfileId),
        providerPrefix: "entra",
        state: start.state,
        code: "authorization-code",
        authorityRegistry,
        now,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "transaction-invalid" });
  });

  it("expires a receipt before code exchange and does not contact the provider", async () => {
    const authorityRegistry = registry();
    const start = await startGatewayEnterpriseIdentityAuthorization({
      client: client("profile:expired"),
      providerPrefix: "entra",
      authorityRegistry,
      now,
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      completeGatewayEnterpriseIdentityAuthorization({
        client: client("profile:expired"),
        providerPrefix: "entra",
        state: start.state,
        code: "authorization-code",
        authorityRegistry,
        now: now + 5 * 60_000 + 1,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "transaction-invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to start a confidential callback when its client secret is unavailable", async () => {
    const authorityRegistry = createEnterpriseIdentityProviderAuthorityRegistry({
      operatorAllowlist: ["entra"],
    });
    authorityRegistry.seal([
      {
        pluginId: "memory-identity-entra",
        provider: { ...adapter, resolveAuthorizationCodeClientSecret: async () => undefined },
        source: "test",
      },
    ]);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      startGatewayEnterpriseIdentityAuthorization({
        client: client("profile:missing-secret"),
        providerPrefix: "entra",
        authorityRegistry,
        now,
      }),
    ).rejects.toThrow("client authentication is unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("completes a browser redirect from its receipt without caller-selected profile or provider", async () => {
    const { env } = fixture();
    const aliceProfileId = addUser("alice@example.com", "principal:alice", env);
    const authorityRegistry = registry();
    const start = await startGatewayEnterpriseIdentityAuthorization({
      client: client(aliceProfileId),
      providerPrefix: "entra",
      authorityRegistry,
      now,
    });
    const nonce = new URL(start.authorizationUrl).searchParams.get("nonce");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        if (String(input) === "https://login.example/tenant-a/token") {
          return { ok: true, json: async () => ({ id_token: idToken(nonce!) }) };
        }
        return {
          ok: true,
          json: async () => ({ keys: [{ ...publicJwk, kid: "key-a", use: "sig" }] }),
        };
      }),
    );

    await expect(
      completeGatewayEnterpriseIdentityAuthorizationCallback({
        state: start.state,
        code: "authorization-code",
        authorityRegistry,
        options: { env },
        now,
      }),
    ).resolves.toMatchObject({ kind: "linked", providerId: "entra" });
    await expect(
      completeGatewayEnterpriseIdentityAuthorizationCallback({
        state: start.state,
        code: "authorization-code",
        authorityRegistry,
        options: { env },
        now,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "transaction-invalid" });
  });
});
