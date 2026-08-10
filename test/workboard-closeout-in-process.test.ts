// Proves the bundled Workboard closeout adapter reaches the real in-process Gateway router
// without opening a socket or sending a live transport message.
import { describe, expect, it, vi } from "vitest";
import { createRuntimeConversationSend } from "../extensions/workboard/src/closeout-tool.js";
import {
  createCloseoutTracker,
  type CloseoutRecord,
  type CloseoutTrackerStore,
} from "../extensions/workboard/src/closeout-tracker.js";
import type { GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../src/plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";

const runGatewayConversationSend = vi.hoisted(() => vi.fn());

vi.mock("../src/gateway/conversation-send.js", () => ({ runGatewayConversationSend }));

function gatewayContext(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
}

function memoryStore(): CloseoutTrackerStore {
  const records = new Map<string, CloseoutRecord>();
  const key = (agentId: string, closeoutId: string) => JSON.stringify([agentId, closeoutId]);
  return {
    async get(agentId, closeoutId) {
      return records.get(key(agentId, closeoutId));
    },
    async create(record) {
      const recordKey = key(record.agentId, record.closeoutId);
      if (records.has(recordKey)) {
        return false;
      }
      records.set(recordKey, structuredClone(record));
      return true;
    },
    async put(record) {
      records.set(key(record.agentId, record.closeoutId), structuredClone(record));
    },
    async list(agentId, limit) {
      return [...records.values()].filter((record) => record.agentId === agentId).slice(0, limit);
    },
  };
}

async function sendCloseout(closeoutId: string) {
  const tracker = createCloseoutTracker({
    store: memoryStore(),
    send: createRuntimeConversationSend(createPluginRuntime()),
    now: () => 1_000,
  });
  return await withPluginRuntimeGatewayRequestScope(
    { context: gatewayContext(), isWebchatConnect: () => false },
    async () =>
      await withPluginRuntimePluginScope(
        { pluginId: "workboard", pluginOrigin: "bundled" },
        async () =>
          await tracker.send({
            agentId: "main",
            closeoutId,
            sourceSessionKey: "agent:main:telegram:direct:operator",
            conversationRef: "conv_0123456789abcdef0123456789abcdef",
            message: "Work is complete.",
          }),
      ),
  );
}

describe("Workboard closeout in-process Gateway path", () => {
  it("confirms platform receipts and keeps prepared ids uncertain", async () => {
    runGatewayConversationSend
      .mockResolvedValueOnce({
        status: "sent",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        channel: "telegram",
        messageId: "telegram-receipt-123",
        messageIdSource: "platform",
        queueId: "closeout:platform-case:1000:1",
      })
      .mockResolvedValueOnce({
        status: "sent",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        channel: "telegram",
        messageId: "prepared-local-id",
        messageIdSource: "prepared",
        queueId: "closeout:prepared-case:1000:1",
      });

    const platform = await sendCloseout("platform-case");
    const prepared = await sendCloseout("prepared-case");

    expect(platform).toMatchObject({
      status: "confirmed",
      messageId: "telegram-receipt-123",
      messageIdSource: "platform",
      operationId: "closeout:platform-case:1000:1",
    });
    expect(prepared).toMatchObject({
      status: "uncertain",
      messageId: "prepared-local-id",
      messageIdSource: "prepared",
      operationId: "closeout:prepared-case:1000:1",
      lastError: "delivery reported sent without a platform receipt",
    });
    expect(runGatewayConversationSend).toHaveBeenCalledTimes(2);
    for (const closeoutId of ["platform-case", "prepared-case"]) {
      expect(runGatewayConversationSend).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: `closeout:${closeoutId}:1000:1`,
          senderIsOwner: true,
        }),
      );
    }
  });
});
