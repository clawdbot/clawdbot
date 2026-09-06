import { MessageType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { expect, it, vi } from "vitest";
import { Message } from "../internal/discord.js";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import { createDiscordMessageDispatcher } from "./message-dispatcher.js";
import { createDiscordHandlerParams } from "./message-handler.test-helpers.js";

it("applies current inbound timing without losing queued Discord messages", async () => {
  const client = createInternalTestClient();
  const params = createDiscordHandlerParams();
  const dispatched: string[][] = [];
  setRuntimeConfigSnapshot(params.cfg, params.cfg);
  const handler = createDiscordMessageDispatcher({
    ...params,
    testing: {
      preflightDiscordMessage: async ({ data, precedingMessages = [] }) => {
        dispatched.push([...precedingMessages, data.message].map((message) => message.id));
        return null;
      },
    },
  });
  const publish = (inbound: NonNullable<OpenClawConfig["messages"]>["inbound"]) => {
    const cfg = { ...params.cfg, messages: { inbound } };
    setRuntimeConfigSnapshot(cfg, cfg);
  };
  const enqueue = (text: string) => {
    const message = new Message(client, {
      id: text,
      channel_id: "c1",
      content: text,
      author: {
        id: "U1",
        username: "alice",
        global_name: null,
        discriminator: "0",
        avatar: null,
      },
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      timestamp: "2026-09-04T00:00:00.000Z",
      edited_timestamp: null,
      type: MessageType.Default,
      tts: false,
      pinned: false,
    });
    return handler({ message, author: message.author, channel_id: message.channelId }, client);
  };
  vi.useFakeTimers();
  try {
    await enqueue("immediate");
    expect(dispatched).toEqual([["immediate"]]);

    publish({ debounceMs: 50 });
    await enqueue("first");
    await vi.advanceTimersByTimeAsync(25);
    expect(dispatched).toEqual([["immediate"]]);
    publish({ debounceMs: 50, byChannel: { discord: 10 } });
    await enqueue("second");
    await vi.advanceTimersByTimeAsync(9);
    expect(dispatched).toEqual([["immediate"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatched).toEqual([["immediate"], ["first", "second"]]);

    publish({ debounceMs: 50 });
    await enqueue("pending");
    publish({ debounceMs: 0 });
    await enqueue("after disable");
    expect(dispatched).toEqual([
      ["immediate"],
      ["first", "second"],
      ["pending"],
      ["after disable"],
    ]);

    publish({ debounceMs: 50 });
    await enqueue("cancel on shutdown");
    await handler.deactivate();
    await vi.advanceTimersByTimeAsync(50);
    expect(dispatched).toHaveLength(4);
  } finally {
    await handler.deactivate();
    vi.useRealTimers();
    clearRuntimeConfigSnapshot();
  }
});
