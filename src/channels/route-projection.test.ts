// Route projection tests cover channel target projection from routes and conversation bindings.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  formatConversationTarget,
  routeFromBindingRecord,
  routeFromConversationRef,
  routeToDeliveryFields,
} from "./route-projection.js";

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
      routeFromConversationRef({
        channel: "thread-chat",
        accountId: "default",
        conversationId: "thread-1",
        parentConversationId: "room-1",
      }),
    ).toEqual({
      channel: "thread-chat",
      accountId: "default",
      target: { to: "channel:room-1" },
      thread: { id: "thread-1", source: "target" },
    });
  });

  it("falls back to generic channel targets when a plugin has no target projection", () => {
    expect(
      routeFromConversationRef({
        channel: "unroutable-chat",
        accountId: "default",
        conversationId: "room-1",
      }),
    ).toEqual({
      channel: "unroutable-chat",
      accountId: "default",
      target: { to: "channel:room-1" },
    });
  });

  it("projects session binding records without duplicating hook delivery origin logic", () => {
    const route = routeFromBindingRecord({
      bindingId: "binding-1",
      targetKind: "subagent",
      targetSessionKey: "agent:worker:main",
      status: "active",
      boundAt: 1,
      conversation: {
        channel: "thread-chat",
        accountId: "work",
        conversationId: "thread-1",
        parentConversationId: "room-1",
      },
    });

    expect(routeToDeliveryFields(route)).toEqual({
      deliveryContext: {
        channel: "thread-chat",
        to: "channel:room-1",
        accountId: "work",
        threadId: "thread-1",
      },
      channel: "thread-chat",
      to: "channel:room-1",
      accountId: "work",
      threadId: "thread-1",
    });
  });
});
