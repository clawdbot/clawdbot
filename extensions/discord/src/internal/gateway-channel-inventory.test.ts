import { ChannelType, GatewayDispatchEvents } from "discord-api-types/v10";
import { expect, it } from "vitest";
import { GatewayPlugin } from "./gateway.js";
import { MessageCreateListener } from "./listeners.js";
import { createInternalTestClient } from "./test-builders.test-support.js";

it("resolves a real MESSAGE_CREATE channel from the gateway guild inventory", async () => {
  const client = createInternalTestClient();
  let received: unknown;
  let channelInfo: { name?: string; type: number } | undefined;
  client.registerListener(
    new (class extends MessageCreateListener {
      override handle(data: Parameters<MessageCreateListener["handle"]>[0]) {
        received = data;
        channelInfo = client.getGatewayChannelInfo(data.channel_id);
      }
    })(),
  );
  const gateway = new GatewayPlugin({ autoInteractions: false });
  // SAFETY: the fixture injects the registered client without opening a gateway socket.
  (gateway as unknown as { client: unknown }).client = client;
  const handleDispatch = (t: string, d: unknown): Promise<void> =>
    (
      gateway as unknown as {
        handleDispatch(payload: { t: string; d: unknown }): Promise<void>;
      }
    ).handleDispatch({ t, d });

  await handleDispatch(GatewayDispatchEvents.GuildCreate, {
    id: "g1",
    channels: [{ id: "c1", name: "general", type: 0 }],
    threads: [],
    members: [],
    voice_states: [],
  });
  await handleDispatch(GatewayDispatchEvents.MessageCreate, {
    id: "m1",
    channel_id: "c1",
    guild_id: "g1",
    content: "hello",
    attachments: [],
    timestamp: new Date().toISOString(),
    author: { id: "u1", username: "user", discriminator: "0", avatar: null },
    type: 0,
    tts: false,
    mention_everyone: false,
    pinned: false,
    flags: 0,
  });

  expect(received).not.toHaveProperty("channel_type");
  expect(channelInfo).toEqual({
    guildId: "g1",
    name: "general",
    type: ChannelType.GuildText,
  });
});
