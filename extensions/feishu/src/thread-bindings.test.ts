import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, createFeishuThreadBindingManager } from "./thread-bindings.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("Feishu thread bindings", () => {
  beforeEach(() => {
    __testing.resetFeishuThreadBindingsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
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
    const resolved = getSessionBindingService().resolveByConversation({
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_topic_root",
    });
    expect(resolved).toEqual({
      bindingId: "default:oc_group_chat:topic:om_topic_root",
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
        parentConversationId: "oc_group_chat",
      },
      status: "active",
      boundAt: 1_700_000_000_000,
      expiresAt: 1_700_086_400_000,
      metadata: {
        agentId: "codex",
        label: "codex-main",
        boundBy: undefined,
        deliveryTo: undefined,
        deliveryThreadId: undefined,
        lastActivityAt: 1_700_000_000_000,
        idleTimeoutMs: 86_400_000,
        maxAgeMs: 0,
      },
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
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
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
    ).toEqual({
      bindingId: "default:oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
        parentConversationId: "oc_group_chat",
      },
      status: "active",
      boundAt: 1_700_000_100_000,
      expiresAt: 1_700_086_500_000,
      metadata: {
        agentId: "codex",
        label: "child",
        boundBy: "system",
        deliveryTo: "user:ou_sender_1",
        deliveryThreadId: "om_topic_root",
        lastActivityAt: 1_700_000_100_000,
        idleTimeoutMs: 86_400_000,
        maxAgeMs: 0,
      },
    });
  });
});
