// Feishu tests cover current subagent delivery and cleanup hooks.
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it } from "vitest";
import type { ClawdbotConfig, OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuSubagentHooks } from "../subagent-hooks-api.js";
import { createFeishuThreadBindingManager as createFeishuThreadBindingManagerImpl } from "./thread-bindings.js";

const baseConfig: ClawdbotConfig = {
  session: { mainKey: "main", scope: "per-sender" },
  channels: { feishu: {} },
};

type FeishuThreadBindingManager = ReturnType<typeof createFeishuThreadBindingManagerImpl>;
let trackedManager: FeishuThreadBindingManager | null = null;

function createFeishuThreadBindingManager(): FeishuThreadBindingManager {
  trackedManager = createFeishuThreadBindingManagerImpl({ cfg: baseConfig, accountId: "work" });
  return trackedManager;
}

function registerHandlersForTest() {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config: baseConfig,
    register: registerFeishuSubagentHooks,
  });
}

function dmOrigin(sender = "ou_sender_1") {
  return {
    channel: "feishu" as const,
    accountId: "work",
    to: `user:${sender}`,
  };
}

type FeishuOrigin = {
  channel: string;
  accountId?: string;
  to?: string;
  threadId?: string;
};

function deliveryEvent(params: {
  childSessionKey: string;
  requesterOrigin?: FeishuOrigin;
  requesterSessionKey?: string;
}) {
  return {
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey ?? "agent:main:main",
    requesterOrigin: params.requesterOrigin ?? dmOrigin(),
    expectsCompletionMessage: true,
  };
}

function managedHookFixture() {
  const handlers = registerHandlersForTest();
  return {
    deliveryHandler: getRequiredHookHandler(handlers, "subagent_delivery_target"),
    endedHandler: getRequiredHookHandler(handlers, "subagent_ended"),
    manager: createFeishuThreadBindingManager(),
  };
}

describe("feishu subagent hook handlers", () => {
  afterEach(() => {
    trackedManager?.stop();
    trackedManager = null;
  });

  it("preserves the bound Feishu DM delivery target", async () => {
    const { deliveryHandler, manager } = managedHookFixture();
    manager.bindConversation({
      conversationId: "ou_sender_1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:chat-dm-child",
      metadata: { deliveryTo: "chat:oc_dm_chat_1", boundBy: "system" },
    });

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:chat-dm-child",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_dm_chat_1",
          },
        }),
        {},
      ),
    ).resolves.toEqual({
      origin: { channel: "feishu", accountId: "work", to: "chat:oc_dm_chat_1" },
    });
  });

  it("preserves the bound Feishu topic parent context", async () => {
    const { deliveryHandler, manager } = managedHookFixture();
    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:topic-child",
      metadata: {
        deliveryTo: "chat:oc_group_chat",
        deliveryThreadId: "om_topic_root",
        boundBy: "system",
      },
    });

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:topic-child",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_group_chat",
            threadId: "om_topic_root",
          },
        }),
        {},
      ),
    ).resolves.toEqual({
      origin: {
        channel: "feishu",
        accountId: "work",
        to: "chat:oc_group_chat",
        threadId: "om_topic_root",
      },
    });
  });

  it("selects the requester-matching binding when a child has multiple routes", async () => {
    const { deliveryHandler, manager } = managedHookFixture();
    for (const sender of ["ou_sender_1", "ou_sender_2"]) {
      manager.bindConversation({
        conversationId: sender,
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:shared",
        metadata: { deliveryTo: `user:${sender}`, boundBy: "system" },
      });
    }

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:shared",
          requesterOrigin: dmOrigin("ou_sender_2"),
        }),
        {},
      ),
    ).resolves.toEqual({
      origin: { channel: "feishu", accountId: "work", to: "user:ou_sender_2" },
    });
  });

  it("removes bound routes on subagent_ended", async () => {
    const { deliveryHandler, endedHandler, manager } = managedHookFixture();
    manager.bindConversation({
      conversationId: "ou_sender_1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      metadata: { deliveryTo: "user:ou_sender_1", boundBy: "system" },
    });

    await endedHandler(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "done",
        accountId: "work",
      },
      {},
    );

    await expect(
      deliveryHandler(deliveryEvent({ childSessionKey: "agent:main:subagent:child" }), {}),
    ).resolves.toBeUndefined();
  });

  it("leaves unrelated channels and missing managers unchanged", async () => {
    const handlers = registerHandlersForTest();
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:child",
          requesterOrigin: {
            channel: "discord",
            accountId: "work",
            to: "channel:123",
          },
        }),
        {},
      ),
    ).resolves.toBeUndefined();
    await expect(
      deliveryHandler(deliveryEvent({ childSessionKey: "agent:main:subagent:child" }), {}),
    ).resolves.toBeUndefined();
  });
});
