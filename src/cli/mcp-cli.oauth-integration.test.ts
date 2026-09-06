import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthIdentity,
} from "../agents/mcp-oauth-identity.js";
import {
  readMcpOAuthPendingAuthorization,
  updateMcpOAuthStore,
  writeMcpOAuthPendingAuthorization,
} from "../agents/mcp-oauth-store.js";
import { readMcpOAuthCredentialsStatus } from "../agents/mcp-oauth.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getFreePort } from "../test-utils/ports.js";
import { registerMcpCli } from "./mcp-cli.js";

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startOAuthFixture(port: number) {
  const issuer = `http://127.0.0.1:${port}`;
  let codeChallenge: string | undefined;
  let tokenRedirectUri: string | undefined;
  let tokenVerifier: string | undefined;
  const mcpRequests: Array<{
    contentLength: string | undefined;
    transferEncoding: string | undefined;
    authorization: string | undefined;
    body: string;
  }> = [];
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      sendJson(response, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(response, {
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
      const metadata = JSON.parse(await readBody(request)) as { redirect_uris?: string[] };
      sendJson(
        response,
        {
          ...metadata,
          client_id: "fixture-client",
          client_id_issued_at: Math.floor(Date.now() / 1000),
        },
        201,
      );
      return;
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
      if (!redirectUri || !state || !codeChallenge) {
        sendJson(response, { error: "invalid_request" }, 400);
        return;
      }
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", state);
      response.writeHead(302, { Location: callback.toString() });
      response.end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== "fixture-refresh-token") {
          sendJson(response, { error: "invalid_grant" }, 400);
          return;
        }
        sendJson(response, {
          access_token: "fixture-refreshed-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }
      tokenRedirectUri = form.get("redirect_uri") ?? undefined;
      tokenVerifier = form.get("code_verifier") ?? undefined;
      const challenge = tokenVerifier
        ? createHash("sha256").update(tokenVerifier).digest("base64url")
        : undefined;
      if (form.get("code") !== "fixture-code" || challenge !== codeChallenge) {
        sendJson(response, { error: "invalid_grant" }, 400);
        return;
      }
      sendJson(response, {
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const body = await readBody(request);
      mcpRequests.push({
        contentLength: request.headers["content-length"],
        transferEncoding: request.headers["transfer-encoding"],
        authorization: request.headers.authorization,
        body,
      });
      if (request.headers["content-length"] === undefined) {
        response.writeHead(411, { "Content-Type": "text/plain" });
        response.end("Content-Length required");
        return;
      }
      if (mcpRequests.length === 1) {
        response.writeHead(401, {
          "Content-Type": "text/plain",
          "WWW-Authenticate": 'Bearer scope="docs.read"',
        });
        response.end("expired token");
        return;
      }
      const message = JSON.parse(body) as { id?: number; method?: string };
      if (message.method === "initialize") {
        sendJson(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202, { "Content-Length": "0" });
        response.end();
        return;
      }
      if (message.method === "tools/list") {
        sendJson(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "read_page",
                description: "Read one page.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
        return;
      }
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
    exchange: () => ({ tokenRedirectUri, tokenVerifier }),
    mcpRequests: () => mcpRequests,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("mcp login OAuth integration", () => {
  it("keeps per-requester list, status, and doctor probes read only", async () => {
    await withTempHome(`openclaw-mcp-read-only-${randomUUID()}-`, async () => {
      const logs: string[] = [];
      const json: unknown[] = [];
      vi.spyOn(defaultRuntime, "log").mockImplementation((line) => logs.push(String(line)));
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => json.push(value));
      vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
      const program = new Command().exitOverride();
      registerMcpCli(program);
      await program.parseAsync(
        [
          "mcp",
          "set",
          "fixture",
          JSON.stringify({
            url: "https://mcp.example.com/rpc",
            transport: "streamable-http",
            auth: "oauth",
            oauth: { identity: "per-requester" },
          }),
        ],
        { from: "user" },
      );
      logs.length = 0;

      await program.parseAsync(["mcp", "list"], { from: "user" });
      expect(logs).toContain("- fixture (0 connected principals)");
      logs.length = 0;
      await program.parseAsync(["mcp", "status", "--json"], { from: "user" });
      expect(json.at(-1)).toMatchObject({
        servers: [{ name: "fixture", connectedPrincipals: 0 }],
      });
      json.length = 0;
      await expect(
        program.parseAsync(["mcp", "doctor", "--probe", "--json"], { from: "user" }),
      ).rejects.toThrow("MCP doctor found errors");
      expect(json.at(-1)).toMatchObject({ servers: [{ name: "fixture" }] });
      withOpenClawStateDatabaseReadOnly(({ db }) => {
        expect(db.prepare("SELECT count(*) AS count FROM mcp_oauth_stores").get()).toEqual({
          count: 0,
        });
        expect(
          db
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get("mcp_oauth_pending_authorizations"),
        ).toBeUndefined();
      });
    });
  });

  it("clears requester credentials when the same URL changes to shared OAuth", async () => {
    await withTempHome(`openclaw-mcp-identity-flip-${randomUUID()}-`, async () => {
      const serverUrl = "https://mcp.example.com/rpc";
      const program = new Command().exitOverride();
      registerMcpCli(program);
      await program.parseAsync(
        [
          "mcp",
          "set",
          "fixture",
          JSON.stringify({
            url: serverUrl,
            transport: "streamable-http",
            auth: "oauth",
            oauth: { identity: "per-requester" },
          }),
        ],
        { from: "user" },
      );
      const operator = operatorMcpOAuthIdentity("fixture", serverUrl);
      const requester = requesterMcpOAuthIdentity("fixture", serverUrl, {
        requesterSenderId: "alice",
        messageChannel: "telegram",
      });
      for (const identity of [operator, requester]) {
        updateMcpOAuthStore(identity.storeKey, (store) => ({
          ...store,
          tokens: { access_token: identity.principal, token_type: "Bearer" },
        }));
      }
      writeMcpOAuthPendingAuthorization(requester.storeKey, "requester-state");

      await program.parseAsync(
        [
          "mcp",
          "set",
          "fixture",
          JSON.stringify({
            url: serverUrl,
            transport: "streamable-http",
            auth: "oauth",
          }),
        ],
        { from: "user" },
      );

      await expect(readMcpOAuthCredentialsStatus(requester)).resolves.toEqual({
        state: "unauthenticated",
      });
      await expect(readMcpOAuthCredentialsStatus(operator)).resolves.toEqual({
        state: "authorized",
      });
      expect(readMcpOAuthPendingAuthorization("requester-state")).toBeUndefined();
    });
  });

  it("logs in and probes an OAuth MCP server through the CLI", async () => {
    await withTempHome(`openclaw-mcp-login-${randomUUID()}-`, async () => {
      const oauthPort = await getFreePort();
      const callbackPort = await getFreePort();
      const fixture = await startOAuthFixture(oauthPort);
      const redirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`;
      const logs: string[] = [];
      const authorizationUrl = createDeferred<string>();
      vi.spyOn(defaultRuntime, "log").mockImplementation((line) => {
        const text = String(line);
        logs.push(text);
        if (text.startsWith(`${fixture.issuer}/authorize`)) {
          authorizationUrl.resolve(text);
        }
      });
      const program = new Command().exitOverride();
      registerMcpCli(program);
      try {
        await program.parseAsync(
          [
            "mcp",
            "set",
            "fixture",
            JSON.stringify({
              url: `${fixture.issuer}/mcp`,
              transport: "streamable-http",
              auth: "oauth",
              oauth: { redirectUrl },
            }),
          ],
          { from: "user" },
        );
        logs.length = 0;

        // Drive the browser from the published URL, not a polling deadline that
        // can abandon login while discovery still owns the temporary state.
        const browser = authorizationUrl.promise.then(async (url) => {
          const response = await fetch(url);
          return { status: response.status, body: await response.text() };
        });
        const [browserResponse] = await Promise.all([
          browser,
          program.parseAsync(["mcp", "login", "fixture"], { from: "user" }),
        ]);
        expect(logs.some((line) => line.includes("Waiting for the browser"))).toBe(true);
        expect(browserResponse.status).toBe(200);
        expect(browserResponse.body).toContain("Authorization received");

        await expect(
          readMcpOAuthCredentialsStatus(
            operatorMcpOAuthIdentity("fixture", `${fixture.issuer}/mcp`),
          ),
        ).resolves.toMatchObject({
          state: "authorized",
        });
        expect(fixture.exchange()).toMatchObject({
          tokenRedirectUri: redirectUrl,
          tokenVerifier: expect.any(String),
        });
        expect(logs).toContain('MCP OAuth credentials saved for "fixture".');

        logs.length = 0;
        await program.parseAsync(["mcp", "probe", "fixture"], { from: "user" });
        expect(logs).toContain("- fixture: 1 tools, Codex approval auto");
        expect(fixture.mcpRequests().map((request) => JSON.parse(request.body).method)).toEqual([
          "initialize",
          "initialize",
          "notifications/initialized",
          "tools/list",
        ]);
        expect(fixture.mcpRequests()[0]?.body).toBe(fixture.mcpRequests()[1]?.body);
        for (const request of fixture.mcpRequests()) {
          expect(request.contentLength).toBe(String(Buffer.byteLength(request.body)));
          expect(request.transferEncoding).toBeUndefined();
        }
        expect(fixture.mcpRequests()[0]?.authorization).toBe("Bearer fixture-access-token");
        expect(
          fixture
            .mcpRequests()
            .slice(1)
            .map((request) => request.authorization),
        ).toEqual([
          "Bearer fixture-refreshed-access-token",
          "Bearer fixture-refreshed-access-token",
          "Bearer fixture-refreshed-access-token",
        ]);
        await expect(fetch(redirectUrl)).rejects.toThrow();
      } finally {
        await fixture.close();
      }
    });
  });
});
