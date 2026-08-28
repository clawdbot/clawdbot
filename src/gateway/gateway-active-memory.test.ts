import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFailed } from "vitest";
import { GatewayClient } from "../../packages/gateway-client/src/index.js";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../infra/ed25519-signature.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

function completeResponse(response: ServerResponse, item?: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const responseId = `resp_${randomUUID()}`;
  send({ type: "response.created", response: { id: responseId, status: "in_progress" } });
  if (item) {
    send({ type: "response.output_item.added", output_index: 0, item });
    send({ type: "response.output_item.done", output_index: 0, item });
  }
  send({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: item ? [item] : [],
      usage: { input_tokens: 1, output_tokens: item ? 1 : 0, total_tokens: item ? 2 : 1 },
    },
  });
  response.end("data: [DONE]\n\n");
}

describe("Gateway Active Memory", () => {
  it(
    "keeps a grounded but terminally failed recall out of the main prompt",
    { timeout: 90_000 },
    async () => {
      const repoRoot = process.cwd();
      const head = resolveGitHead({ cwd: repoRoot });
      expect(head).toMatch(/^[0-9a-f]{40}$/u);
      // Fail before the process helper can rebuild shared dist or choose source.
      await fs.access(path.join(repoRoot, "dist/index.js"));
      for (const [file, field] of [
        [BUILD_STAMP_FILE, "head"],
        [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
        ["build-info.json", "commit"],
      ] as const) {
        const metadata = JSON.parse(
          await fs.readFile(path.join(repoRoot, "dist", file), "utf8"),
        ) as Record<string, unknown>;
        expect(metadata[field], file).toBe(head);
      }
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-memory-gateway-"));
      const workspace = path.join(home, "workspace");
      const memoryFact = "The user's usual lunch is ginger ramen.";
      const mainReply = "ACTIVE_MEMORY_RUNTIME_PROOF_OK";
      const mainRequests: string[] = [];
      const memoryResults: string[] = [];
      const providerErrors: unknown[] = [];
      let recallRequests = 0;
      let memoryToolIssued = false;
      let phase = "preparing fixture";
      onTestFailed(() => {
        console.info({
          phase,
          fixtureHome: home,
          recallRequests,
          memoryResults: memoryResults.length,
          mainRequests: mainRequests.length,
        });
      });
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = JSON.parse(raw) as {
            input?: Array<{ type?: string; output?: unknown }>;
          };
          // Route by the helper's prompt, not request order: empty-turn recovery
          // can make several provider calls before the main turn starts.
          if (raw.includes("You are a memory search agent.")) {
            recallRequests += 1;
            for (const item of body.input ?? []) {
              if (item.type === "function_call_output") {
                memoryResults.push(
                  typeof item.output === "string" ? item.output : JSON.stringify(item.output),
                );
              }
            }
            if (!memoryToolIssued) {
              memoryToolIssued = true;
              completeResponse(response, {
                type: "function_call",
                id: "fc_memory_get",
                call_id: "call_memory_get",
                name: "memory_get",
                arguments: JSON.stringify({ path: "MEMORY.md" }),
                status: "completed",
              });
            } else {
              // Exhaust the real incomplete-turn recovery after the real tool
              // read; do not synthesize a runner result or a plugin failure.
              completeResponse(response);
            }
            return;
          }
          mainRequests.push(raw);
          completeResponse(response, {
            type: "message",
            id: `msg_${randomUUID()}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: mainReply, annotations: [] }],
          });
        })().catch((error: unknown) => {
          providerErrors.push(error);
          response.writeHead(500).end("mock provider failed");
        });
      });
      let instance: OpenClawTestInstance | undefined;
      let client: GatewayClient | undefined;
      try {
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(path.join(workspace, "MEMORY.md"), `${memoryFact}\n`, "utf8");
        phase = "starting mock provider";
        await new Promise<void>((resolve, reject) => {
          providerServer.once("error", reject);
          providerServer.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("mock provider did not bind");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${address.port}/v1`,
          "active-memory-proof",
        );
        const token = `active-memory-${randomUUID()}`;
        const cfg = {
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          hooks: { enabled: false },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          memory: { search: { rememberAcrossConversations: false } },
          plugins: {
            allow: ["active-memory", "memory-core", "openai"],
            slots: { memory: "memory-core" },
            entries: {
              "active-memory": {
                enabled: true,
                config: {
                  mode: "always",
                  agents: ["main"],
                  allowedChatTypes: ["direct", "explicit"],
                  model: provider.modelRef,
                  toolsAllow: ["memory_get"],
                  logging: true,
                },
              },
            },
          },
          tools: { profile: "full" },
        } satisfies OpenClawConfig;
        phase = "starting Gateway";
        instance = await createOpenClawTestInstance({
          name: "active-memory-gateway",
          cwd: repoRoot,
          config: cfg,
          gatewayToken: token,
          env: {
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
          },
        });
        expect(await instance.entrypoint()).toEqual(["dist/index.js"]);
        await instance.startGateway();
        const connected = createDeferred<void>();
        client = new GatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
          clientName: GATEWAY_CLIENT_NAMES.TEST,
          clientVersion: "dev",
          mode: GATEWAY_CLIENT_MODES.TEST,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          deviceIdentity: generateStoredDeviceIdentity(),
          hostDeps: {
            signDevicePayload: signEd25519Payload,
            publicKeyRawBase64UrlFromPem: publicKeyRawBase64UrlFromEd25519Pem,
          },
          onHelloOk: () => connected.resolve(),
          onConnectError: connected.reject,
          onClose: (code, reason) =>
            connected.reject(new Error(`Gateway closed during connect (${code}): ${reason}`)),
        });
        client.start();
        await withTestTimeout(connected.promise, 10_000, "Gateway connect timeout");
        const sessionKey = "agent:main:main";
        phase = "starting main turn";
        const accepted = await client.request<{ runId: string; status: string }>("agent", {
          sessionKey,
          message: "What do I usually have for lunch?",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(accepted.status).toBe("accepted");
        phase = "waiting for main reply";
        const completed = await client.request<{ status: string }>(
          "agent.wait",
          { runId: accepted.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        expect(completed.status).toBe("ok");
        phase = "checking recall and main reply";
        expect(providerErrors).toEqual([]);
        expect(memoryResults).toEqual(
          expect.arrayContaining([expect.stringContaining(memoryFact)]),
        );
        expect(recallRequests).toBeGreaterThan(1);
        const entry = loadSessionEntryReadOnly({
          agentId: "main",
          sessionKey,
          env: instance.env,
          storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
        });
        const statusLines = entry?.pluginDebugEntries?.find(
          (item) => item.pluginId === "active-memory",
        )?.lines;
        expect(statusLines?.join("\n")).toContain("Active Memory: status=failed");
        expect(mainRequests).toHaveLength(1);
        expect(mainRequests[0]).not.toContain("<active_memory_plugin>");
        expect(mainRequests[0]).not.toContain("Please try again.");
        const history = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
        });
        expect(JSON.stringify(history.messages)).toContain(mainReply);
      } finally {
        try {
          await client?.stopAndWait();
        } finally {
          try {
            await instance?.cleanup();
          } finally {
            try {
              providerServer.closeAllConnections();
              await new Promise<void>((resolve) => {
                providerServer.close(() => resolve());
              });
            } finally {
              await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
            }
          }
        }
      }
    },
  );
});
