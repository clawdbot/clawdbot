import { Routes } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
  createApplicationCommand,
  createChannelWebhook,
  createChannelMessage,
  createInteractionCallback,
  createGuildBan,
  createGuildScheduledEvent,
  createOwnMessageReaction,
  createThread,
  createUserDmChannel,
  deleteChannelMessage,
  deleteOwnMessageReaction,
  deleteWebhookMessage,
  editApplicationCommand,
  editWebhookMessage,
  getCurrentUser,
  getChannelMessage,
  getUser,
  getWebhookMessage,
  createWebhookMessage,
  listMessageReactionUsers,
  listApplicationCommands,
  listChannelMessages,
  listGuildChannels,
  overwriteApplicationCommands,
  pinChannelMessage,
  searchGuildMessages,
  sendChannelTyping,
} from "./api.js";
import { createFakeRestClient } from "./test-builders.test-support.js";

describe("Discord REST API helpers", () => {
  it("routes message helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([
      [{ id: "m1" }],
      { id: "m2" },
      { id: "m3" },
      { id: "t1" },
      undefined,
      undefined,
      undefined,
    ]);
    const query = { limit: 2 };

    await expect(listChannelMessages(rest, "c1", query)).resolves.toEqual([{ id: "m1" }]);
    await expect(getChannelMessage(rest, "c1", "m2")).resolves.toEqual({ id: "m2" });
    await expect(createChannelMessage(rest, "c1", { body: { content: "hello" } })).resolves.toEqual(
      { id: "m3" },
    );
    await expect(createThread(rest, "c1", { body: { name: "thread" } }, "m2")).resolves.toEqual({
      id: "t1",
    });
    await sendChannelTyping(rest, "c1");
    await pinChannelMessage(rest, "c1", "m2");
    await deleteChannelMessage(rest, "c1", "m2");

    expect(rest.calls).toEqual([
      { method: "GET", path: Routes.channelMessages("c1"), query },
      { method: "GET", path: Routes.channelMessage("c1", "m2") },
      {
        method: "POST",
        path: Routes.channelMessages("c1"),
        data: { body: { content: "hello" } },
      },
      {
        method: "POST",
        path: Routes.threads("c1", "m2"),
        data: { body: { name: "thread" } },
      },
      { method: "POST", path: Routes.channelTyping("c1") },
      { method: "PUT", path: Routes.channelPin("c1", "m2") },
      { method: "DELETE", path: Routes.channelMessage("c1", "m2") },
    ]);
  });

  it("routes guild helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([[{ id: "c1" }], { id: "event1" }, undefined]);
    const body = {
      name: "standup",
      scheduled_start_time: "2026-04-29T10:00:00.000Z",
      privacy_level: 2,
      entity_type: 3,
      entity_metadata: { location: "voice" },
    } as const;

    await expect(listGuildChannels(rest, "g1")).resolves.toEqual([{ id: "c1" }]);
    await expect(createGuildScheduledEvent(rest, "g1", body)).resolves.toEqual({ id: "event1" });
    await createGuildBan(rest, "g1", "u1", { body: { delete_message_seconds: 0 } });

    expect(rest.calls).toEqual([
      { method: "GET", path: Routes.guildChannels("g1") },
      {
        method: "POST",
        path: Routes.guildScheduledEvents("g1"),
        data: { body },
      },
      {
        method: "PUT",
        path: Routes.guildBan("g1", "u1"),
        data: { body: { delete_message_seconds: 0 } },
      },
    ]);
  });

  it("routes command helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([
      [{ id: "cmd1" }],
      { id: "cmd2" },
      { id: "cmd3" },
      undefined,
    ]);

    await expect(listApplicationCommands(rest, "app1")).resolves.toEqual([{ id: "cmd1" }]);
    await expect(createApplicationCommand(rest, "app1", { name: "ping" })).resolves.toEqual({
      id: "cmd2",
    });
    await expect(
      editApplicationCommand(rest, "app1", "cmd2", { description: "Pong" }),
    ).resolves.toEqual({ id: "cmd3" });
    await overwriteApplicationCommands(rest, "app1", [{ name: "ping" }]);

    expect(rest.calls).toEqual([
      { method: "GET", path: Routes.applicationCommands("app1") },
      {
        method: "POST",
        path: Routes.applicationCommands("app1"),
        data: { body: { name: "ping" } },
      },
      {
        method: "PATCH",
        path: Routes.applicationCommand("app1", "cmd2"),
        data: { body: { description: "Pong" } },
      },
      {
        method: "PUT",
        path: Routes.applicationCommands("app1"),
        data: { body: [{ name: "ping" }] },
      },
    ]);
  });

  it("routes user helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([{ id: "me" }, { id: "u1" }, { id: "dm1" }]);

    await expect(getCurrentUser(rest)).resolves.toEqual({ id: "me" });
    await expect(getUser(rest, "u1")).resolves.toEqual({ id: "u1" });
    await expect(createUserDmChannel(rest, "u1")).resolves.toEqual({ id: "dm1" });

    expect(rest.calls).toEqual([
      { method: "GET", path: Routes.user("@me") },
      { method: "GET", path: Routes.user("u1") },
      {
        method: "POST",
        path: Routes.userChannels(),
        data: { body: { recipient_id: "u1" } },
      },
    ]);
  });

  it("routes reaction helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([undefined, [{ id: "u1" }], undefined]);
    const query = { limit: 10 };

    await createOwnMessageReaction(rest, "c1", "m1", "%F0%9F%91%8D");
    await expect(
      listMessageReactionUsers(rest, "c1", "m1", "%F0%9F%91%8D", query),
    ).resolves.toEqual([{ id: "u1" }]);
    await deleteOwnMessageReaction(rest, "c1", "m1", "%F0%9F%91%8D");

    expect(rest.calls).toEqual([
      {
        method: "PUT",
        path: Routes.channelMessageOwnReaction("c1", "m1", "%F0%9F%91%8D"),
      },
      {
        method: "GET",
        path: Routes.channelMessageReaction("c1", "m1", "%F0%9F%91%8D"),
        query,
      },
      {
        method: "DELETE",
        path: Routes.channelMessageOwnReaction("c1", "m1", "%F0%9F%91%8D"),
      },
    ]);
  });

  it("routes webhook helper through the typed REST client", async () => {
    const rest = createFakeRestClient([{ id: "wh1", token: "token1" }]);

    await expect(createChannelWebhook(rest, "c1", { body: { name: "OpenClaw" } })).resolves.toEqual(
      {
        id: "wh1",
        token: "token1",
      },
    );

    expect(rest.calls).toEqual([
      {
        method: "POST",
        path: Routes.channelWebhooks("c1"),
        data: { body: { name: "OpenClaw" } },
      },
    ]);
  });

  it("routes interaction webhook helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([
      { ok: true },
      { id: "m1" },
      { id: "m2" },
      { id: "m3" },
      undefined,
    ]);
    const query = { wait: "true" };

    await expect(createInteractionCallback(rest, "i1", "itoken", { type: 5 })).resolves.toEqual({
      ok: true,
    });
    await expect(
      createWebhookMessage(rest, "app1", "wtoken", { body: { content: "hello" } }, query),
    ).resolves.toEqual({ id: "m1" });
    await expect(getWebhookMessage(rest, "app1", "wtoken", "m1")).resolves.toEqual({ id: "m2" });
    await expect(
      editWebhookMessage(rest, "app1", "wtoken", "m1", { body: { content: "updated" } }),
    ).resolves.toEqual({ id: "m3" });
    await deleteWebhookMessage(rest, "app1", "wtoken", "m1");

    expect(rest.calls).toEqual([
      {
        method: "POST",
        path: Routes.interactionCallback("i1", "itoken"),
        data: { body: { type: 5 } },
      },
      {
        method: "POST",
        path: Routes.webhook("app1", "wtoken"),
        data: { body: { content: "hello" } },
        query,
      },
      { method: "GET", path: Routes.webhookMessage("app1", "wtoken", "m1") },
      {
        method: "PATCH",
        path: Routes.webhookMessage("app1", "wtoken", "m1"),
        data: { body: { content: "updated" } },
      },
      { method: "DELETE", path: Routes.webhookMessage("app1", "wtoken", "m1") },
    ]);
  });

  it("keeps unsupported Discord search route isolated", async () => {
    const rest = createFakeRestClient([{ messages: [] }]);
    const params = new URLSearchParams({ content: "hello" });

    await expect(searchGuildMessages(rest, "g1", params)).resolves.toEqual({ messages: [] });

    expect(rest.calls).toEqual([
      { method: "GET", path: "/guilds/g1/messages/search?content=hello" },
    ]);
  });
});
