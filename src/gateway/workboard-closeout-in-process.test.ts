// Proves the bundled Workboard closeout adapter reaches the real in-process Gateway router
// without opening a socket or sending a live transport message.
import { describe, expect, it, vi } from "vitest";
import { createRuntimeConversationSend } from "../../extensions/workboard/runtime-api.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const runGatewayConversationSend = vi.hoisted(() =>
  vi.fn(async () => ({
    status: "sent" as const,
    conversationRef: "conv_0123456789abcdef0123456789abcdef",
    channel: "telegram",
    messageId: "telegram-receipt-123",
    queueId: "closeout:NAC-78:1000",
  })),
);

vi.mock("./conversation-send.js", () => ({ runGatewayConversationSend }));

function gatewayContext(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
}

describe("Workboard closeout in-process Gateway path", () => {
  it("routes conversations.send through the authenticated Gateway handler", async () => {
    const send = createRuntimeConversationSend(createPluginRuntime());
    const params = {
      agentId: "main",
      sourceSessionKey: "agent:main:telegram:direct:operator",
      operationId: "closeout:NAC-78:1000",
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
      message: "NAC-78 is complete.",
    };

    const result = await withPluginRuntimeGatewayRequestScope(
      { context: gatewayContext(), isWebchatConnect: () => false },
      async () =>
        await withPluginRuntimePluginScope(
          { pluginId: "workboard", pluginOrigin: "bundled" },
          async () => await send(params),
        ),
    );

    expect(result).toEqual({
      status: "sent",
      conversationRef: params.conversationRef,
      channel: "telegram",
      messageId: "telegram-receipt-123",
      queueId: params.operationId,
    });
    expect(runGatewayConversationSend).toHaveBeenCalledOnce();
    expect(runGatewayConversationSend).toHaveBeenCalledWith(
      expect.objectContaining({
        ...params,
        senderIsOwner: true,
      }),
    );
  });
});
