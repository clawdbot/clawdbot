// Route projection tests cover channel target projection from routes and conversation bindings.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { formatConversationTarget, deliveryContextFromConversation } from "./route-projection.js";

describe("channel route projection", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "room-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "room-chat", label: "Room chat" }),
            messaging: {
              resolveDeliveryTarget: ({
                conversationId,
                parentConversationId,
              }: {
                conversationId: string;
                parentConversationId?: string;
              }) =>
                conversationId.startsWith("$")
                  ? {
                      to: parentConversationId ? `room:${parentConversationId}` : undefined,
                      threadId: conversationId,
                    }
                  : {
                      to: `room:${conversationId}`,
                    },
            },
          },
        },
        {
          pluginId: "thread-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "thread-chat", label: "Thread chat" }),
            messaging: {
              resolveDeliveryTarget: ({
                conversationId,
                parentConversationId,
              }: {
                conversationId: string;
                parentConversationId?: string;
              }) => {
                const parent = parentConversationId?.trim();
                const child = conversationId.trim();
                return parent && parent !== child
                  ? { to: `channel:${parent}`, threadId: child }
                  : { to: `channel:${child}` };
              },
            },
          },
        },
        {
          pluginId: "unroutable-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "unroutable-chat",
              label: "Unroutable chat",
            }),
            messaging: {
              resolveDeliveryTarget: () => null,
            },
          },
        },
      ]),
    );
  });

  it("formats plugin-defined conversation targets via channel messaging hooks", () => {
    expect(
      formatConversationTarget({ channel: "room-chat", conversationId: "!room:example" }),
    ).toBe("room:!room:example");
    expect(
      formatConversationTarget({
        channel: "room-chat",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toBe("room:!room:example");
    expect(
      formatConversationTarget({ channel: "room-chat", conversationId: "  " }),
    ).toBeUndefined();
  });

  it("projects parent-child conversation refs through plugin delivery targets", () => {
    expect(
      deliveryContextFromConversation({
        channel: "thread-chat",
        accountId: "default",
        conversationId: "thread-1",
        parentConversationId: "room-1",
      }),
    ).toEqual({
      channel: "thread-chat",
      accountId: "default",
      to: "channel:room-1",
      threadId: "thread-1",
    });
  });

  it("falls back to generic channel targets when a plugin has no target projection", () => {
    expect(
      deliveryContextFromConversation({
        channel: "unroutable-chat",
        accountId: "default",
        conversationId: "room-1",
      }),
    ).toEqual({
      channel: "unroutable-chat",
      accountId: "default",
      to: "channel:room-1",
    });
  });

  it("preserves thread-only plugin results while formatting can supply a target fallback", () => {
    const conversation = {
      channel: "room-chat",
      accountId: "work",
      conversationId: "$thread",
    };
    expect(deliveryContextFromConversation(conversation)).toEqual({
      channel: "room-chat",
      accountId: "work",
      to: undefined,
      threadId: "$thread",
    });
    expect(formatConversationTarget(conversation)).toBe("channel:$thread");
  });
});
