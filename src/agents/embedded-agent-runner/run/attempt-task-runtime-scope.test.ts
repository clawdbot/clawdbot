import { describe, expect, it } from "vitest";
import { createAttemptTaskRuntimeScope } from "./attempt-task-runtime-scope.js";

describe("createAttemptTaskRuntimeScope", () => {
  it("binds routable and source-message requester provenance", () => {
    const scope = createAttemptTaskRuntimeScope({
      sessionKey: " agent:main:discord:channel:C123 ",
      messageChannel: " discord ",
      messageProvider: "fallback-provider",
      agentAccountId: " default ",
      messageTo: "channel:fallback",
      currentMessagingTarget: " channel:C123 ",
      messageThreadId: " 171.22 ",
      currentChannelId: " C123 ",
      chatId: "fallback-chat",
      currentMessageId: " M456 ",
    });

    expect(scope).toEqual({
      requesterSessionKey: "agent:main:discord:channel:C123",
      requesterOrigin: {
        channel: "discord",
        accountId: "default",
        to: "channel:C123",
        threadId: "171.22",
      },
      requesterPresentation: {
        channel: "discord",
        accountId: "default",
        to: "channel:C123",
        threadId: "171.22",
        channelId: "C123",
        messageId: "M456",
      },
    });
  });

  it("does not issue a scope without a requester session", () => {
    expect(createAttemptTaskRuntimeScope({ sessionKey: " " })).toBeUndefined();
  });

  it("uses fallback provenance when preferred values are blank", () => {
    const scope = createAttemptTaskRuntimeScope({
      sessionKey: "agent:main:telegram:chat:42",
      messageChannel: " ",
      messageProvider: " telegram ",
      currentMessagingTarget: "",
      messageTo: " chat:42 ",
      messageThreadId: " ",
      currentThreadTs: " topic:7 ",
      currentChannelId: "\t",
      chatId: " chat-id:42 ",
    });

    expect(scope).toMatchObject({
      requesterOrigin: {
        channel: "telegram",
        to: "chat:42",
        threadId: "topic:7",
      },
      requesterPresentation: {
        channel: "telegram",
        to: "chat:42",
        threadId: "topic:7",
        channelId: "chat-id:42",
      },
    });
  });
});
