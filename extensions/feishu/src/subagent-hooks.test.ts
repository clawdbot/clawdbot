import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClawdbotConfig, OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuSubagentHooks } from "../subagent-hooks-api.js";
import {
  createFeishuThreadBindingManager,
  __testing as threadBindingTesting,
} from "./thread-bindings.js";

const baseConfig: ClawdbotConfig = {
  session: { mainKey: "main", scope: "per-sender" },
  channels: { feishu: {} },
};

function registerHandlersForTest(config: Record<string, unknown> = baseConfig) {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config,
    register: registerFeishuSubagentHooks,
  });
}

async function expectHookError(value: unknown, expectedErrorFragment: string): Promise<void> {
  const result = (await value) as { status?: unknown; error?: unknown };
  expect(result.status).toBe("error");
  expect(result.error).toContain(expectedErrorFragment);
}

describe("feishu subagent hook handlers", () => {
  beforeEach(() => {
    threadBindingTesting.resetFeishuThreadBindingsForTests();
  });

  it("binds a Feishu DM conversation on subagent_spawning", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_spawning");
    createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" });

    const result = await handler(
      {
        childSessionKey: "agent:main:subagent:child",
        agentId: "codex",
        label: "banana",
        mode: "session",
        requester: {
          channel: "feishu",
          accountId: "work",
          to: "user:ou_sender_1",
        },
        threadRequested: true,
      },
      {},
    );

    expect(result).toEqual({ status: "ok", threadBindingReady: true });

    const deliveryTargetHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    await expect(
      deliveryTargetHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "user:ou_sender_1",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).resolves.toEqual({
      origin: {
        channel: "feishu",
        accountId: "work",
        to: "user:ou_sender_1",
      },
    });
  });

  it("preserves the original Feishu DM delivery target", async () => {
    const handlers = registerHandlersForTest();
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const manager = createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" });

    manager.bindConversation({
      conversationId: "ou_sender_1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:chat-dm-child",
      metadata: {
        deliveryTo: "chat:oc_dm_chat_1",
        boundBy: "system",
      },
    });

    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:chat-dm-child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_dm_chat_1",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).resolves.toEqual({
      origin: {
        channel: "feishu",
        accountId: "work",
        to: "chat:oc_dm_chat_1",
      },
    });
  });

  it("binds a Feishu topic conversation and preserves parent context", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" });

    const result = await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:topic-child",
        agentId: "codex",
        label: "topic-child",
        mode: "session",
        requester: {
          channel: "feishu",
          accountId: "work",
          to: "chat:oc_group_chat",
          threadId: "om_topic_root",
        },
        threadRequested: true,
      },
      {},
    );

    expect(result).toEqual({ status: "ok", threadBindingReady: true });
    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:topic-child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_group_chat",
            threadId: "om_topic_root",
          },
          expectsCompletionMessage: true,
        },
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

  it("uses the requester session binding to preserve sender-scoped topic conversations", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const manager = createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" });

    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
      metadata: {
        agentId: "codex",
        label: "parent",
        boundBy: "system",
      },
    });

    const reboundResult = await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:sender-child",
        agentId: "codex",
        label: "sender-child",
        mode: "session",
        requester: {
          channel: "feishu",
          accountId: "work",
          to: "chat:oc_group_chat",
          threadId: "om_topic_root",
        },
        threadRequested: true,
      },
      {
        requesterSessionKey: "agent:main:parent",
      },
    );

    expect(reboundResult).toEqual({ status: "ok", threadBindingReady: true });
    const childBindings = manager.listBySessionKey("agent:main:subagent:sender-child");
    expect(childBindings).toHaveLength(1);
    expect(childBindings[0]?.conversationId).toBe(
      "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
    );
    expect(childBindings[0]?.parentConversationId).toBe("oc_group_chat");
    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:sender-child",
          requesterSessionKey: "agent:main:parent",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_group_chat",
            threadId: "om_topic_root",
          },
          expectsCompletionMessage: true,
        },
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

  it("prefers requester-matching bindings when multiple child bindings exist", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" });

    await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:shared",
        agentId: "codex",
        label: "shared",
        mode: "session",
        requester: {
          channel: "feishu",
          accountId: "work",
          to: "user:ou_sender_1",
        },
        threadRequested: true,
      },
      {},
    );
    await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:shared",
        agentId: "codex",
        label: "shared",
        mode: "session",
        requester: {
          channel: "feishu",
          accountId: "work",
          to: "user:ou_sender_2",
        },
        threadRequested: true,
      },
      {},
    );

    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:shared",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "user:ou_sender_2",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).resolves.toEqual({
      origin: {
        channel: "feishu",
        accountId: "work",
        to: "user:ou_sender_2",
      },
    });
  });

  it("fails closed when requester-session bindings remain ambiguous for the same topic", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const manager = createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" });

    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
      metadata: { boundBy: "system" },
    });
    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_2",
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
      metadata: { boundBy: "system" },
    });

    await expectHookError(
      spawnHandler(
        {
          childSessionKey: "agent:main:subagent:ambiguous-child",
          agentId: "codex",
          label: "ambiguous-child",
          mode: "session",
          requester: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_group_chat",
            threadId: "om_topic_root",
          },
          threadRequested: true,
        },
        {
          requesterSessionKey: "agent:main:parent",
        },
      ),
      "direct messages or topic conversations",
    );

    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:ambiguous-child",
          requesterSessionKey: "agent:main:parent",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_group_chat",
            threadId: "om_topic_root",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when both topic-level and sender-scoped requester bindings exist", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const manager = createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" });

    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
      metadata: { boundBy: "system" },
    });
    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
      metadata: { boundBy: "system" },
    });

    await expectHookError(
      spawnHandler(
        {
          childSessionKey: "agent:main:subagent:mixed-topic-child",
          agentId: "codex",
          label: "mixed-topic-child",
          mode: "session",
          requester: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_group_chat",
            threadId: "om_topic_root",
          },
          threadRequested: true,
        },
        {
          requesterSessionKey: "agent:main:parent",
        },
      ),
      "direct messages or topic conversations",
    );

    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:mixed-topic-child",
          requesterSessionKey: "agent:main:parent",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_group_chat",
            threadId: "om_topic_root",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("no-ops for non-Feishu channels and non-threaded spawns", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const endedHandler = getRequiredHookHandler(handlers, "subagent_ended");

    await expect(
      spawnHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          agentId: "codex",
          mode: "run",
          requester: {
            channel: "discord",
            accountId: "work",
            to: "channel:123",
          },
          threadRequested: true,
        },
        {},
      ),
    ).resolves.toBeUndefined();

    await expect(
      spawnHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          agentId: "codex",
          mode: "run",
          requester: {
            channel: "feishu",
            accountId: "work",
            to: "user:ou_sender_1",
          },
          threadRequested: false,
        },
        {},
      ),
    ).resolves.toBeUndefined();

    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "discord",
            accountId: "work",
            to: "channel:123",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).resolves.toBeUndefined();

    await expect(
      endedHandler(
        {
          targetSessionKey: "agent:main:subagent:child",
          targetKind: "subagent",
          reason: "done",
          accountId: "work",
        },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("returns an error for unsupported non-topic Feishu group conversations", async () => {
    const handler = getRequiredHookHandler(registerHandlersForTest(), "subagent_spawning");
    createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" });

    await expectHookError(
      handler(
        {
          childSessionKey: "agent:main:subagent:child",
          agentId: "codex",
          mode: "session",
          requester: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_group_chat",
          },
          threadRequested: true,
        },
        {},
      ),
      "direct messages or topic conversations",
    );
  });

  it("unbinds Feishu bindings on subagent_ended", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const endedHandler = getRequiredHookHandler(handlers, "subagent_ended");
    createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" });

    await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:child",
        agentId: "codex",
        mode: "session",
        requester: {
          channel: "feishu",
          accountId: "work",
          to: "user:ou_sender_1",
        },
        threadRequested: true,
      },
      {},
    );

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
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "user:ou_sender_1",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the Feishu monitor-owned binding manager is unavailable", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    await expectHookError(
      spawnHandler(
        {
          childSessionKey: "agent:main:subagent:no-manager",
          agentId: "codex",
          mode: "session",
          requester: {
            channel: "feishu",
            accountId: "work",
            to: "user:ou_sender_1",
          },
          threadRequested: true,
        },
        {},
      ),
      "monitor is not active",
    );

    await expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:no-manager",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "user:ou_sender_1",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).resolves.toBeUndefined();
  });
});
