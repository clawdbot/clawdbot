// Feishu tests cover subagent hooks plugin behavior.
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClawdbotConfig, OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuSubagentHooks } from "../subagent-hooks-api.js";
import { handleFeishuSubagentSpawning } from "./subagent-hooks.js";
import {
  createFeishuThreadBindingManager,
  testing as threadBindingTesting,
} from "./thread-bindings.js";

const baseConfig: ClawdbotConfig = {
  session: { mainKey: "main", scope: "per-sender" },
  channels: { feishu: {} },
};

function registerHandlersForTest(config: Record<string, unknown> = baseConfig) {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config,
    register: (api) => {
      registerFeishuSubagentHooks(api);
      api.on("subagent_spawning", (event, ctx) => handleFeishuSubagentSpawning(event, ctx));
    },
  });
}

async function expectHookError(value: unknown, expectedErrorFragment: string): Promise<void> {
  const result = (await value) as { status?: unknown; error?: unknown };
  expect(result.status).toBe("error");
  expect(result.error).toContain(expectedErrorFragment);
}

function dmOrigin(sender = "ou_sender_1") {
  return {
    channel: "feishu" as const,
    accountId: "work",
    to: `user:${sender}`,
  };
}

type FeishuOrigin = ReturnType<typeof dmOrigin> & { threadId?: string };

function topicOrigin() {
  return {
    channel: "feishu" as const,
    accountId: "work",
    to: "chat:oc_group_chat",
    threadId: "om_topic_root",
  };
}

function spawnEvent(params: { childSessionKey: string; requester?: FeishuOrigin; label?: string }) {
  return {
    childSessionKey: params.childSessionKey,
    agentId: "codex",
    label: params.label,
    mode: "session" as const,
    requester: params.requester ?? dmOrigin(),
    threadRequested: true,
  };
}

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
    spawnHandler: getRequiredHookHandler(handlers, "subagent_spawning"),
    deliveryHandler: getRequiredHookHandler(handlers, "subagent_delivery_target"),
    endedHandler: getRequiredHookHandler(handlers, "subagent_ended"),
    manager: createFeishuThreadBindingManager({ cfg: baseConfig, accountId: "work" }),
  };
}

describe("feishu subagent hook handlers", () => {
  beforeEach(() => {
    threadBindingTesting.resetFeishuThreadBindingsForTests();
  });

  it("binds a Feishu DM conversation on subagent_spawning", async () => {
    const { spawnHandler, deliveryHandler } = managedHookFixture();

    const result = await spawnHandler(
      spawnEvent({
        childSessionKey: "agent:main:subagent:child",
        label: "banana",
      }),
      {},
    );

    expect(result).toEqual({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "feishu",
        accountId: "work",
        to: "user:ou_sender_1",
      },
    });

    await expect(
      deliveryHandler(deliveryEvent({ childSessionKey: "agent:main:subagent:child" }), {}),
    ).resolves.toEqual({
      origin: {
        channel: "feishu",
        accountId: "work",
        to: "user:ou_sender_1",
      },
    });
  });

  it("preserves the original Feishu DM delivery target", async () => {
    const { deliveryHandler, manager } = managedHookFixture();

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
      origin: {
        channel: "feishu",
        accountId: "work",
        to: "chat:oc_dm_chat_1",
      },
    });
  });

  it("binds a Feishu topic conversation and preserves parent context", async () => {
    const { spawnHandler, deliveryHandler } = managedHookFixture();

    const result = await spawnHandler(
      spawnEvent({
        childSessionKey: "agent:main:subagent:topic-child",
        label: "topic-child",
        requester: topicOrigin(),
      }),
      {},
    );

    expect(result).toEqual({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "feishu",
        accountId: "work",
        to: "chat:oc_group_chat",
        threadId: "om_topic_root",
      },
    });
    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:topic-child",
          requesterOrigin: topicOrigin(),
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

  it("uses the requester session binding to preserve sender-scoped topic conversations", async () => {
    const { spawnHandler, deliveryHandler, manager } = managedHookFixture();

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
      spawnEvent({
        childSessionKey: "agent:main:subagent:sender-child",
        label: "sender-child",
        requester: topicOrigin(),
      }),
      {
        requesterSessionKey: "agent:main:parent",
      },
    );

    expect(reboundResult).toEqual({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "feishu",
        accountId: "work",
        to: "chat:oc_group_chat",
        threadId: "om_topic_root",
      },
    });
    const childBindings = manager.listBySessionKey("agent:main:subagent:sender-child");
    expect(childBindings).toHaveLength(1);
    expect(childBindings[0]?.conversationId).toBe(
      "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
    );
    expect(childBindings[0]?.parentConversationId).toBe("oc_group_chat");
    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:sender-child",
          requesterSessionKey: "agent:main:parent",
          requesterOrigin: topicOrigin(),
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

  it("prefers requester-matching bindings when multiple child bindings exist", async () => {
    const { spawnHandler, deliveryHandler } = managedHookFixture();

    await spawnHandler(
      spawnEvent({
        childSessionKey: "agent:main:subagent:shared",
        label: "shared",
      }),
      {},
    );
    await spawnHandler(
      spawnEvent({
        childSessionKey: "agent:main:subagent:shared",
        label: "shared",
        requester: dmOrigin("ou_sender_2"),
      }),
      {},
    );

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:shared",
          requesterOrigin: dmOrigin("ou_sender_2"),
        }),
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
    const { spawnHandler, deliveryHandler, manager } = managedHookFixture();

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
        spawnEvent({
          childSessionKey: "agent:main:subagent:ambiguous-child",
          label: "ambiguous-child",
          requester: topicOrigin(),
        }),
        {
          requesterSessionKey: "agent:main:parent",
        },
      ),
      "direct messages or topic conversations",
    );

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:ambiguous-child",
          requesterSessionKey: "agent:main:parent",
          requesterOrigin: topicOrigin(),
        }),
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when both topic-level and sender-scoped requester bindings exist", async () => {
    const { spawnHandler, deliveryHandler, manager } = managedHookFixture();

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
        spawnEvent({
          childSessionKey: "agent:main:subagent:mixed-topic-child",
          label: "mixed-topic-child",
          requester: topicOrigin(),
        }),
        {
          requesterSessionKey: "agent:main:parent",
        },
      ),
      "direct messages or topic conversations",
    );

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:mixed-topic-child",
          requesterSessionKey: "agent:main:parent",
          requesterOrigin: topicOrigin(),
        }),
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
    const { spawnHandler } = managedHookFixture();

    await expectHookError(
      spawnHandler(
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
    const { spawnHandler, deliveryHandler, endedHandler } = managedHookFixture();

    await spawnHandler(spawnEvent({ childSessionKey: "agent:main:subagent:child" }), {});

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

  it("fails closed when the Feishu monitor-owned binding manager is unavailable", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    await expectHookError(
      spawnHandler(
        spawnEvent({
          childSessionKey: "agent:main:subagent:no-manager",
        }),
        {},
      ),
      "monitor is not active",
    );

    await expect(
      deliveryHandler(deliveryEvent({ childSessionKey: "agent:main:subagent:no-manager" }), {}),
    ).resolves.toBeUndefined();
  });
});
