// Real gateway WebSocket coverage for canonical node chat subscriptions and reconnects.
import { describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import * as devicePairingNode from "../infra/device-pairing-node.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { describeWithGatewayServer } from "./server.node-pairing.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "./test-helpers.js";

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
      const disconnectHistoryPending = createDeferred();
      const recordDisconnection = devicePairingNode.recordPairedNodeDisconnection;
      const disconnectHistory = vi.spyOn(devicePairingNode, "recordPairedNodeDisconnection");
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

        disconnectHistory.mockImplementationOnce(async (params) => {
          await disconnectHistoryPending.promise;
          return recordDisconnection(params);
        });
        await first.stopAndWait();
        first = undefined;
        await vi.waitFor(() => expect(disconnectHistory).toHaveBeenCalledOnce());

        reconnected = await connectNode(reconnectEvents);
        await reconnected.request("node.event", {
          event: "chat.subscribe",
          payload: { sessionKey: "  MAIN  " },
        });
        emitCompletedSessionRun("canonical-node-reconnect", "agent:main:main");
        await expectNodeChatEvent(reconnectEvents, "canonical-node-reconnect", "agent:main:main");

        // Completing the old connection's history must not retire its replacement's observer.
        disconnectHistoryPending.resolve();
        await disconnectHistory.mock.results[0]?.value;
        emitCompletedSessionRun("canonical-node-after-disconnect-history", "agent:main:main");
        await expectNodeChatEvent(
          reconnectEvents,
          "canonical-node-after-disconnect-history",
          "agent:main:main",
        );

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
        disconnectHistoryPending.resolve();
        await disconnectHistory.mock.results[0]?.value;
        disconnectHistory.mockRestore();
        await first?.stopAndWait();
        await reconnected?.stopAndWait();
      }
    });

    test("delivers final and error terminals through one canonical node subscription", async () => {
      const paired = await pairDeviceIdentity({
        name: "canonical-chat-terminal-fanout",
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
      await approveNodePairing(pairing.request.requestId, {
        callerScopes: ["operator.pairing", "operator.write", "operator.admin"],
      });

      const events: ReceivedNodeEvent[] = [];
      let node: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      let operator: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      const terminalPayloads = (runId: string) =>
        events
          .filter(
            (event) =>
              event.event === "chat" &&
              (event.payload as { runId?: string } | undefined)?.runId === runId,
          )
          .map((event) => event.payload as Record<string, unknown>);

      try {
        node = await connectGatewayClient({
          url: `ws://127.0.0.1:${getStarted().port}`,
          token: "secret",
          role: "node",
          clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
          clientDisplayName: "canonical terminal fanout node",
          clientVersion: "1.0.0",
          platform: "macos",
          deviceFamily: "Mac",
          mode: GATEWAY_CLIENT_MODES.NODE,
          scopes: [],
          commands: [],
          deviceIdentity: paired.identity,
          onEvent: (event) => events.push(event),
        });
        operator = await connectGatewayClient({
          url: `ws://127.0.0.1:${getStarted().port}`,
          token: "secret",
          role: "operator",
          scopes: ["operator.write"],
        });
        await node.request("node.event", {
          event: "chat.subscribe",
          payload: { sessionKey: " Main " },
        });

        dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
          const [params] = args as [
            {
              dispatcher: {
                sendFinalReply: (payload: { text: string }) => boolean;
                markComplete: () => void;
                waitForIdle: () => Promise<void>;
                getQueuedCounts: () => { final: number; block: number; tool: number };
              };
            },
          ];
          params.dispatcher.sendFinalReply({ text: "node subscription final" });
          params.dispatcher.markComplete();
          await params.dispatcher.waitForIdle();
          return { queuedFinal: true, counts: params.dispatcher.getQueuedCounts() };
        });
        const finalRunId = "canonical-node-terminal-final";
        const finalStarted = await operator.request<{ runId: string; status: string }>(
          "chat.send",
          {
            sessionKey: "main",
            message: "deliver a final terminal",
            idempotencyKey: finalRunId,
          },
        );
        expect(finalStarted).toMatchObject({ runId: finalRunId, status: "started" });
        await vi.waitFor(() => expect(terminalPayloads(finalRunId)).toHaveLength(1));
        expect(terminalPayloads(finalRunId)[0]).toMatchObject({
          runId: finalRunId,
          sessionKey: "agent:main:main",
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "node subscription final" }],
          },
        });

        const errorRunId = "canonical-node-terminal-error";
        dispatchInboundMessageMock.mockRejectedValueOnce(new Error("node dispatch rejected"));
        const errorStarted = await operator.request<{ runId: string; status: string }>(
          "chat.send",
          {
            sessionKey: "main",
            message: "deliver an error terminal",
            idempotencyKey: errorRunId,
          },
        );
        expect(errorStarted).toMatchObject({ runId: errorRunId, status: "started" });
        await vi.waitFor(() => expect(terminalPayloads(errorRunId)).toHaveLength(1));
        await node.request("node.event", {
          event: "chat.subscribe",
          payload: { sessionKey: "main" },
        });

        expect(terminalPayloads(finalRunId)).toHaveLength(1);
        expect(terminalPayloads(errorRunId)).toHaveLength(1);
        const errorPayload = terminalPayloads(errorRunId)[0];
        if (!errorPayload) {
          throw new Error("expected the node error terminal");
        }
        expect(errorPayload).toMatchObject({
          runId: errorRunId,
          sessionKey: "agent:main:main",
          state: "error",
        });
        expect(errorPayload.errorMessage).toContain("node dispatch rejected");
        expect(errorPayload).not.toHaveProperty("message");
      } finally {
        dispatchInboundMessageMock.mockReset();
        await operator?.stopAndWait();
        await node?.stopAndWait();
      }
    });
  });
});
