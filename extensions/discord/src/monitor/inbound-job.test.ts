import { Message } from "@buape/carbon";
import { describe, expect, it } from "vitest";
import { createPartialDiscordChannelWithThrowingGetters } from "../test-support/partial-channel.js";
import {
  buildDiscordInboundJob,
  materializeDiscordInboundJob,
  resolveDiscordInboundJobQueueKey,
} from "./inbound-job.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

describe("buildDiscordInboundJob", () => {
  it("prefers route session key, then base session key, then channel id for queueing", async () => {
    const routed = await createBaseDiscordMessageContext({
      route: { sessionKey: "agent:main:discord:direct:routed" },
      baseSessionKey: "agent:main:discord:direct:base",
      messageChannelId: "channel-routed",
    });
    const baseOnly = await createBaseDiscordMessageContext({
      route: { sessionKey: "" },
      baseSessionKey: "agent:main:discord:direct:base-only",
      messageChannelId: "channel-base",
    });
    const channelFallback = await createBaseDiscordMessageContext({
      route: { sessionKey: "   " },
      baseSessionKey: "   ",
      messageChannelId: "channel-fallback",
    });

    expect(resolveDiscordInboundJobQueueKey(routed)).toBe("agent:main:discord:direct:routed");
    expect(resolveDiscordInboundJobQueueKey(baseOnly)).toBe("agent:main:discord:direct:base-only");
    expect(resolveDiscordInboundJobQueueKey(channelFallback)).toBe("channel-fallback");
  });

  it("keeps live runtime references out of the payload", async () => {
    const ctx = await createBaseDiscordMessageContext({
      message: {
        id: "m1",
        channelId: "thread-1",
        timestamp: new Date().toISOString(),
        attachments: [],
        channel: {
          id: "thread-1",
          isThread: () => true,
        },
      },
      data: {
        guild: { id: "g1", name: "Guild" },
        message: {
          id: "m1",
          channelId: "thread-1",
          timestamp: new Date().toISOString(),
          attachments: [],
          channel: {
            id: "thread-1",
            isThread: () => true,
          },
        },
      },
      threadChannel: {
        id: "thread-1",
        name: "codex",
        parentId: "forum-1",
        parent: {
          id: "forum-1",
          name: "Forum",
        },
        ownerId: "user-1",
      },
    });

    const job = buildDiscordInboundJob(ctx);

    expect("runtime" in job.payload).toBe(false);
    expect("client" in job.payload).toBe(false);
    expect("threadBindings" in job.payload).toBe(false);
    expect("discordRestFetch" in job.payload).toBe(false);
    expect("channel" in job.payload.message).toBe(false);
    expect("channel" in job.payload.data.message).toBe(false);
    expect(job.runtime.client).toBe(ctx.client);
    expect(job.runtime.threadBindings).toBe(ctx.threadBindings);
    expect(job.payload.threadChannel).toEqual({
      id: "thread-1",
      name: "codex",
      parentId: "forum-1",
      parent: {
        id: "forum-1",
        name: "Forum",
      },
      ownerId: "user-1",
    });
    expect(() => JSON.stringify(job.payload)).not.toThrow();
  });

  it("normalizes partial thread channels without reading throwing getters", async () => {
    const threadChannel = createPartialDiscordChannelWithThrowingGetters(
      {
        id: "thread-1",
        name: "codex",
        parentId: "forum-1",
        parent: { id: "forum-1", name: "Forum" },
        ownerId: "user-1",
      },
      ["name", "parentId", "parent", "ownerId"],
    );
    const ctx = await createBaseDiscordMessageContext({
      threadChannel,
    });

    const job = buildDiscordInboundJob(ctx);

    expect(job.payload.threadChannel).toEqual({
      id: "thread-1",
      name: undefined,
      parentId: undefined,
      parent: undefined,
      ownerId: undefined,
    });
    expect(() => JSON.stringify(job.payload)).not.toThrow();
  });

  it("re-materializes the process context with an overridden abort signal", async () => {
    const ctx = await createBaseDiscordMessageContext();
    const job = buildDiscordInboundJob(ctx, { replayKeys: ["default:ch-1:m-1"] });
    const overrideAbortController = new AbortController();

    const rematerialized = materializeDiscordInboundJob(job, overrideAbortController.signal);

    expect(rematerialized.runtime).toBe(ctx.runtime);
    expect(rematerialized.client).toBe(ctx.client);
    expect(rematerialized.threadBindings).toBe(ctx.threadBindings);
    expect(rematerialized.abortSignal).toBe(overrideAbortController.signal);
    expect(rematerialized.message).toEqual(job.payload.message);
    expect(rematerialized.data).toEqual(job.payload.data);
    expect(job.replayKeys).toEqual(["default:ch-1:m-1"]);
  });

  it("preserves Carbon message getters across queued jobs", async () => {
    const ctx = await createBaseDiscordMessageContext();
    const message = new Message(
      ctx.client as never,
      {
        id: "m1",
        channel_id: "c1",
        content: "hello",
        attachments: [{ id: "a1", filename: "note.txt" }],
        timestamp: new Date().toISOString(),
        author: {
          id: "u1",
          username: "alice",
          discriminator: "0",
          avatar: null,
        },
        referenced_message: {
          id: "m0",
          channel_id: "c1",
          content: "earlier",
          attachments: [],
          timestamp: new Date().toISOString(),
          author: {
            id: "u2",
            username: "bob",
            discriminator: "0",
            avatar: null,
          },
          type: 0,
          tts: false,
          mention_everyone: false,
          pinned: false,
          flags: 0,
        },
        type: 0,
        tts: false,
        mention_everyone: false,
        pinned: false,
        flags: 0,
      } as ConstructorParameters<typeof Message>[1],
    );
    const runtimeChannel = { id: "c1", isThread: () => false };
    Object.defineProperty(message, "channel", {
      value: runtimeChannel,
      configurable: true,
      enumerable: true,
      writable: true,
    });

    const job = buildDiscordInboundJob({
      ...ctx,
      message,
      data: {
        ...ctx.data,
        message,
      },
    });
    const rematerialized = materializeDiscordInboundJob(job);

    expect(job.payload.message).toBeInstanceOf(Message);
    expect("channel" in job.payload.message).toBe(false);
    expect(rematerialized.message.content).toBe("hello");
    expect(rematerialized.message.attachments).toHaveLength(1);
    expect(rematerialized.message.timestamp).toBe(message.timestamp);
    expect(rematerialized.message.referencedMessage?.content).toBe("earlier");
  });
});
