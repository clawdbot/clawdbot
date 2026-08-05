// Real gateway WebSocket coverage for canonical node chat subscriptions and reconnects.
import { describe, expect, test, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { approveNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { describeWithGatewayServer } from "./server.node-pairing.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type ReceivedNodeEvent = { event?: string; payload?: unknown };

function emitCompletedSessionRun(runId: string, sessionKey: string): void {
  registerAgentRunContext(runId, { sessionKey, agentId: "main" });
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", startedAt: 1, endedAt: 2 },
  });
}

async function expectNodeChatEvent(events: ReceivedNodeEvent[], runId: string, sessionKey: string) {
  await vi.waitFor(
    () => {
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "chat",
          payload: expect.objectContaining({ runId, sessionKey, state: "final" }),
        }),
      );
    },
    { interval: 10, timeout: 5_000 },
  );
}

describe("gateway node chat subscriptions", () => {
  describeWithGatewayServer("real WebSocket session fanout", (getStarted) => {
    test("delivers canonical chat events across reconnect and stops after an alias unsubscribe", async () => {
      const paired = await pairDeviceIdentity({
        name: "canonical-chat-subscription-reconnect",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const pairing = await requestNodePairing({
        nodeId: paired.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: [],
      });
      const approved = await approveNodePairing(pairing.request.requestId, {
        callerScopes: ["operator.pairing", "operator.write", "operator.admin"],
      });
      expect(approved).toMatchObject({ node: { nodeId: paired.identity.deviceId } });

      const firstEvents: ReceivedNodeEvent[] = [];
      const reconnectEvents: ReceivedNodeEvent[] = [];
      let first: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      let reconnected: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      const connectNode = (events: ReceivedNodeEvent[]) =>
        connectGatewayClient({
          url: `ws://127.0.0.1:${getStarted().port}`,
          token: "secret",
          role: "node",
          clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
          clientDisplayName: "canonical chat subscription node",
          clientVersion: "1.0.0",
          platform: "macos",
          deviceFamily: "Mac",
          mode: GATEWAY_CLIENT_MODES.NODE,
          scopes: [],
          commands: [],
          deviceIdentity: paired.identity,
          onEvent: (event) => events.push(event),
        });

      try {
        first = await connectNode(firstEvents);
        await first.request("node.event", {
          event: "chat.subscribe",
          payload: { sessionKey: "  Main  " },
        });
        emitCompletedSessionRun("canonical-node-first", "agent:main:main");
        await expectNodeChatEvent(firstEvents, "canonical-node-first", "agent:main:main");

        await first.stopAndWait();
        first = undefined;

        reconnected = await connectNode(reconnectEvents);
        await reconnected.request("node.event", {
          event: "chat.subscribe",
          payload: { sessionKey: "  MAIN  " },
        });
        emitCompletedSessionRun("canonical-node-reconnect", "agent:main:main");
        await expectNodeChatEvent(reconnectEvents, "canonical-node-reconnect", "agent:main:main");

        await reconnected.request("node.event", {
          event: "chat.subscribe",
          payload: { sessionKey: "other" },
        });
        await reconnected.request("node.event", {
          event: "chat.unsubscribe",
          payload: { sessionKey: "  Main  " },
        });

        // The other subscribed session is an ordered live-transport barrier:
        // receiving its event proves the unsubscribed main event was not queued.
        emitCompletedSessionRun("canonical-node-unsubscribed", "agent:main:main");
        emitCompletedSessionRun("canonical-node-other", "agent:main:other");
        await expectNodeChatEvent(reconnectEvents, "canonical-node-other", "agent:main:other");
        expect(reconnectEvents).not.toContainEqual(
          expect.objectContaining({
            event: "chat",
            payload: expect.objectContaining({ runId: "canonical-node-unsubscribed" }),
          }),
        );
        expect(firstEvents).not.toContainEqual(
          expect.objectContaining({
            event: "chat",
            payload: expect.objectContaining({ runId: "canonical-node-reconnect" }),
          }),
        );
      } finally {
        await first?.stopAndWait();
        await reconnected?.stopAndWait();
      }
    });
  });
});
