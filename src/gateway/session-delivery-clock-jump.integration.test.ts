import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.js";
import { scheduleSessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  loadPendingSessionDeliveries,
  releaseSessionDeliveryClaim,
  SESSION_DELIVERY_QUEUE_NAME,
} from "../infra/session-delivery-queue-storage.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Keep the real delivery scheduler, but disable optional idle cache work that
// can retain admissions after this fixture closes its Gateway.
vi.mock("./server-idle-task.js", () => ({
  scheduleGatewayIdleTask: () => ({ stop: vi.fn() }),
}));

async function startProofProvider(requests: string[]): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(body);
      const events = [
        {
          type: "response.output_item.added",
          item: {
            type: "message",
            id: "clock-jump-message",
            role: "assistant",
            content: [],
            status: "in_progress",
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "clock-jump-message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "CLOCK_JUMP DELIVERED", annotations: [] }],
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function closeProofProvider(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(() => {
  resetGatewayTestState();
  vi.restoreAllMocks();
});

describe("session delivery clock-jump integration", () => {
  it(
    "delivers and settles a released claim through a real Gateway client",
    { timeout: 90_000 },
    async () => {
      const initialTime = Date.now();
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(initialTime);
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
        prefix: "openclaw-session-delivery-gateway-",
      });
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let providerServer: http.Server | undefined;
      let deliveryId = "";
      const providerRequests: string[] = [];

      try {
        providerServer = await startProofProvider(providerRequests);
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
        );
        const token = "clock-jump-proof-token";
        const configPath = await createGatewayConfigPath(tempHome);
        const sessionKey = "agent:main:clock-jump-proof";
        const chatEvents: string[] = [];
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
            entries: { main: { default: true } },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: {
                ...provider.config,
                request: { allowPrivateNetwork: true },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
        } satisfies OpenClawConfig;
        const { id } = await enqueueClaimedSessionDelivery(
          {
            kind: "agentTurn",
            sessionKey,
            message: "Reply with the clock-jump proof marker.",
            messageId: "image:clock-jump:agent-loop",
            idempotencyKey: "image:clock-jump:agent-loop",
            route: { channel: "webchat", to: sessionKey, chatType: "direct" },
            inputProvenance: {
              kind: "inter_session",
              sourceChannel: "webchat",
              sourceTool: "image_generate",
            },
            sourceReplyDeliveryMode: "automatic",
          },
          60_000,
        );

        deliveryId = id;
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
          onEvent: (event) => {
            if (event.event !== "chat") {
              return;
            }
            chatEvents.push(JSON.stringify(event.payload ?? {}));
          },
        });
        await gateway.server.startupSettled;
        await gateway.client.request("sessions.messages.subscribe", { key: sessionKey });
        await expect
          .poll(() => scheduleSessionDelivery(id), { timeout: 10_000, interval: 50 })
          .toBe(true);

        wallClock.mockReturnValue(initialTime + 24 * 60 * 60 * 1_000);
        await releaseSessionDeliveryClaim(id);
        await scheduleSessionDelivery(id);

        await vi.waitFor(
          async () => expect(await loadPendingSessionDeliveries()).toStrictEqual([]),
          { timeout: 15_000, interval: 50 },
        );
        expect(providerRequests).toHaveLength(1);
        expect(providerRequests[0]).toContain("clock-jump proof marker");
        expect(chatEvents.join("\n")).toContain("CLOCK_JUMP DELIVERED");
        expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
        expect(getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id)).toBe("completed");
      } finally {
        wallClock.mockRestore();
        try {
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              await gateway.server.close({ reason: "session delivery clock-jump proof complete" });
              await expect(scheduleSessionDelivery(deliveryId)).resolves.toBe(false);
            }
          }
        } finally {
          try {
            if (providerServer) {
              await closeProofProvider(providerServer);
            }
          } finally {
            try {
              await removeGatewayTempHome(tempHome);
            } finally {
              envSnapshot.restore();
            }
          }
        }
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );
});
