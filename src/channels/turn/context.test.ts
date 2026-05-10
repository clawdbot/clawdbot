import { describe, expect, it } from "vitest";
import { buildChannelTurnContext, type BuildChannelTurnContextParams } from "./context.js";

function createBaseContextParams(
  overrides: Partial<BuildChannelTurnContextParams> = {},
): BuildChannelTurnContextParams {
  return {
    channel: "test",
    accountId: "acct",
    messageId: "msg-1",
    from: "test:user:u1",
    sender: {
      id: "u1",
    },
    conversation: {
      kind: "group",
      id: "room-1",
      routePeer: {
        kind: "group",
        id: "room-1",
      },
    },
    route: {
      agentId: "main",
      routeSessionKey: "agent:main:test:group:room-1",
    },
    reply: {
      to: "test:room:room-1",
      originatingTo: "test:room:room-1",
    },
    message: {
      rawBody: "hello",
      envelopeFrom: "User One",
    },
    ...overrides,
  };
}

describe("buildChannelTurnContext", () => {
  it("maps normalized turn facts into a finalized message context", () => {
    const ctx = buildChannelTurnContext({
      channel: "test",
      accountId: "acct",
      provider: "test-provider",
      surface: "test-surface",
      messageId: "msg-1",
      timestamp: 123,
      from: "test:user:u1",
      sender: {
        id: "u1",
        name: "User One",
        username: "userone",
        tag: "User#0001",
        roles: ["admin"],
      },
      conversation: {
        kind: "group",
        id: "room-1",
        label: "Room One",
        spaceId: "workspace",
        threadId: "thread-1",
        routePeer: {
          kind: "group",
          id: "room-1",
        },
      },
      route: {
        agentId: "main",
        accountId: "acct",
        routeSessionKey: "agent:main:test:group:room-1",
        parentSessionKey: "agent:main:test:group",
        modelParentSessionKey: "agent:main:test:model",
      },
      reply: {
        to: "test:room:room-1",
        originatingTo: "test:room:room-1",
        replyToId: "root-1",
        nativeChannelId: "native-room-1",
      },
      message: {
        body: "[User One] hello",
        rawBody: "hello",
        bodyForAgent: "hello",
        commandBody: "/status",
        envelopeFrom: "User One",
        inboundHistory: [{ sender: "Other", body: "previous", timestamp: 100 }],
      },
      access: {
        commands: {
          allowTextCommands: true,
          useAccessGroups: true,
          authorizers: [{ configured: true, allowed: true }],
        },
        mentions: {
          canDetectMention: true,
          wasMentioned: true,
        },
      },
      media: [
        {
          path: "/tmp/image.png",
          contentType: "image/png",
          kind: "image",
        },
        {
          url: "https://example.test/audio.mp3",
          contentType: "audio/mpeg",
          kind: "audio",
          transcribed: true,
        },
      ],
      supplemental: {
        quote: {
          id: "quote-1",
          body: "quoted",
          sender: "Quoted User",
          isQuote: true,
        },
        thread: {
          starterBody: "thread starter",
          historyBody: "thread history",
          label: "thread label",
        },
        groupSystemPrompt: "group prompt",
      },
    });

    const expectedFields = {
      Body: "[User One] hello",
      BodyForAgent: "hello",
      RawBody: "hello",
      CommandBody: "/status",
      BodyForCommands: "/status",
      From: "test:user:u1",
      To: "test:room:room-1",
      SessionKey: "agent:main:test:group:room-1",
      AccountId: "acct",
      ParentSessionKey: "agent:main:test:group",
      ModelParentSessionKey: "agent:main:test:model",
      MessageSid: "msg-1",
      ReplyToId: "root-1",
      ReplyToBody: "quoted",
      ReplyToSender: "Quoted User",
      MediaPath: "/tmp/image.png",
      MediaUrl: "/tmp/image.png",
      MediaType: "image/png",
      MediaPaths: ["/tmp/image.png"],
      MediaUrls: ["/tmp/image.png", "https://example.test/audio.mp3"],
      MediaTypes: ["image/png", "audio/mpeg"],
      MediaTranscribedIndexes: [1],
      ChatType: "group",
      ConversationLabel: "Room One",
      GroupSubject: "Room One",
      GroupSpace: "workspace",
      GroupSystemPrompt: "group prompt",
      SenderName: "User One",
      SenderId: "u1",
      SenderUsername: "userone",
      SenderTag: "User#0001",
      MemberRoleIds: ["admin"],
      Timestamp: 123,
      Provider: "test-provider",
      Surface: "test-surface",
      WasMentioned: true,
      CommandAuthorized: true,
      MessageThreadId: "thread-1",
      NativeChannelId: "native-room-1",
      OriginatingChannel: "test",
      OriginatingTo: "test:room:room-1",
      ThreadStarterBody: "thread starter",
      ThreadHistoryBody: "thread history",
      ThreadLabel: "thread label",
    } as const;

    for (const [key, value] of Object.entries(expectedFields)) {
      expect(ctx[key as keyof typeof ctx]).toEqual(value);
    }
  });

  it("uses resolved command authorization instead of recomputing authorizers", () => {
    const ctx = buildChannelTurnContext(
      createBaseContextParams({
        access: {
          commands: {
            authorized: false,
            shouldBlockControlCommand: true,
            reasonCode: "control_command_unauthorized",
            allowTextCommands: true,
            useAccessGroups: true,
            authorizers: [{ configured: true, allowed: true }],
          },
        },
      }),
    );

    expect(ctx.CommandAuthorized).toBe(false);
  });

  it("keeps legacy command authorization fallback for authorizer arrays", () => {
    const ctx = buildChannelTurnContext(
      createBaseContextParams({
        access: {
          commands: {
            allowTextCommands: true,
            useAccessGroups: true,
            authorizers: [{ configured: true, allowed: true }],
          },
        },
      }),
    );

    expect(ctx.CommandAuthorized).toBe(true);
  });

  it("filters supplemental context with channel visibility policy", () => {
    const ctx = buildChannelTurnContext(
      createBaseContextParams({
        supplemental: {
          quote: {
            id: "quote-1",
            body: "quoted",
            sender: "Quoted User",
            senderAllowed: false,
            isQuote: true,
          },
          forwarded: {
            from: "Forwarded User",
            fromId: "f1",
            senderAllowed: false,
          },
          thread: {
            starterBody: "thread starter",
            historyBody: "thread history",
            senderAllowed: false,
          },
        },
        contextVisibility: "allowlist",
      }),
    );

    expect(ctx.ReplyToBody).toBeUndefined();
    expect(ctx.ReplyToSender).toBeUndefined();
    expect(ctx.ForwardedFrom).toBeUndefined();
    expect(ctx.ThreadStarterBody).toBeUndefined();
    expect(ctx.ThreadHistoryBody).toBeUndefined();
  });

  it("keeps quoted context in allowlist_quote mode", () => {
    const ctx = buildChannelTurnContext(
      createBaseContextParams({
        supplemental: {
          quote: {
            id: "quote-1",
            body: "quoted",
            sender: "Quoted User",
            senderAllowed: false,
            isQuote: true,
          },
          thread: {
            starterBody: "thread starter",
            senderAllowed: false,
          },
        },
        contextVisibility: "allowlist_quote",
      }),
    );

    expect(ctx.ReplyToBody).toBe("quoted");
    expect(ctx.ReplyToSender).toBe("Quoted User");
    expect(ctx.ThreadStarterBody).toBeUndefined();
  });

  it("drops supplemental context with unknown sender allow state in restrictive modes", () => {
    const ctx = buildChannelTurnContext(
      createBaseContextParams({
        supplemental: {
          quote: {
            id: "quote-1",
            body: "quoted",
            sender: "Quoted User",
            isQuote: true,
          },
          forwarded: {
            from: "Forwarded User",
            fromId: "f1",
          },
          thread: {
            starterBody: "thread starter",
            historyBody: "thread history",
          },
        },
        contextVisibility: "allowlist_quote",
      }),
    );

    expect(ctx.ReplyToBody).toBeUndefined();
    expect(ctx.ReplyToSender).toBeUndefined();
    expect(ctx.ForwardedFrom).toBeUndefined();
    expect(ctx.ThreadStarterBody).toBeUndefined();
    expect(ctx.ThreadHistoryBody).toBeUndefined();
  });
});
