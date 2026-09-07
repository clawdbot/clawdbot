// sessions_send helper tests cover session-key target parsing and ping-pong
// turn limits for agent-to-agent announce flows.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  buildAgentToAgentMessageContext,
  buildAgentToAgentReplyContext,
  resolveAnnounceTargetFromKey,
  resolvePingPongTurns,
} from "./sessions-send-helpers.js";

describe("resolveAnnounceTargetFromKey", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("lets plugins own session-derived target shapes", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:discord:group:dev")).toEqual({
      channel: "discord",
      to: "channel:dev",
      threadId: undefined,
    });
    expect(resolveAnnounceTargetFromKey("agent:main:slack:group:C123")).toEqual({
      channel: "slack",
      to: "channel:C123",
      threadId: undefined,
    });
  });

  it("keeps generic topic extraction and plugin normalization for other channels", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:telegram:group:-100123:topic:99")).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: "99",
    });
  });

  it("preserves decimal thread ids for Slack-style session keys", () => {
    expect(
      resolveAnnounceTargetFromKey("agent:main:slack:channel:general:thread:1699999999.0001"),
    ).toEqual({
      channel: "slack",
      to: "channel:general",
      threadId: "1699999999.0001",
    });
  });

  it("preserves colon-delimited matrix ids for channel and thread targets", () => {
    // Matrix room/thread ids can contain colons, so parsing must split only on
    // known wrappers instead of generic colon segments.
    expect(
      resolveAnnounceTargetFromKey(
        "agent:main:matrix:channel:!room:example.org:thread:$AbC123:example.org",
      ),
    ).toEqual({
      channel: "matrix",
      to: "channel:!room:example.org",
      threadId: "$AbC123:example.org",
    });
  });

  it("preserves feishu conversation ids that embed :topic: in the base id", () => {
    expect(
      resolveAnnounceTargetFromKey(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      channel: "feishu",
      to: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
  });

  it.each([
    {
      name: "direct",
      sessionKey: "agent:main:feishu:direct:ou_recipient",
      expected: { channel: "feishu", to: "user:ou_recipient", threadId: undefined },
    },
    {
      name: "dm alias",
      sessionKey: "agent:main:feishu:dm:ou_recipient",
      expected: { channel: "feishu", to: "user:ou_recipient", threadId: undefined },
    },
    {
      name: "account-scoped direct",
      sessionKey: "agent:main:feishu:work:direct:ou_recipient",
      expected: {
        channel: "feishu",
        to: "user:ou_recipient",
        accountId: "work",
        threadId: undefined,
      },
    },
    {
      name: "account-scoped dm alias",
      sessionKey: "agent:main:feishu:work:dm:ou_recipient",
      expected: {
        channel: "feishu",
        to: "user:ou_recipient",
        accountId: "work",
        threadId: undefined,
      },
    },
    {
      name: "thread-scoped direct",
      sessionKey: "agent:main:feishu:direct:ou_recipient:thread:topic-42",
      expected: {
        channel: "feishu",
        to: "user:ou_recipient",
        threadId: "topic-42",
      },
    },
    {
      name: "unregistered channel",
      sessionKey: "agent:main:wecom:direct:opaque-recipient",
      expected: {
        channel: "wecom",
        to: "user:opaque-recipient",
        threadId: undefined,
      },
    },
  ])(
    "resolves $name announce targets without session-list delivery context",
    ({ sessionKey, expected }) => {
      expect(resolveAnnounceTargetFromKey(sessionKey)).toEqual(expected);
    },
  );

  it("does not reinterpret a nested agent session as an external direct target", () => {
    expect(
      resolveAnnounceTargetFromKey("agent:main:agent:other:feishu:direct:ou_recipient"),
    ).toBeNull();
  });

  it("keeps a safe user target when a direct delivery resolver returns null", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "feishu" }),
            messaging: {
              normalizeTarget: (target: string) => target,
              resolveDeliveryTarget: () => null,
            },
          },
        },
      ]),
    );

    expect(resolveAnnounceTargetFromKey("agent:main:feishu:direct:ou_recipient")).toEqual({
      channel: "feishu",
      to: "user:ou_recipient",
      threadId: undefined,
    });
  });

  it("does not let a room delivery resolver convert a direct user into a channel", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: {
              directTargetStyle: "user-prefixed",
              targetIdComparison: "lowercase",
              normalizeTarget: (target: string) => target.toLowerCase(),
              resolveDeliveryTarget: ({ conversationId }: { conversationId: string }) => ({
                to: `channel:${conversationId}`,
              }),
            },
          },
        },
      ]),
    );

    expect(resolveAnnounceTargetFromKey("agent:main:slack:direct:U09G2DJ0275")).toEqual({
      channel: "slack",
      to: "user:u09g2dj0275",
      threadId: undefined,
    });
  });
});

describe("resolvePingPongTurns", () => {
  it("uses the fixed five-turn limit", () => {
    expect(resolvePingPongTurns()).toBe(5);
  });
});

describe("agent-to-agent prompt context", () => {
  it("keeps volatile routing identifiers out of system prompt context", () => {
    const context = buildAgentToAgentMessageContext({
      requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
      requesterChannel: "slack",
      targetSessionKey: "agent:worker:discord:channel:ops:run:run-123",
    });

    expect(context).toContain("Agent 1 (requester) session: <REQUESTER_SESSION>.");
    expect(context).toContain("Agent 1 (requester) channel: slack.");
    expect(context).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(context).not.toContain("agent:main:slack:channel:C123:thread:171.222");
    expect(context).not.toContain("agent:worker:discord:channel:ops:run:run-123");
  });

  it("preserves optional session line shape with concrete channel values", () => {
    const context = buildAgentToAgentReplyContext({
      requesterSessionKey: "agent:requester:main",
      targetSessionKey: "agent:target:main",
      targetChannel: "telegram",
      currentRole: "target",
      turn: 2,
      maxTurns: 5,
    });

    expect(context).toContain("Current agent: Agent 2 (target).");
    expect(context).toContain("Agent 1 (requester) session: <REQUESTER_SESSION>.");
    expect(context).not.toContain("Agent 1 (requester) channel:");
    expect(context).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(context).toContain("Agent 2 (target) channel: telegram.");
    expect(context).not.toContain("agent:requester:main");
    expect(context).not.toContain("agent:target:main");
  });
});
