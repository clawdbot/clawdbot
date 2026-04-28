import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { SessionEntry } from "./types.js";

const storeState = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
}));

vi.mock("../io.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("./paths.js", () => ({
  resolveStorePath: () => "/tmp/sessions.json",
}));

vi.mock("./store.js", () => ({
  loadSessionStore: () => storeState.store,
}));

let extractDeliveryInfo: typeof import("./delivery-info.js").extractDeliveryInfo;
let parseSessionThreadInfo: typeof import("./delivery-info.js").parseSessionThreadInfo;

const buildEntry = (deliveryContext: SessionEntry["deliveryContext"]): SessionEntry => ({
  sessionId: "session-1",
  updatedAt: Date.now(),
  deliveryContext,
});

beforeAll(async () => {
  ({ extractDeliveryInfo, parseSessionThreadInfo } = await import("./delivery-info.js"));
});

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
  storeState.store = {};
});

describe("extractDeliveryInfo", () => {
  it("parses base session and thread/topic ids", () => {
    expect(parseSessionThreadInfo("agent:main:telegram:group:1:topic:55")).toEqual({
      baseSessionKey: "agent:main:telegram:group:1",
      threadId: "55",
    });
    expect(parseSessionThreadInfo("agent:main:slack:channel:C1:thread:123.456")).toEqual({
      baseSessionKey: "agent:main:slack:channel:C1",
      threadId: "123.456",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:matrix:channel:!room:example.org:thread:$AbC123:example.org",
      ),
    ).toEqual({
      baseSessionKey: "agent:main:matrix:channel:!room:example.org",
      threadId: "$AbC123:example.org",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      baseSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo("agent:main:telegram:dm:user-1")).toEqual({
      baseSessionKey: "agent:main:telegram:dm:user-1",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo(undefined)).toEqual({
      baseSessionKey: undefined,
      threadId: undefined,
    });
  });

  it("returns deliveryContext for direct session keys", () => {
    const sessionKey = "agent:main:webchat:dm:user-123";
    storeState.store[sessionKey] = buildEntry({
      channel: "webchat",
      to: "webchat:user-123",
      accountId: "default",
    });

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("falls back to base sessions for :thread: keys", () => {
    const baseKey = "agent:main:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    storeState.store[baseKey] = buildEntry({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      },
      threadId: "1234567890.123456",
    });
  });

  it("falls back to base sessions for :topic: keys", () => {
    const baseKey = "agent:main:telegram:group:98765";
    const topicKey = `${baseKey}:topic:55`;
    storeState.store[baseKey] = buildEntry({
      channel: "telegram",
      to: "group:98765",
      accountId: "main",
    });
    storeState.store[baseKey].lastThreadId = "55";

    const result = extractDeliveryInfo(topicKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
        threadId: "55",
      },
      threadId: "55",
    });
  });

  it("falls back to session metadata thread ids when deliveryContext.threadId is missing", () => {
    const sessionKey = "agent:main:telegram:group:98765";
    storeState.store[sessionKey] = {
      ...buildEntry({
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
      }),
      origin: { threadId: 77 },
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
        threadId: "77",
      },
      threadId: undefined,
    });
  });

  it("derives delivery info from stored last route metadata when deliveryContext is missing", () => {
    const sessionKey = "agent:main:matrix:channel:!lowercased:example.org";
    storeState.store[sessionKey] = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      origin: {
        provider: "matrix",
      },
      lastChannel: "matrix",
      lastTo: "room:!MixedCase:example.org",
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: undefined,
      },
      threadId: undefined,
    });
  });

  it("falls back to the base session when a thread entry only has partial route metadata", () => {
    const baseKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const threadKey = `${baseKey}:thread:$thread-event`;
    storeState.store[threadKey] = {
      sessionId: "thread-session",
      updatedAt: Date.now(),
      origin: {
        provider: "matrix",
        threadId: "$thread-event",
      },
    };
    storeState.store[baseKey] = {
      sessionId: "base-session",
      updatedAt: Date.now(),
      lastChannel: "matrix",
      lastTo: "room:!MixedCase:example.org",
    };

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: undefined,
      },
      threadId: "$thread-event",
    });
  });
});
