import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  validateConversationListParams,
  validateUiCommandParams,
  type ConversationListParams,
  type GatewayCoreRequestParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

describe("typed gateway method validation", () => {
  it("binds core method names to their schema-derived payloads", async () => {
    expectTypeOf<
      GatewayCoreRequestParams["conversations.list"]
    >().toEqualTypeOf<ConversationListParams>();

    expectTypeOf(validateConversationListParams).toMatchTypeOf<
      Parameters<typeof defineValidatedGatewayMethod<"conversations.list">>[1]
    >();
    expectTypeOf(validateUiCommandParams).not.toMatchTypeOf<
      Parameters<typeof defineValidatedGatewayMethod<"conversations.list">>[1]
    >();

    const respond = vi.fn<RespondFn>();
    const handler = defineValidatedGatewayMethod(
      "conversations.list",
      validateConversationListParams,
      ({ params, respond: reply }) => {
        expectTypeOf(params).toEqualTypeOf<ConversationListParams>();
        reply(true, { agentId: params.agentId, limit: params.limit });
      },
    );
    const options: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "typed-1", method: "conversations.list" },
      params: { agentId: "main", limit: 5 },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestContext,
    };

    await handler(options);

    expect(respond).toHaveBeenCalledWith(true, { agentId: "main", limit: 5 });
  });

  it("rejects malformed payloads before invoking the typed handler", async () => {
    const action = vi.fn();
    const respond = vi.fn<RespondFn>();
    const handler = defineValidatedGatewayMethod(
      "conversations.list",
      validateConversationListParams,
      action,
    );

    await handler({
      req: { type: "req", id: "typed-2", method: "conversations.list" },
      params: { agentId: "main", limit: "five" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestContext,
    });

    expect(action).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("invalid conversations.list params"),
      }),
    );
  });
});
