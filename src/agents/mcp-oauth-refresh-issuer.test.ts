import path from "node:path";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { withTempHome as withBaseTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import { readMcpOAuthStore } from "./mcp-oauth-store.js";

const SERVER_NAME = "Remote Docs";
const SERVER_URL = "https://mcp.example.com/mcp";
const ORIGINAL_METADATA_URL = "https://mcp.example.com/.well-known/oauth-protected-resource";
const REPLACEMENT_METADATA_URL = "https://metadata.example/pr-metadata";
const ORIGINAL_ISSUER = "https://auth-old.example";
const REPLACEMENT_ISSUER = "https://auth-new.example";
const STORED_ACCESS = "stored-access";
const STORED_REFRESH = "stored-refresh-secret";
const IDENTITY = operatorMcpOAuthIdentity(SERVER_NAME, SERVER_URL);

async function withTempHome<T>(
  run: () => T | Promise<T>,
  options: Parameters<typeof withBaseTempHome>[1],
): Promise<T> {
  return withBaseTempHome(async (home) => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
    closeOpenClawStateDatabaseForTest();
    try {
      return await run();
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  }, options);
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") {
    return body;
  }
  return body instanceof URLSearchParams ? body.toString() : "";
}

function createOAuthNetwork(config: {
  challengeMetadataUrl: string;
  issuer: string;
  mintedAccessToken: string;
}) {
  const tokenRequests: Array<{ url: string; body: string }> = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === SERVER_URL) {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${config.mintedAccessToken}`) {
        return Response.json({ ok: true });
      }
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${config.challengeMetadataUrl}"`,
        },
      });
    }
    if (url.href === new URL(config.challengeMetadataUrl).href) {
      return Response.json({
        resource: SERVER_URL,
        authorization_servers: [config.issuer],
      });
    }
    if (url.href === `${config.issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: config.issuer,
        authorization_endpoint: `${config.issuer}/authorize`,
        token_endpoint: `${config.issuer}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
    if (url.href === `${config.issuer}/token`) {
      tokenRequests.push({ url: url.href, body: bodyText(init?.body) });
      return Response.json({
        access_token: config.mintedAccessToken,
        refresh_token: "rotated-refresh-secret",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return new Response(null, { status: 404 });
  };
  return { fetchFn, tokenRequests };
}

async function seedAuthorizedStore(
  order: "discovery-then-tokens" | "tokens-then-discovery",
  expiresIn = 3600,
) {
  const provider = createMcpOAuthClientProvider({
    identity: IDENTITY,
  });
  const discoveryState = {
    authorizationServerUrl: ORIGINAL_ISSUER,
    resourceMetadataUrl: ORIGINAL_METADATA_URL,
  };
  const tokens = {
    access_token: STORED_ACCESS,
    refresh_token: STORED_REFRESH,
    token_type: "Bearer",
    expires_in: expiresIn,
  };
  await provider.saveClientInformation?.({ client_id: "stored-client-id" });
  if (order === "discovery-then-tokens") {
    await provider.saveDiscoveryState?.(discoveryState);
    await provider.saveTokens(tokens);
  } else {
    await provider.saveTokens(tokens);
    await provider.saveDiscoveryState?.(discoveryState);
  }
}

function buildOAuthFetch(fetchFn: FetchLike) {
  return withMcpOAuthBearer({
    fetchFn,
    authFetchFn: fetchFn,
    identity: IDENTITY,
  });
}

function readStore() {
  return readMcpOAuthStore(IDENTITY.storeKey);
}

const TEMP_HOME_OPTIONS = {
  skipSessionCleanup: true,
  env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
};

describe("MCP OAuth refresh issuer binding", () => {
  beforeEach(() => closeOpenClawStateDatabaseForTest());
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("does not send the stored refresh token to a different issuer from a challenge", async () => {
    await withTempHome(
      async () => {
        await seedAuthorizedStore("discovery-then-tokens");
        const network = createOAuthNetwork({
          challengeMetadataUrl: REPLACEMENT_METADATA_URL,
          issuer: REPLACEMENT_ISSUER,
          mintedAccessToken: "attacker-access",
        });

        await expect(
          buildOAuthFetch(network.fetchFn)(SERVER_URL, { method: "POST", body: "{}" }),
        ).rejects.toThrow(/requires OAuth authorization/);

        expect(network.tokenRequests).toEqual([]);
        expect(readStore().tokens).toMatchObject({
          access_token: STORED_ACCESS,
          refresh_token: STORED_REFRESH,
        });
      },
      { prefix: "openclaw-mcp-oauth-issuer-switch-", ...TEMP_HOME_OPTIONS },
    );
  });

  it("still refreshes when a new metadata URL resolves to the original issuer", async () => {
    await withTempHome(
      async () => {
        await seedAuthorizedStore("discovery-then-tokens");
        const network = createOAuthNetwork({
          challengeMetadataUrl: REPLACEMENT_METADATA_URL,
          issuer: ORIGINAL_ISSUER,
          mintedAccessToken: "rotated-access",
        });

        const response = await buildOAuthFetch(network.fetchFn)(SERVER_URL, {
          method: "POST",
          body: "{}",
        });

        expect(response.status).toBe(200);
        expect(network.tokenRequests).toHaveLength(1);
        expect(network.tokenRequests[0]?.url).toBe(`${ORIGINAL_ISSUER}/token`);
        expect(network.tokenRequests[0]?.body).toContain(`refresh_token=${STORED_REFRESH}`);
        expect(readStore().tokens?.access_token).toBe("rotated-access");
      },
      { prefix: "openclaw-mcp-oauth-issuer-same-", ...TEMP_HOME_OPTIONS },
    );
  });

  it.each([
    {
      variant: "an explicit default port",
      issuer: "https://auth-old.example:443",
    },
    {
      variant: "different host casing",
      issuer: "https://AUTH-OLD.example",
    },
    {
      variant: "a trailing slash",
      issuer: "https://auth-old.example/",
    },
  ])(
    "does not disclose a refresh token when the issuer differs by $variant",
    async ({ issuer }) => {
      await withTempHome(
        async () => {
          await seedAuthorizedStore("discovery-then-tokens");
          const provider = createMcpOAuthClientProvider({
            identity: IDENTITY,
          });
          await provider.saveDiscoveryState?.({
            authorizationServerUrl: issuer,
            resourceMetadataUrl: REPLACEMENT_METADATA_URL,
          });

          expect(provider.tokens()).toBeUndefined();
          expect(readStore().tokens).toMatchObject({
            access_token: STORED_ACCESS,
            refresh_token: STORED_REFRESH,
          });
        },
        { prefix: "openclaw-mcp-oauth-issuer-normalization-", ...TEMP_HOME_OPTIONS },
      );
    },
  );

  it("refreshes an upgraded row whose issuer is recoverable from stored discovery", async () => {
    await withTempHome(
      async () => {
        await seedAuthorizedStore("tokens-then-discovery", 0);
        expect(readStore().tokensAuthorizationServerUrl).toBeUndefined();
        expect(readStore().discoveryState?.authorizationServerUrl).toBe(ORIGINAL_ISSUER);
        const network = createOAuthNetwork({
          challengeMetadataUrl: ORIGINAL_METADATA_URL,
          issuer: ORIGINAL_ISSUER,
          mintedAccessToken: "rotated-access",
        });

        const response = await buildOAuthFetch(network.fetchFn)(SERVER_URL, {
          method: "POST",
          body: "{}",
        });

        expect(response.status).toBe(200);
        expect(network.tokenRequests).toHaveLength(1);
        expect(network.tokenRequests[0]?.url).toBe(`${ORIGINAL_ISSUER}/token`);
        expect(network.tokenRequests[0]?.body).toContain(`refresh_token=${STORED_REFRESH}`);
        expect(readStore().tokensAuthorizationServerUrl).toBe(ORIGINAL_ISSUER);
      },
      { prefix: "openclaw-mcp-oauth-issuer-upgrade-", ...TEMP_HOME_OPTIONS },
    );
  });

  it("blocks an issuer-changing challenge on an upgraded row after it refreshed", async () => {
    await withTempHome(
      async () => {
        await seedAuthorizedStore("tokens-then-discovery", 0);
        const sameIssuer = createOAuthNetwork({
          challengeMetadataUrl: ORIGINAL_METADATA_URL,
          issuer: ORIGINAL_ISSUER,
          mintedAccessToken: "rotated-access",
        });
        await buildOAuthFetch(sameIssuer.fetchFn)(SERVER_URL, { method: "POST", body: "{}" });

        const newIssuer = createOAuthNetwork({
          challengeMetadataUrl: REPLACEMENT_METADATA_URL,
          issuer: REPLACEMENT_ISSUER,
          mintedAccessToken: "attacker-access",
        });
        await expect(
          buildOAuthFetch(newIssuer.fetchFn)(SERVER_URL, { method: "POST", body: "{}" }),
        ).rejects.toThrow(/requires OAuth authorization/);

        expect(newIssuer.tokenRequests).toEqual([]);
        expect(readStore().tokensAuthorizationServerUrl).toBe(ORIGINAL_ISSUER);
      },
      { prefix: "openclaw-mcp-oauth-issuer-upgrade-challenge-", ...TEMP_HOME_OPTIONS },
    );
  });

  it("binds legacy stored tokens to the pre-challenge issuer before rediscovery", async () => {
    await withTempHome(
      async () => {
        await seedAuthorizedStore("tokens-then-discovery");
        expect(readStore().tokensAuthorizationServerUrl).toBeUndefined();
        const network = createOAuthNetwork({
          challengeMetadataUrl: REPLACEMENT_METADATA_URL,
          issuer: REPLACEMENT_ISSUER,
          mintedAccessToken: "attacker-access",
        });

        await expect(
          buildOAuthFetch(network.fetchFn)(SERVER_URL, { method: "POST", body: "{}" }),
        ).rejects.toThrow(/requires OAuth authorization/);

        expect(network.tokenRequests).toEqual([]);
        expect(readStore().tokensAuthorizationServerUrl).toBe(ORIGINAL_ISSUER);
        expect(readStore().tokens).toMatchObject({
          access_token: STORED_ACCESS,
          refresh_token: STORED_REFRESH,
        });
      },
      { prefix: "openclaw-mcp-oauth-issuer-legacy-", ...TEMP_HOME_OPTIONS },
    );
  });

  it("fails closed for a token-only legacy store with no recoverable issuer", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          identity: IDENTITY,
        });
        await provider.saveClientInformation?.({ client_id: "stored-client-id" });
        await provider.saveTokens({
          access_token: STORED_ACCESS,
          refresh_token: STORED_REFRESH,
          token_type: "Bearer",
          expires_in: 3600,
        });
        expect(readStore().discoveryState).toBeUndefined();
        expect(readStore().tokensAuthorizationServerUrl).toBeUndefined();
        const network = createOAuthNetwork({
          challengeMetadataUrl: REPLACEMENT_METADATA_URL,
          issuer: REPLACEMENT_ISSUER,
          mintedAccessToken: "attacker-access",
        });

        await expect(
          buildOAuthFetch(network.fetchFn)(SERVER_URL, { method: "POST", body: "{}" }),
        ).rejects.toThrow(/OAuth authorization/);

        expect(network.tokenRequests).toEqual([]);
        expect(readStore().tokens).toMatchObject({ refresh_token: STORED_REFRESH });
      },
      { prefix: "openclaw-mcp-oauth-issuer-tokenonly-", ...TEMP_HOME_OPTIONS },
    );
  });

  it("persists bound issuer provenance across a store reload", async () => {
    await withTempHome(
      async () => {
        await seedAuthorizedStore("tokens-then-discovery");
        const network = createOAuthNetwork({
          challengeMetadataUrl: REPLACEMENT_METADATA_URL,
          issuer: REPLACEMENT_ISSUER,
          mintedAccessToken: "attacker-access",
        });

        await expect(
          buildOAuthFetch(network.fetchFn)(SERVER_URL, { method: "POST", body: "{}" }),
        ).rejects.toThrow(/OAuth authorization/);

        closeOpenClawStateDatabaseForTest();
        expect(readStore().tokensAuthorizationServerUrl).toBe(ORIGINAL_ISSUER);
      },
      { prefix: "openclaw-mcp-oauth-issuer-reload-", ...TEMP_HOME_OPTIONS },
    );
  });
});
