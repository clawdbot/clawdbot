import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  testing as sessionBindingTesting,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMatrixConversationRouteOwner } from "./conversation-route-owner.js";

describe("resolveMatrixConversationRouteOwner", () => {
  let adapter: SessionBindingAdapter;

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
              createManager: () => ({ stop: () => undefined }),
            },
          },
        },
      ]),
    );
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    adapter = {
      channel: "matrix",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => ({
        bindingId: "binding-room",
        targetSessionKey: "agent:finance:bound",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1,
      }),
    };
    registerSessionBindingAdapter(adapter);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("uses the native DM room and a channel peer's canonical room identity", () => {
    expect(
      resolveMatrixConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: {
          kind: "direct",
          peerId: "@alice:example.org",
          nativeChannelId: "!dm:example.org",
        },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    expect(
      resolveMatrixConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "!room:example.org" },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
  });

  it("reports temporary binding-store unavailability", () => {
    unregisterSessionBindingAdapter({ channel: "matrix", accountId: "default", adapter });

    expect(
      resolveMatrixConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "!room:example.org" },
      }),
    ).toEqual({ kind: "unavailable" });
  });
});
