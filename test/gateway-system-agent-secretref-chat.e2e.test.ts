import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
// E2E: bound `openclaw.chat` sessions work when the provider key is a file SecretRef.
//
// Regression proof for #115062: the system-agent inference verifier re-read the
// config file directly, which leaves non-env SecretRefs unresolved, so a provider
// configured with a file SecretRef reported "No API key found" on the bound
// `openclaw.chat` session path even though the running gateway had the resolved
// credential. Only the external provider is mocked (loopback HTTP); the gateway
// is a real spawned process and the chat travels the real WS method dispatch.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const PROVIDER = "secretref-proof";
const MODEL_ID = "secretref-proof-model";
const DRIFT_MODEL_ID = "secretref-proof-drifted";
const SECRET_VALUE = "secretref-e2e-file-key-1187";
const SESSION_ID = "secretref-bound-chat-session";

type ProviderHit = { method: string; pathname: string; authorization: string | undefined };

type MockProviderServer = {
  baseUrl: string;
  hits: ProviderHit[];
  close: () => Promise<void>;
};

const instances: OpenClawTestInstance[] = [];
const providerServers: MockProviderServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(providerServers.splice(0).map((server) => server.close()));
  await Promise.allSettled(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("gateway system-agent chat with a file SecretRef provider key", () => {
  it(
    "binds, revalidates, and fails closed on config drift without leaking provider I/O",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // macOS os.tmpdir() is a /var -> /private/var symlink; resolve before any
      // path reaches config so file-provider ownership checks see canonical paths.
      const secretsDir = realpathSync(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secretref-e2e-")),
      );
      tempDirs.push(secretsDir);
      const secretsFile = path.join(secretsDir, "secrets.json");
      await fs.writeFile(secretsFile, JSON.stringify({ mock_api_key: SECRET_VALUE }), {
        mode: 0o600,
      });

      const provider = await startMockProviderServer();
      providerServers.push(provider);
      const instance = await createOpenClawTestInstance({
        name: "gateway-secretref-chat",
        config: createTestConfig(provider.baseUrl, secretsFile, MODEL_ID),
        env: {
          // The instance helper defaults both on; this test needs real provider
          // dispatch so the mocked completions endpoint receives the credential.
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);
      await instance.startGateway();

      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        // Bound session creation: verifySystemAgentInferenceWithFallback must see
        // the resolved SecretRef, and the resolved value must reach the provider.
        const create = await chatTurn(client, "hello from the secretref e2e test");
        expect(create.sessionId).toBe(SESSION_ID);
        expect(typeof create.reply).toBe("string");
        expect(create.reply.length).toBeGreaterThan(0);
        const createHits = provider.hits.splice(0);
        expect(createHits.length).toBeGreaterThan(0);
        for (const hit of createHits) {
          expect(hit.authorization).toBe(`Bearer ${SECRET_VALUE}`);
        }

        // Second turn on the same sessionId: bound-route revalidation must keep
        // resolving the SecretRef rather than re-reading raw config.
        const second = await chatTurn(client, "still with me?");
        expect(second.sessionId).toBe(SESSION_ID);
        const secondHits = provider.hits.splice(0);
        expect(secondHits.length).toBeGreaterThan(0);
        for (const hit of secondHits) {
          expect(hit.authorization).toBe(`Bearer ${SECRET_VALUE}`);
        }

        // In-place config drift without a restart: the same bound session must be
        // refused, and the refusal must precede any provider I/O.
        await fs.writeFile(
          instance.configPath,
          JSON.stringify(
            mergePersistedConfig(
              JSON.parse(await fs.readFile(instance.configPath, "utf8")) as Record<string, unknown>,
              createTestConfig(provider.baseUrl, secretsFile, DRIFT_MODEL_ID),
            ),
            null,
            2,
          ),
        );
        await expect(chatTurn(client, "after drift")).rejects.toMatchObject({
          code: "UNAVAILABLE",
          details: { code: "system_agent_session_invalidated" },
        });
        expect(provider.hits).toHaveLength(0);
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );
});

async function chatTurn(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  message: string,
): Promise<{ sessionId: string; reply: string }> {
  return await client.request<{ sessionId: string; reply: string }>(
    "openclaw.chat",
    { sessionId: SESSION_ID, message },
    { timeoutMs: 120_000 },
  );
}

function createTestConfig(
  baseUrl: string,
  secretsFile: string,
  modelId: string,
): Record<string, unknown> {
  return {
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: `${PROVIDER}/${modelId}` },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        [PROVIDER]: {
          baseUrl: `${baseUrl}/v1`,
          api: "openai-completions",
          apiKey: { source: "file", provider: "local_file", id: "/mock_api_key" },
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: modelId,
              name: modelId,
              api: "openai-completions",
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
    secrets: {
      providers: { local_file: { source: "file", path: secretsFile, mode: "json" } },
    },
  };
}

/** Keep helper-owned sections (gateway auth/port, hooks) while swapping the drifted model config. */
function mergePersistedConfig(
  persisted: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return { ...persisted, ...next };
}

async function startMockProviderServer(): Promise<MockProviderServer> {
  const hits: ProviderHit[] = [];
  const server = createServer((request, response) => {
    void handleProviderRequest(request, response, hits).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("secretref mock provider server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  hits: ProviderHit[],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  // Drain the body; only the route and Authorization header matter here.
  await new Promise<void>((resolve) => {
    request.on("data", () => {});
    request.on("end", resolve);
  });
  hits.push({
    method: request.method ?? "",
    pathname: url.pathname,
    authorization: request.headers.authorization,
  });
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chatcmpl-secretref-e2e",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}
