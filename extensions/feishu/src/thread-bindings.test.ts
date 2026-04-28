import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { __testing, createFeishuThreadBindingManager } from "./thread-bindings.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("Feishu thread bindings", () => {
  beforeEach(() => {
    __testing.resetFeishuThreadBindingsForTests();
  });

  it("registers current-placement adapter capabilities for Feishu", () => {
    createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });

    expect(
      getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });
  });

  it("binds and resolves a Feishu topic conversation", async () => {
    createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });

    const binding = await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
        parentConversationId: "oc_group_chat",
      },
      placement: "current",
      metadata: {
        agentId: "codex",
        label: "codex-main",
      },
    });

    expect(binding.conversation.conversationId).toBe("oc_group_chat:topic:om_topic_root");
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
      }),
    )?.toMatchObject({
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      metadata: expect.objectContaining({
        agentId: "codex",
        label: "codex-main",
      }),
    });
  });

  it("clears account-scoped bindings when the manager stops", async () => {
    const manager = createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
        parentConversationId: "oc_group_chat",
      },
      placement: "current",
      metadata: {
        agentId: "codex",
      },
    });

    manager.stop();

    expect(
      getSessionBindingService().resolveByConversation({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
      }),
    ).toBeNull();
  });

  it("preserves delivery routing metadata when rebinding the same conversation", async () => {
    const manager = createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });

    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      metadata: {
        agentId: "codex",
        label: "child",
        boundBy: "system",
        deliveryTo: "user:ou_sender_1",
        deliveryThreadId: "om_topic_root",
      },
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
        parentConversationId: "oc_group_chat",
      },
      placement: "current",
      metadata: {
        label: "child",
      },
    });

    expect(
      getSessionBindingService().resolveByConversation({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      }),
    ).toMatchObject({
      metadata: expect.objectContaining({
        agentId: "codex",
        label: "child",
        boundBy: "system",
        deliveryTo: "user:ou_sender_1",
        deliveryThreadId: "om_topic_root",
      }),
    });
  });
});
