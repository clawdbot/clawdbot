// E2E: a native WhatsApp self-LID mention reaches an ephemeral Gateway as agent-facing identity text.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig as GatewayConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../src/test-utils/bundled-plugin-public-surface.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const WHATSAPP_TEST_API_MODULE_ID = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "whatsapp",
  artifactBasename: "src/test-support/self-lid-gateway-api.js",
});

type WhatsAppGatewayTestApi = {
  extractMentionedJids: (message: unknown) => string[];
  installWebAutoReplyTestHomeHooks: () => void;
  installWebAutoReplyUnitTestHooks: () => void;
  monitorWebChannelWithCapture: (
    resolver: (ctx: MsgContext) => Promise<{ text: string }>,
  ) => Promise<{ spies: unknown; onMessage: unknown }>;
  projectWhatsAppInboundMessage: (message: unknown) => unknown;
  resetLoadConfigMock: () => void;
  sendWebGroupInboundMessage: (params: {
    onMessage: unknown;
    spies: unknown;
    body: string;
    id: string;
    conversationId: string;
    senderE164: string;
    senderName: string;
    mentionedJids: string[];
    selfE164: string;
    selfJid: string;
    selfLid: string;
  }) => Promise<void>;
  setLoadConfigMock: (config: OpenClawConfig) => void;
};

const {
  extractMentionedJids,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  monitorWebChannelWithCapture,
  projectWhatsAppInboundMessage,
  resetLoadConfigMock,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} = (await import(WHATSAPP_TEST_API_MODULE_ID)) as WhatsAppGatewayTestApi;

const SELF_LID_ID = "900000000000001";
const SELF_LID = SELF_LID_ID + "@lid";
const MODEL_REF = "whatsapp-proof/whatsapp-proof";
const SESSION_KEY = "agent:main:main";

type CapturedModelRequest = { input?: unknown };
type MockModelServer = {
  baseUrl: string;
  requests: CapturedModelRequest[];
  close: () => Promise<void>;
};

installWebAutoReplyTestHomeHooks();

const instances: OpenClawTestInstance[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  resetLoadConfigMock();
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("WhatsApp self-LID mention through an ephemeral Gateway", () => {
  installWebAutoReplyUnitTestHooks();

  it(
    "dispatches configured identity text while preserving the raw WhatsApp command body",
    { timeout: 180_000 },
    async () => {
      setLoadConfigMock({
        channels: { whatsapp: { allowFrom: ["*"] } },
        agents: { list: [{ id: "main", identity: { name: "Kit" } }] },
        bindings: [{ agentId: "main", match: { channel: "whatsapp", accountId: "default" } }],
      } satisfies OpenClawConfig);

      const modelServer = await startMockModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "whatsapp-self-lid-gateway",
        config: createGatewayConfig(modelServer.baseUrl),
        env: {
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
      const contexts: MsgContext[] = [];
      try {
        const resolver = async (ctx: MsgContext) => {
          contexts.push(ctx);
          const runId = randomUUID();
          const started = await client.request<{ runId?: string; status?: string }>("agent", {
            sessionKey: SESSION_KEY,
            message: ctx.BodyForAgent,
            deliver: false,
            idempotencyKey: runId,
          });
          expect(started.status).toBe("accepted");
          const completed = await client.request<{ status?: string }>(
            "agent.wait",
            { runId: started.runId ?? runId, timeoutMs: 120_000 },
            { timeoutMs: 125_000 },
          );
          expect(completed.status, instance.logs()).toBe("ok");
          return { text: "gateway accepted" };
        };
        const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);
        const rawBody = "@" + SELF_LID_ID + " what is the deploy status?";
        const mentionedJids = extractMentionedJids(
          projectWhatsAppInboundMessage({
            extendedTextMessage: {
              text: rawBody,
              contextInfo: { mentionedJid: [SELF_LID] },
            },
          }),
        );

        await sendWebGroupInboundMessage({
          onMessage,
          spies,
          body: rawBody,
          id: "self-lid-gateway-1",
          conversationId: "123@g.us",
          senderE164: "+15550002222",
          senderName: "Alice",
          mentionedJids,
          selfE164: "+15550003333",
          selfJid: "15550003333@s.whatsapp.net",
          selfLid: SELF_LID,
        });

        expect(contexts).toHaveLength(1);
        expect(contexts[0]?.BodyForAgent).toBe("@Kit what is the deploy status?");
        expect(contexts[0]?.RawBody).toBe(rawBody);
        expect(contexts[0]?.CommandBody).toBe(rawBody);
        expect(modelServer.requests).toHaveLength(1);
        const acceptedPrompt = JSON.stringify(modelServer.requests[0]?.input);
        expect(acceptedPrompt).toContain("@Kit what is the deploy status?");
        expect(acceptedPrompt).not.toContain(SELF_LID_ID);
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );
});

function createGatewayConfig(baseUrl: string): GatewayConfig {
  return {
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
      list: [{ id: "main", identity: { name: "Kit" } }],
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        "whatsapp-proof": {
          baseUrl: baseUrl + "/v1",
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "whatsapp-proof",
              name: "whatsapp-proof",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: CapturedModelRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "whatsapp-proof", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(await readRequestBody(request)) as CapturedModelRequest);
      writeOpenAiResponsesText(response, {
        text: "gateway accepted self-LID mention",
        messageId: "whatsapp-proof-message-1",
        responseId: "whatsapp-proof-response-1",
      });
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: "http://127.0.0.1:" + address.port,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}
