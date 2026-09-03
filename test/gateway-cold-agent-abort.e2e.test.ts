import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

it(
  "cancels a provider request through the first chat RPC on a built Gateway",
  { timeout: 120_000 },
  async () => {
    const modelId = "cold-cancel-model";
    const runId = randomUUID();
    const sessionKey = "agent:main:cold-agent-abort";
    const accepted = createDeferred<unknown>();
    const providerReceived = createDeferred<Record<string, unknown>>();
    let providerRequests = 0;
    let providerAborted = false;
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET" && request.url === "/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: modelId, object: "model" }] }));
          return;
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        providerRequests += 1;
        // Keep the provider response open: only cancellation may close it before cleanup.
        response.once("close", () => {
          providerAborted = !response.writableFinished;
        });
        providerReceived.resolve(body);
      })().catch((error: unknown) => {
        providerReceived.reject(error);
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    let instance: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let final: Promise<unknown> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("cancellation provider did not bind a loopback port");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        modelId,
      );
      const config: OpenClawConfig = {
        plugins: { slots: { memory: "none" } },
        agents: {
          entries: { main: {} },
          defaults: {
            model: { primary: provider.modelRef, fallbacks: [] },
            models: { [provider.modelRef]: { agentRuntime: { id: "openclaw" } } },
            skills: [],
          },
        },
        tools: { profile: "minimal" },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: {
              ...provider.config,
              request: { allowPrivateNetwork: true },
            },
          },
        },
      };
      instance = await createOpenClawTestInstance({
        name: "cold-agent-abort",
        config,
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      await instance.startGateway();
      client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
      });
      final = client.request(
        "agent",
        {
          agentId: "main",
          sessionKey,
          idempotencyKey: runId,
          message: "Wait for cancellation.",
          deliver: false,
          timeout: 30,
        },
        { expectFinal: true, timeoutMs: 30_000, onAccepted: accepted.resolve },
      );
      await expect(
        Promise.race([
          Promise.all([accepted.promise, providerReceived.promise]),
          final.then(() => {
            throw new Error("agent completed before the cancellation request");
          }),
        ]),
      ).resolves.toMatchObject([{ runId, status: "accepted" }, { model: modelId }]);
      expect(providerAborted).toBe(false);

      // Readiness uses HTTP and setup uses only agent: this is the first chat-family RPC.
      const aborted = await client.request("chat.abort", { sessionKey, runId });
      expect(aborted).toMatchObject({ aborted: true, runIds: [runId] });
      const terminal = await final;
      // The agent RPC retains its cancellation wire status; the task records the outcome.
      expect(terminal).toEqual({
        runId,
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });
      expect(await client.request("tasks.list", { sessionKey })).toEqual({
        tasks: [
          expect.objectContaining({ runId, childSessionKey: sessionKey, status: "cancelled" }),
        ],
      });
      await vi.waitFor(() => expect(providerAborted).toBe(true), { timeout: 5_000 });
      expect(providerRequests).toBe(1);
    } finally {
      try {
        if (client) {
          await disconnectGatewayClient(client);
        }
      } finally {
        try {
          await instance?.cleanup();
        } finally {
          if (server.listening) {
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            });
          }
          await Promise.allSettled(final ? [final] : []);
        }
      }
    }
  },
);
