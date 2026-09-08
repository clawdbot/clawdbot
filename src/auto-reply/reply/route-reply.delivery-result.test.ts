// Tests routeReply delivery evidence and editable message identity.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

const { routeReply: routeReplyRuntime } = await import("./route-reply.js");
type RouteReplyParams = Parameters<typeof routeReplyRuntime>[0];
const routeReply = (
  params: Omit<RouteReplyParams, "replyKind"> & { replyKind?: RouteReplyParams["replyKind"] },
) => routeReplyRuntime({ replyKind: "final", ...params });

function createChannelPlugin(id: ChannelPlugin["id"], label: string): ChannelPlugin {
  return createChannelTestPluginBase({
    id,
    label,
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  });
}

describe("routeReply delivery result", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createChannelPlugin("telegram", "Telegram"),
          source: "test",
        },
        {
          pluginId: "whatsapp",
          plugin: createChannelPlugin("whatsapp", "WhatsApp"),
          source: "test",
        },
      ]),
    );
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it.each([
    "cancelled_by_message_sending_hook",
    "empty_after_message_sending_hook",
    "adapter_returned_no_send",
  ] as const)(
    "returns intentional suppression reason %s without claiming delivery",
    async (reason) => {
      mocks.deliverOutboundPayloads.mockImplementationOnce(
        async ({
          onPayloadDeliveryOutcome,
        }: {
          onPayloadDeliveryOutcome?: (outcome: unknown) => void;
        }) => {
          onPayloadDeliveryOutcome?.({
            index: 0,
            status: "suppressed",
            reason,
          });
          return [];
        },
      );

      const res = await routeReply({
        payload: { text: "hello" },
        channel: "telegram",
        to: "chat-1",
        cfg: {} as never,
      });

      expect(res).toEqual({
        ok: true,
        delivered: false,
        suppressed: true,
        reason,
      });
    },
  );

  it("treats a send without adapter identity as ambiguous and non-retryable", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async ({
        onPayloadDeliveryOutcome,
      }: {
        onPayloadDeliveryOutcome?: (outcome: unknown) => void;
      }) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "adapter_returned_no_identity",
        });
        return [];
      },
    );

    const res = await routeReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
      cfg: {} as never,
    });

    expect(res).toEqual({
      ok: true,
      delivered: false,
      ambiguous: true,
      reason: "adapter_returned_no_identity",
    });
  });

  it("preserves session writer authority through route normalization", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValueOnce([
      { channel: "telegram", messageId: "message-1" },
    ]);
    const authority = {
      expectedLifecycleRevision: "revision-a",
      expectedSessionId: "session-1",
      expectedWriterRunId: "run-a",
      sessionKey: "agent:main:telegram:direct:1",
      storePath: "/tmp/sessions.json",
    };

    await routeReply({
      payload: setReplyPayloadMetadata(
        { text: "hello" },
        { sessionWriterDeliveryAuthority: authority },
      ),
      channel: "telegram",
      to: "chat-1",
      cfg: {} as never,
    });

    const call = mocks.deliverOutboundPayloads.mock.calls[0];
    if (!call) {
      throw new Error("expected routed delivery");
    }
    const sentPayload = (call[0] as { payloads: object[] }).payloads[0]!;
    expect(getReplyPayloadMetadata(sentPayload)?.sessionWriterDeliveryAuthority).toEqual(authority);
  });

  it("preserves the last delivered message id when a later send fails", async () => {
    const cause = new Error("network reset");
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(
      new OutboundDeliveryError("network reset", {
        cause,
        results: [{ channel: "telegram", messageId: "msg-1" }],
        stage: "platform_send",
      }),
    );

    const res = await routeReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
      cfg: {} as never,
    });

    expect(res).toEqual({
      ok: false,
      delivered: true,
      error: "Failed to route reply to telegram: network reset",
      messageId: "msg-1",
    });
  });

  it.each([
    ["a trailing suppression sentinel", { channel: "telegram", messageId: "suppressed" }],
    ["a trailing unknown sentinel", { channel: "telegram", messageId: "unknown" }],
    ["a trailing ok sentinel", { channel: "telegram", messageId: "ok" }],
    ["a trailing no-id receipt", { channel: "telegram", messageId: "" }],
  ])("preserves an earlier editable message id after %s", async (_label, trailingResult) => {
    const cause = new Error("network reset");
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(
      new OutboundDeliveryError("network reset", {
        cause,
        results: [{ channel: "telegram", messageId: "msg-1" }, trailingResult],
        stage: "platform_send",
      }),
    );

    const res = await routeReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
      cfg: {} as never,
    });

    expect(res).toEqual({
      ok: false,
      delivered: true,
      error: "Failed to route reply to telegram: network reset",
      messageId: "msg-1",
    });
  });

  it.each([
    ["skipped", false, undefined],
    ["suppressed", false, undefined],
    ["unknown", true, undefined],
    ["ok", true, undefined],
  ] as const)(
    "reports message id %s visibility as %s",
    async (messageId, delivered, returnedId) => {
      mocks.deliverOutboundPayloads.mockResolvedValueOnce([{ channel: "telegram", messageId }]);

      const res = await routeReply({
        payload: { text: "hello" },
        channel: "telegram",
        to: "chat-1",
        cfg: {} as never,
      });

      expect(res).toEqual({
        ok: true,
        delivered,
        ...(returnedId === undefined ? {} : { messageId: returnedId }),
      });
    },
  );
});
