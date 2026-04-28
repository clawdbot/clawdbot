import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../src/gateway/client.js";
import { connectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  type ChatEventPayload,
  type GatewayInstance,
  connectNode,
  extractFirstTextBlock,
  postJson,
  spawnGatewayInstance,
  stopGatewayInstance,
  waitForChatFinalEvent,
  waitForNodeStatus,
} from "./helpers/gateway-e2e-harness.js";

const E2E_TIMEOUT_MS = 120_000;

describe("gateway multi-instance e2e", () => {
  const instances: GatewayInstance[] = [];
  const nodeClients: GatewayClient[] = [];
  const chatClients: GatewayClient[] = [];

  afterAll(async () => {
    for (const client of nodeClients) {
      client.stop();
    }
    for (const client of chatClients) {
      client.stop();
    }
    for (const inst of instances) {
      await stopGatewayInstance(inst);
    }
  });

  it(
    "spins up two gateways and exercises WS + HTTP + node pairing",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const [gwA, gwB] = await Promise.all([spawnGatewayInstance("a"), spawnGatewayInstance("b")]);
      instances.push(gwA, gwB);

      const [hookResA, hookResB] = await Promise.all([
        postJson(
          `http://127.0.0.1:${gwA.port}/hooks/wake`,
          {
            text: "wake a",
            mode: "now",
          },
          { "x-openclaw-token": gwA.hookToken },
        ),
        postJson(
          `http://127.0.0.1:${gwB.port}/hooks/wake`,
          {
            text: "wake b",
            mode: "now",
          },
          { "x-openclaw-token": gwB.hookToken },
        ),
      ]);
      expect(hookResA.status).toBe(200);
      expect((hookResA.json as { ok?: boolean } | undefined)?.ok).toBe(true);
      expect(hookResB.status).toBe(200);
      expect((hookResB.json as { ok?: boolean } | undefined)?.ok).toBe(true);

      const [nodeA, nodeB] = await Promise.all([
        connectNode(gwA, "node-a"),
        connectNode(gwB, "node-b"),
      ]);
      nodeClients.push(nodeA.client, nodeB.client);

      await Promise.all([
        waitForNodeStatus(gwA, nodeA.nodeId),
        waitForNodeStatus(gwB, nodeB.nodeId),
      ]);
    },
  );

  it(
    "delivers final chat event for telegram-shaped session keys",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const gw = await spawnGatewayInstance("chat-telegram-fixture");
      instances.push(gw);

      const chatEvents: ChatEventPayload[] = [];
      const chatClient = await connectGatewayClient({
        url: `ws://127.0.0.1:${gw.port}`,
        token: gw.gatewayToken,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        clientDisplayName: "chat-e2e-cli",
        clientVersion: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.CLI,
        onEvent: (evt) => {
          if (evt.event === "chat" && evt.payload && typeof evt.payload === "object") {
            chatEvents.push(evt.payload as ChatEventPayload);
          }
        },
      });
      chatClients.push(chatClient);

      const sessionKey = "agent:main:telegram:direct:123456";
      const idempotencyKey = `idem-${randomUUID()}`;
      const sendRes = await chatClient.request("chat.send", {
        sessionKey,
        message: "/whoami",
        idempotencyKey,
      });
      expect(sendRes.status).toBe("started");
      const runId = sendRes.runId;
      expect(typeof runId).toBe("string");

      const finalEvent = await waitForChatFinalEvent({
        events: chatEvents,
        runId: String(runId),
        sessionKey,
        timeoutMs: 90_000,
      });
      const finalText = extractFirstTextBlock(finalEvent.message);
      expect(typeof finalText).toBe("string");
      expect(finalText?.length).toBeGreaterThan(0);
    },
  );
});
