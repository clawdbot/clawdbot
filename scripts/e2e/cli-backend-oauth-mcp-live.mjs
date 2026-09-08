import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const staleAccess = "live-cli-oauth-stale";
const freshAccess = "live-cli-oauth-fresh";
const refreshToken = "live-cli-oauth-refresh";

function sendJson(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate an OAuth callback port");
  }
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

async function startOAuthMcpServer() {
  const requests = [];
  let codeChallenge;
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("OAuth MCP server address is unavailable");
      }
      const issuer = `http://127.0.0.1:${address.port}`;
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
        sendJson(
          response,
          { ...JSON.parse(await readBody(request)), client_id: "live-cli-oauth" },
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
        callback.searchParams.set("code", "live-cli-oauth-code");
        callback.searchParams.set("state", state);
        response.writeHead(302, { location: callback.toString() });
        response.end();
        return;
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await readBody(request));
        if (form.get("grant_type") === "refresh_token") {
          if (form.get("refresh_token") !== refreshToken) {
            sendJson(response, { error: "invalid_grant" }, 400);
            return;
          }
          sendJson(response, {
            access_token: freshAccess,
            token_type: "Bearer",
            expires_in: 3600,
          });
          return;
        }
        const verifier = form.get("code_verifier");
        const challenge = verifier
          ? createHash("sha256").update(verifier).digest("base64url")
          : undefined;
        if (form.get("code") !== "live-cli-oauth-code" || challenge !== codeChallenge) {
          sendJson(response, { error: "invalid_grant" }, 400);
          return;
        }
        sendJson(response, {
          access_token: staleAccess,
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }
      if (url.pathname !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      if (request.method === "GET") {
        response.writeHead(405, { allow: "POST" }).end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      const message = JSON.parse(await readBody(request));
      requests.push({ authorization: request.headers.authorization, method: message.method });
      if (request.headers.authorization !== `Bearer ${freshAccess}`) {
        response.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp" scope="docs.read"`,
        });
        response.end("expired token");
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const results = {
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "live-cli-oauth", version: "1.0.0" },
        },
        "tools/list": {
          tools: [
            {
              name: "read_page",
              description: "Return the OAuth MCP live-proof marker.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
        "tools/call": { content: [{ type: "text", text: "CHILD_TOOL_OK" }] },
        "resources/list": { resources: [] },
        "prompts/list": { prompts: [] },
      };
      sendJson(response, {
        jsonrpc: "2.0",
        id: message.id,
        result: results[message.method] ?? {},
      });
    })().catch(() => response.destroy(new Error("OAuth MCP server request failed")));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth MCP server did not bind");
  }
  return {
    issuer: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function redactDiagnostic(value) {
  return value
    .replaceAll(staleAccess, "<stale-access>")
    .replaceAll(freshAccess, "<fresh-access>")
    .replaceAll(refreshToken, "<refresh-token>")
    .slice(-4_000);
}

function runOpenClaw(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["openclaw.mjs", ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `openclaw ${args[0]} exited code=${code} signal=${signal ?? "none"}: ${redactDiagnostic(`${stdout}\n${stderr}`)}`,
        ),
      );
    });
  });
}

function runMcpLogin(env, issuer) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["openclaw.mjs", "mcp", "login", "proof"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let browserStarted = false;
    const inspect = async (chunk) => {
      output += chunk;
      const escapedIssuer = issuer.replaceAll(".", "\\.");
      const match = output.match(new RegExp(`${escapedIssuer}/authorize\\?[^\\s]+`));
      if (!match || browserStarted) {
        return;
      }
      browserStarted = true;
      try {
        const response = await fetch(match[0]);
        if (!response.ok) {
          throw new Error(`OAuth browser callback returned ${response.status}`);
        }
        await response.arrayBuffer();
      } catch (error) {
        child.kill("SIGTERM");
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => void inspect(chunk));
    child.stderr.on("data", (chunk) => void inspect(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && browserStarted) {
        resolve();
        return;
      }
      reject(new Error(`openclaw mcp login exited code=${code} signal=${signal ?? "none"}`));
    });
  });
}

function authorizationClass(value) {
  if (value === `Bearer ${staleAccess}`) {
    return "stale";
  }
  if (value === `Bearer ${freshAccess}`) {
    return "fresh";
  }
  if (value?.includes("OPENCLAW_MCP_AUTH")) {
    return "placeholder";
  }
  return value ? "other" : "absent";
}

const fixture = await startOAuthMcpServer();
const callbackPort = await getFreePort();
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-cli-oauth-mcp-"));
const workspaceDir = path.join(stateDir, "workspace");
const configPath = path.join(stateDir, "openclaw.json");
const model = process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL ?? "claude-cli/claude-sonnet-5";
await fs.mkdir(workspaceDir, { recursive: true });
await fs.writeFile(
  configPath,
  JSON.stringify({
    agents: { defaults: { workspace: workspaceDir, skipBootstrap: true } },
    plugins: { slots: { memory: "none" } },
    tools: { allow: ["proof__read_page"] },
    mcp: {
      servers: {
        proof: {
          transport: "streamable-http",
          url: `${fixture.issuer}/mcp`,
          auth: "oauth",
          oauth: { redirectUrl: `http://127.0.0.1:${callbackPort}/oauth/callback` },
        },
      },
    },
  }),
);
const env = {
  ...process.env,
  BROWSER: "true",
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
};

try {
  await runMcpLogin(env, fixture.issuer);
  const agent = await runOpenClaw(
    [
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-id",
      `live-cli-oauth-${randomUUID()}`,
      "--model",
      model,
      "--message",
      "Use the proof MCP read_page tool once. Then reply with exact text MCP_OAUTH_OK.",
      "--thinking",
      "off",
      "--timeout",
      "240",
      "--json",
    ],
    env,
  );
  const methods = fixture.requests.map((request) => request.method);
  const authorizationSequence = fixture.requests.map((request) =>
    authorizationClass(request.authorization),
  );
  const initializeIndexes = methods.flatMap((method, index) =>
    method === "initialize" ? [index] : [],
  );
  const toolCallIndex = methods.indexOf("tools/call");
  if (
    authorizationSequence[0] !== "stale" ||
    authorizationSequence[1] !== "fresh" ||
    initializeIndexes.length < 3 ||
    toolCallIndex < 0 ||
    authorizationSequence[toolCallIndex] !== "fresh" ||
    authorizationSequence.includes("placeholder") ||
    !agent.stdout.includes("MCP_OAUTH_OK")
  ) {
    throw new Error("OAuth MCP live product-path assertions failed");
  }
  console.log(
    `CLI_BACKEND_OAUTH_MCP_PROOF ${JSON.stringify({
      entrypoint: "openclaw agent --local",
      runtime: model,
      authorizationSequence,
      methods,
      nativeRefresh: authorizationSequence.slice(0, 2),
      childInitialize: authorizationSequence[initializeIndexes.at(-1)],
      childToolCall: authorizationSequence[toolCallIndex],
      agentReply: "MCP_OAUTH_OK",
    })}`,
  );
} finally {
  await fixture.close();
  await fs.rm(stateDir, { recursive: true, force: true });
}
