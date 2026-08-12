import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { withTempHome as withBaseTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../config/types.mcp.js";
import { handleMcpOAuthCallback } from "../gateway/mcp-oauth-callback.js";
import { createRequest, createResponse } from "../gateway/server-http.test-harness.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthIdentity,
  type McpOAuthIdentity,
} from "./mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import {
  readMcpOAuthPendingAuthorization as readPending,
  readMcpOAuthStore,
} from "./mcp-oauth-store.js";
import {
  cancelMcpOAuthAuthorization,
  completeMcpOAuthAuthorization,
  readMcpOAuthControlStatus,
  startMcpOAuthAuthorization,
} from "./mcp-oauth.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

const REQUESTER_SCOPE = { messageChannel: "telegram", agentAccountId: "bot" } as const;

function requesterIdentity(serverName: string, serverUrl: string, requesterSenderId: string) {
  return requesterMcpOAuthIdentity(serverName, serverUrl, {
    ...REQUESTER_SCOPE,
    requesterSenderId,
  });
}

async function saveAccessToken(identity: McpOAuthIdentity, accessToken: string): Promise<void> {
  await createMcpOAuthClientProvider({ identity }).saveTokens({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
  });
}

async function runGatewayOAuthCallback(params: {
  serverName: string;
  server: McpServerConfig;
  code: string;
  state: string;
}) {
  const response = createResponse();
  await handleMcpOAuthCallback(
    createRequest({ path: `/oauth/mcp/callback?code=${params.code}&state=${params.state}` }),
    response.res,
    {
      config: { mcp: { servers: { [params.serverName]: params.server } } },
      log: { warn: vi.fn() },
    },
  );
  return response;
}

function sendOAuthJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readOAuthBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startAuthorizationServer(port: number) {
  const issuer = `http://127.0.0.1:${port}`;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      sendOAuthJson(response, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendOAuthJson(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const metadata = JSON.parse(await readOAuthBody(request)) as Record<string, unknown>;
      sendOAuthJson(response, { ...metadata, client_id: "fixture-client" }, 201);
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await readOAuthBody(request));
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (form.get("code") === "invalid-client-code") {
        sendOAuthJson(response, { error: "invalid_client" }, 401);
        return;
      }
      if (form.get("code") !== challenge) {
        sendOAuthJson(response, { error: "invalid_grant" }, 400);
        return;
      }
      sendOAuthJson(response, {
        access_token: `access-${challenge.slice(0, 8)}`,
        refresh_token: "fixture-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }
    response.writeHead(404).end();
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("OAuth fixture failed"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    issuer,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function authorizationCode(authorizationUrl: string): string {
  const code = new URL(authorizationUrl).searchParams.get("code_challenge");
  if (!code) {
    throw new Error("authorization URL omitted the PKCE challenge");
  }
  return code;
}

async function withTempHome(run: () => Promise<void>): Promise<void> {
  await withBaseTempHome(
    async (home) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
      closeOpenClawStateDatabaseForTest();
      try {
        await run();
      } finally {
        closeOpenClawStateDatabaseForTest();
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    },
    {
      prefix: "openclaw-mcp-oauth-sdk-integration-",
      skipSessionCleanup: true,
      env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
    },
  );
}

describe("MCP OAuth pinned SDK loopback integration", () => {
  beforeEach(() => closeOpenClawStateDatabaseForTest());
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([
    { category: "invalid_grant", code: "rejected-code" },
    { category: "invalid_client", code: "invalid-client-code" },
  ])("preserves an existing credential when the real SDK returns $category", async ({ code }) => {
    await withTempHome(async () => {
      const fixture = await startAuthorizationServer(await getFreePort());
      const rawServer = {
        url: `${fixture.issuer}/mcp`,
        transport: "streamable-http" as const,
        auth: "oauth" as const,
        oauth: { redirectUrl: "https://gateway.example.com/oauth/mcp/callback" },
      };
      const config = resolveMcpTransportConfig("fixture", rawServer);
      if (config?.kind !== "http") {
        throw new Error("expected HTTP MCP OAuth config");
      }
      const identity = operatorMcpOAuthIdentity("fixture", config.url);
      try {
        await saveAccessToken(identity, "preserved-access");
        const started = await startMcpOAuthAuthorization(identity, config, {
          forceAuthorization: true,
        });
        if (started.status !== "redirect") {
          throw new Error("expected MCP OAuth redirect");
        }
        expect.soft(readMcpOAuthStore(identity.storeKey).authorizationAttempt).toMatchObject({
          preserveExistingCredential: true,
        });

        const callback = await runGatewayOAuthCallback({
          serverName: "fixture",
          server: rawServer,
          code,
          state: started.state,
        });

        expect(callback.res.statusCode).toBe(400);
        expect(readMcpOAuthStore(identity.storeKey).tokens?.access_token).toBe("preserved-access");
        expect(readMcpOAuthControlStatus(identity)).toEqual({
          state: "error",
          credentialPresent: true,
          category: "exchange-failed",
        });
        expect(readPending(started.state)).toBeUndefined();
      } finally {
        await fixture.close();
      }
    });
  });

  it("preserves an existing credential when a real SDK reauthorization is cancelled", async () => {
    await withTempHome(async () => {
      const fixture = await startAuthorizationServer(await getFreePort());
      const rawServer = {
        url: `${fixture.issuer}/mcp`,
        transport: "streamable-http" as const,
        auth: "oauth" as const,
        oauth: { redirectUrl: "https://gateway.example.com/oauth/mcp/callback" },
      };
      const config = resolveMcpTransportConfig("fixture", rawServer);
      if (config?.kind !== "http") {
        throw new Error("expected HTTP MCP OAuth config");
      }
      const identity = operatorMcpOAuthIdentity("fixture", config.url);
      try {
        await saveAccessToken(identity, "preserved-access");
        const started = await startMcpOAuthAuthorization(identity, config, {
          forceAuthorization: true,
        });
        if (started.status !== "redirect") {
          throw new Error("expected MCP OAuth redirect");
        }

        await expect(cancelMcpOAuthAuthorization(identity, started.authorizationId)).resolves.toBe(
          true,
        );
        expect(readMcpOAuthStore(identity.storeKey).tokens?.access_token).toBe("preserved-access");
        expect(readMcpOAuthControlStatus(identity)).toEqual({
          state: "ready",
          credentialPresent: true,
        });
        expect(readPending(started.state)).toBeUndefined();
      } finally {
        await fixture.close();
      }
    });
  });

  it("resumes after restart, rejects replay, and supersedes older starts", async () => {
    await withTempHome(async () => {
      const fixture = await startAuthorizationServer(await getFreePort());
      const rawServer = {
        url: `${fixture.issuer}/mcp`,
        transport: "streamable-http" as const,
        auth: "oauth" as const,
        oauth: {
          identity: "per-requester" as const,
          redirectUrl: "https://gateway.example.com/oauth/mcp/callback",
        },
      };
      const config = resolveMcpTransportConfig("fixture", rawServer);
      if (config?.kind !== "http") {
        throw new Error("expected HTTP MCP OAuth config");
      }
      const identity = requesterIdentity("fixture", config.url, "sender-a");
      try {
        const first = await startMcpOAuthAuthorization(identity, config, {});
        if (first.status !== "redirect") {
          throw new Error("expected first MCP OAuth redirect");
        }
        expect(readMcpOAuthStore(identity.storeKey)).toMatchObject({
          codeVerifier: expect.any(String),
          lastAuthorizationUrl: first.authorizationUrl,
          redirectUrl: first.redirectUrl,
        });
        closeOpenClawStateDatabaseForTest();
        const callbacks = await Promise.all(
          [0, 1].map(() =>
            runGatewayOAuthCallback({
              serverName: "fixture",
              server: rawServer,
              code: authorizationCode(first.authorizationUrl),
              state: first.state,
            }),
          ),
        );
        expect(callbacks.map(({ res }) => res.statusCode).toSorted((a, b) => a - b)).toEqual([
          200, 404,
        ]);
        expect(readMcpOAuthStore(identity.storeKey)).toMatchObject({
          tokens: { access_token: expect.any(String) },
        });
        expect(readMcpOAuthStore(identity.storeKey)).not.toHaveProperty("codeVerifier");
        expect(readMcpOAuthStore(identity.storeKey)).not.toHaveProperty("authorizationAttempt");

        const secondIdentity = requesterIdentity("fixture", config.url, "sender-b");
        const second = await startMcpOAuthAuthorization(secondIdentity, config, {});
        if (second.status !== "redirect") {
          throw new Error("expected second MCP OAuth redirect");
        }
        await expect(
          completeMcpOAuthAuthorization(secondIdentity, config, { code: "wrong-code" }),
        ).rejects.toThrow();
        expect(readMcpOAuthStore(secondIdentity.storeKey)).toMatchObject({
          lastAuthorizationUrl: second.authorizationUrl,
          redirectUrl: second.redirectUrl,
          codeVerifier: expect.any(String),
        });
        expect(readMcpOAuthStore(secondIdentity.storeKey)).not.toHaveProperty("tokens");

        const third = await startMcpOAuthAuthorization(secondIdentity, config, {});
        if (third.status !== "redirect") {
          throw new Error("expected third MCP OAuth redirect");
        }
        expect(third.authorizationUrl).not.toBe(second.authorizationUrl);
        expect(readPending(second.state)).toBeUndefined();
        expect(readPending(third.state)).toBe(secondIdentity.storeKey);
        await expect(
          completeMcpOAuthAuthorization(secondIdentity, config, {
            code: authorizationCode(second.authorizationUrl),
          }),
        ).rejects.toThrow();
        expect(readMcpOAuthStore(secondIdentity.storeKey).lastAuthorizationUrl).toBe(
          third.authorizationUrl,
        );
        await expect(
          completeMcpOAuthAuthorization(secondIdentity, config, {
            code: authorizationCode(third.authorizationUrl),
          }),
        ).resolves.toBe("authorized");
      } finally {
        await fixture.close();
      }
    });
  });
});
