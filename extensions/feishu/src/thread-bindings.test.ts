// Feishu tests cover thread bindings plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuThreadBindingManager as createFeishuThreadBindingManagerImpl } from "./thread-bindings.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

type FeishuThreadBindingManager = ReturnType<typeof createFeishuThreadBindingManagerImpl>;
let trackedManager: FeishuThreadBindingManager | null = null;

function createFeishuThreadBindingManager(
  params: Parameters<typeof createFeishuThreadBindingManagerImpl>[0],
): FeishuThreadBindingManager {
  trackedManager = createFeishuThreadBindingManagerImpl(params);
  return trackedManager;
}

describe("Feishu thread bindings", () => {
  afterEach(() => {
    trackedManager?.stop();
    trackedManager = null;
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
    createFeishuThreadBindingManager({
      cfg: { ...baseCfg, agents: { entries: { main: {}, codex: {} } } },
      accountId: "default",
    });

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

  it("expires idle bindings from manager and service lookups at the deadline", async () => {
    const startedAt = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });
    const service = getSessionBindingService();
    const targetSessionKey = "agent:codex:acp:binding:feishu:default:expired";
    const conversation = {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_expired_root",
    };

    const binding = await service.bind({
      targetSessionKey,
      targetKind: "session",
      conversation,
      placement: "current",
    });
    await service.bind({
      targetSessionKey,
      targetKind: "session",
      conversation: {
        ...conversation,
        conversationId: "oc_group_chat:topic:om_expired_list_root",
      },
      placement: "current",
    });
    const expiresAt = startedAt + 86_400_000;
    expect(binding.expiresAt).toBe(expiresAt);

    now.mockReturnValue(expiresAt - 1);
    expect(manager.getByConversationId(conversation.conversationId)).toBeDefined();
    expect(manager.listBySessionKey(targetSessionKey)).toHaveLength(2);
    expect(service.resolveByConversation(conversation)).not.toBeNull();
    expect(service.listBySession(targetSessionKey)).toHaveLength(2);

    now.mockReturnValue(expiresAt);
    expect(service.resolveByConversation(conversation)).toBeNull();
    expect(manager.getByConversationId(conversation.conversationId)).toBeUndefined();
    expect(manager.listBySessionKey(targetSessionKey)).toEqual([]);
    expect(service.listBySession(targetSessionKey)).toEqual([]);
  });

  it("expires bindings at their maximum age even after activity refreshes idle time", async () => {
    const startedAt = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const cfg = {
      session: {
        mainKey: "main",
        scope: "per-sender",
        threadBindings: { idleHours: 2, maxAgeHours: 1 },
      },
    } satisfies OpenClawConfig;
    createFeishuThreadBindingManager({ cfg, accountId: "default" });
    const service = getSessionBindingService();
    const conversation = {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_max_age_root",
    };
    const binding = await service.bind({
      targetSessionKey: "agent:codex:acp:binding:feishu:default:max-age",
      targetKind: "session",
      conversation,
      placement: "current",
    });

    now.mockReturnValue(startedAt + 30 * 60_000);
    service.touch(binding.bindingId);
    expect(service.resolveByConversation(conversation)?.expiresAt).toBe(startedAt + 60 * 60_000);

    now.mockReturnValue(startedAt + 60 * 60_000);
    expect(service.resolveByConversation(conversation)).toBeNull();
    expect(service.listBySession(binding.targetSessionKey)).toEqual([]);
  });

  it("does not revive an expired binding when its conversation is touched", async () => {
    const startedAt = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });
    const service = getSessionBindingService();
    const conversation = {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_expired_touch_root",
    };
    const binding = await service.bind({
      targetSessionKey: "agent:codex:acp:binding:feishu:default:expired-touch",
      targetKind: "session",
      conversation,
      placement: "current",
    });
    const expiresAt = startedAt + 86_400_000;
    expect(binding.expiresAt).toBe(expiresAt);

    now.mockReturnValue(expiresAt);
    service.touch(binding.bindingId, expiresAt + 1);

    expect(manager.getByConversationId(conversation.conversationId)).toBeUndefined();
    expect(service.resolveByConversation(conversation)).toBeNull();
  });

  it("keeps active bindings touchable and unbindable", async () => {
    const startedAt = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });
    const service = getSessionBindingService();
    const conversation = {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_active_root",
    };
    const binding = await service.bind({
      targetSessionKey: "agent:codex:acp:binding:feishu:default:active",
      targetKind: "session",
      conversation,
      placement: "current",
    });

    now.mockReturnValue(startedAt + 1_000);
    service.touch(binding.bindingId);
    expect(service.resolveByConversation(conversation)?.metadata?.lastActivityAt).toBe(
      startedAt + 1_000,
    );

    await expect(service.unbind({ bindingId: binding.bindingId, reason: "test" })).resolves.toEqual(
      [expect.objectContaining({ bindingId: binding.bindingId })],
    );
    expect(service.resolveByConversation(conversation)).toBeNull();
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

    const restarted = createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });
    const conversation = {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_restarted",
    };
    const replacement = await getSessionBindingService().bind({
      conversation,
      targetSessionKey: "agent:codex:acp:replacement",
      targetKind: "session",
    });

    manager.stop();

    expect(createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" })).toBe(
      restarted,
    );
    expect(getSessionBindingService().resolveByConversation(conversation)).toEqual(replacement);
  });

  it.each(["refresh", "session", "kind"] as const)(
    "preserves conversation delivery fields without inheriting another target's owner (%s)",
    async (change) => {
      const replace = change !== "refresh";
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
      const manager = createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });

      manager.bindConversation({
        conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
        parentConversationId: "oc_group_chat",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        metadata: {
          agentId: "previous-agent",
          label: "child",
          boundBy: "system",
          deliveryTo: "user:ou_sender_1",
          deliveryThreadId: "om_topic_root",
          pluginBindingOwner: "plugin",
          pluginId: "fixture-plugin",
          pluginRoot: "/fixture/plugin",
          data: { threadId: "plugin-thread" },
        },
      });

      await getSessionBindingService().bind({
        targetSessionKey:
          change === "session" ? "agent:main:subagent:replacement" : "agent:main:subagent:child",
        targetKind: change === "kind" ? "session" : "subagent",
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
        targetSessionKey:
          change === "session" ? "agent:main:subagent:replacement" : "agent:main:subagent:child",
        targetKind: change === "kind" ? "session" : "subagent",
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
          ...(!replace
            ? {
                pluginBindingOwner: "plugin",
                pluginId: "fixture-plugin",
                pluginRoot: "/fixture/plugin",
                data: { threadId: "plugin-thread" },
              }
            : {}),
          agentId: replace ? "main" : "previous-agent",
          label: "child",
          boundBy: replace ? undefined : "system",
          deliveryTo: "user:ou_sender_1",
          deliveryThreadId: "om_topic_root",
          lastActivityAt: 1_700_000_100_000,
          idleTimeoutMs: 86_400_000,
          maxAgeMs: 0,
        },
      });
    },
  );
});
