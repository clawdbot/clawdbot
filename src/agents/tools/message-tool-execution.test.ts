import { describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import { createMessageTool } from "./message-tool-execution.js";

const EMPTY_CATALOG = {
  version: 0,
  channels: [],
  getChannel: () => undefined,
} as const;

function createFailingMessageTool(error: Error) {
  const runMessageAction = vi.fn(async () => {
    throw error;
  });
  const tool = createMessageTool({
    config: {},
    runId: "run-queued-delivery",
    preparedMessageToolCatalog: EMPTY_CATALOG,
    sourceReplyOnly: true,
    sourceReplyDeliveryMode: "message_tool_only",
    currentChannelProvider: "telegram",
    currentChannelId: "chat-123",
    currentMessagingTarget: "chat-123",
    getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
    resolveCommandSecretRefsViaGateway: async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }),
    runMessageAction,
  });
  return { tool, runMessageAction };
}

function sentIdempotencyKey(runMessageAction: ReturnType<typeof vi.fn>, call: number) {
  const request = runMessageAction.mock.calls[call]?.[0] as
    | { params?: { idempotencyKey?: string } }
    | undefined;
  return request?.params?.idempotencyKey;
}

describe("message tool queued gateway delivery", () => {
  it("returns a do-not-resend result when the gateway owns the retry", async () => {
    const { tool, runMessageAction } = createFailingMessageTool(
      new GatewayClientRequestError({
        code: ErrorCodes.UNAVAILABLE,
        message: "connect ECONNREFUSED",
        details: { code: GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED },
      }),
    );

    const result = await tool.execute("queued-send", { action: "send", message: "hello" });

    expect(result).toMatchObject({
      details: {
        status: "delivery_queued",
        delivered: false,
        message:
          "Delivery is pending: connect ECONNREFUSED. The gateway owns retry or reconciliation; delivery is not yet confirmed. Do not resend it.",
      },
    });

    // A model that resends anyway must reuse the queued key so the gateway's
    // idempotency cache answers instead of a second durable send.
    await tool.execute("queued-send-again", { action: "send", message: "hello" });
    expect(sentIdempotencyKey(runMessageAction, 0)).toBeDefined();
    expect(sentIdempotencyKey(runMessageAction, 1)).toBe(sentIdempotencyKey(runMessageAction, 0));
  });

  it("keeps an unstructured unavailable error throwable", async () => {
    const error = new GatewayClientRequestError({
      code: ErrorCodes.UNAVAILABLE,
      message: "connect ECONNREFUSED",
    });
    const { tool } = createFailingMessageTool(error);

    await expect(
      tool.execute("ordinary-failure", { action: "send", message: "hello" }),
    ).rejects.toBe(error);
  });
});

describe("message tool prompt-cache contract", () => {
  it.each([false, true])(
    "preserves the serialized definition across delivery modes with sourceReplyOnly=%s",
    (sourceReplyOnly) => {
      const definitions = (["automatic", "message_tool_only", "automatic"] as const).map(
        (sourceReplyDeliveryMode) => {
          const tool = createMessageTool({
            config: {},
            preparedMessageToolCatalog: EMPTY_CATALOG,
            currentChannelProvider: "telegram",
            sourceReplyOnly,
            sourceReplyDeliveryMode,
          });
          return JSON.stringify({ description: tool.description, parameters: tool.parameters });
        },
      );

      expect(definitions[1]).toBe(definitions[0]);
      expect(definitions[2]).toBe(definitions[0]);
    },
  );
});
