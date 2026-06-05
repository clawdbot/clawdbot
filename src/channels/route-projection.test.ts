// Route projection tests cover channel target projection from routes and conversation bindings.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  deliveryContextFromRoute,
  normalizeRoutableChannelRoute,
  routeFromBindingRecord,
  routeFromConversationRef,
  routeFromDeliveryContext,
  routeFromSessionEntry,
  routeToDeliveryFields,
  routesShareDeliveryTarget,
} from "./route-projection.js";

describe("channel route projection", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
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

  it("round-trips delivery context through channel route metadata", () => {
    const route = routeFromDeliveryContext({
      channel: " Slack ",
      to: " channel:C123 ",
      accountId: " work ",
      threadId: " 177000.123 ",
    });

    expect(route).toEqual({
      channel: "slack",
      accountId: "work",
      target: { to: "channel:C123" },
      thread: { id: "177000.123" },
    });
    expect(deliveryContextFromRoute(route)).toEqual({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadId: "177000.123",
    });
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

  it("uses session route before legacy last route fields", () => {
    expect(
      routeFromSessionEntry({
        sessionId: "sess-1",
        updatedAt: 1,
        route: {
          channel: "slack",
          target: { to: "channel:C123" },
          thread: { id: "177000.123" },
        },
        deliveryContext: {
          channel: "discord",
          to: "channel:old",
          threadId: "old-thread",
        },
        lastChannel: "discord",
        lastTo: "channel:older",
      }),
    ).toEqual({
      channel: "slack",
      target: { to: "channel:C123" },
      thread: { id: "177000.123" },
    });
  });

  it("narrows only routable routes and compares delivery targets", () => {
    expect(normalizeRoutableChannelRoute({ channel: "slack" })).toBeUndefined();
    expect(
      routesShareDeliveryTarget({
        left: { channel: "slack", target: { to: "channel:C123" } },
        right: {
          channel: "slack",
          accountId: "work",
          target: { to: "channel:C123" },
        },
      }),
    ).toBe(true);
    expect(
      routesShareDeliveryTarget({
        left: {
          channel: "slack",
          target: { to: "channel:C123" },
          thread: { id: "thread-a" },
        },
        right: {
          channel: "slack",
          target: { to: "channel:C123" },
          thread: { id: "thread-b" },
        },
      }),
    ).toBe(false);
  });
});
