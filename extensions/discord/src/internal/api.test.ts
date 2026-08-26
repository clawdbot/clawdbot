// Discord tests cover api plugin behavior.
import { once } from "node:events";
import { createServer } from "node:http";
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
  listChannelPins,
  listGuildChannels,
  listGuildEmojis,
  overwriteApplicationCommands,
  pinChannelMessage,
  searchGuildMessages,
  sendChannelTyping,
  unpinChannelMessage,
} from "./api.js";
import { RequestClient } from "./rest.js";
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
      { method: "PUT", path: Routes.channelMessagesPin("c1", "m2") },
      { method: "DELETE", path: Routes.channelMessage("c1", "m2") },
    ]);
  });

  it("uses the current Discord routes for pinning and unpinning", async () => {
    const rest = createFakeRestClient([undefined, undefined]);

    await pinChannelMessage(rest, "c1", "m1");
    await unpinChannelMessage(rest, "c1", "m1");

    expect(rest.calls).toEqual([
      { method: "PUT", path: Routes.channelMessagesPin("c1", "m1") },
      { method: "DELETE", path: Routes.channelMessagesPin("c1", "m1") },
    ]);
  });

  it("paginates channel pins using the final pin timestamp as the next cursor", async () => {
    const firstPin = { pinned_at: "2026-01-02T00:00:00.000Z", message: { id: "m1" } };
    const secondPin = { pinned_at: "2026-01-01T00:00:00.000Z", message: { id: "m2" } };
    const rest = createFakeRestClient([
      { items: [firstPin], has_more: true },
      { items: [secondPin], has_more: false },
    ]);

    await expect(listChannelPins(rest, "c1")).resolves.toEqual([
      firstPin.message,
      secondPin.message,
    ]);
    expect(rest.calls).toEqual([
      { method: "GET", path: Routes.channelMessagesPins("c1"), query: { limit: 50 } },
      {
        method: "GET",
        path: Routes.channelMessagesPins("c1"),
        query: { limit: 50, before: firstPin.pinned_at },
      },
    ]);
  });

  it.each([
    { name: "missing page items", page: { has_more: false }, error: /invalid.*pin.*response/i },
    { name: "missing page cursor", page: { items: [], has_more: true }, error: /missing.*cursor/i },
    {
      name: "missing pin timestamp",
      page: { items: [{ message: { id: "m1" } }], has_more: true },
      error: /invalid.*pin/i,
    },
  ])("fails visibly on $name", async ({ page, error }) => {
    const rest = createFakeRestClient([page]);

    await expect(listChannelPins(rest, "c1")).rejects.toThrow(error);
  });

  it("rejects a repeated Discord pin pagination cursor", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const rest = createFakeRestClient([
      { items: [{ pinned_at: timestamp, message: { id: "m1" } }], has_more: true },
      { items: [{ pinned_at: timestamp, message: { id: "m2" } }], has_more: true },
    ]);

    await expect(listChannelPins(rest, "c1")).rejects.toThrow(/repeated.*cursor/i);
    expect(rest.calls).toHaveLength(2);
  });

  it("rejects a provider page larger than Discord's 50-pin maximum", async () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      pinned_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - index)).toISOString(),
      message: { id: `m${index}` },
    }));
    const rest = createFakeRestClient([{ items, has_more: false }]);

    await expect(listChannelPins(rest, "c1")).rejects.toThrow(/invalid.*pin.*response/i);
    expect(rest.calls).toHaveLength(1);
  });

  it("bounds Discord pin pagination by returned pins instead of assuming full pages", async () => {
    const pages = Array.from({ length: 251 }, (_, index) => ({
      items: [
        {
          pinned_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - index)).toISOString(),
          message: { id: `m${index}` },
        },
      ],
      has_more: true,
    }));
    const rest = createFakeRestClient(pages);

    await expect(listChannelPins(rest, "c1")).rejects.toThrow(/exceeded.*250/i);
    expect(rest.calls).toHaveLength(250);
  });

  it.each([
    { pinCount: 0, pageSize: 50 },
    { pinCount: 1, pageSize: 50 },
    { pinCount: 49, pageSize: 50 },
    { pinCount: 50, pageSize: 50 },
    { pinCount: 51, pageSize: 50 },
    { pinCount: 99, pageSize: 50 },
    { pinCount: 100, pageSize: 50 },
    { pinCount: 249, pageSize: 50 },
    { pinCount: 250, pageSize: 50 },
    { pinCount: 6, pageSize: 1 },
    { pinCount: 10, pageSize: 1 },
    { pinCount: 250, pageSize: 1 },
  ])(
    "reads all $pinCount pinned messages across authenticated provider pages of at most $pageSize",
    async ({ pinCount, pageSize }) => {
      const token = "discord-pin-http-fixture";
      const pins = Array.from({ length: pinCount }, (_, index) => ({
        pinned_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 1000 - index)).toISOString(),
        message: { id: `message-${index}` },
      }));
      const paths: string[] = [];
      const authorizationHeaders: Array<string | undefined> = [];
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        paths.push(url.pathname);
        authorizationHeaders.push(request.headers.authorization);
        response.setHeader("content-type", "application/json");

        if (url.pathname === "/v10/channels/c1/pins") {
          response.end(JSON.stringify(pins.slice(0, 50).map((pin) => pin.message)));
          return;
        }
        if (url.pathname !== "/v10/channels/c1/messages/pins") {
          response.statusCode = 404;
          response.end(JSON.stringify({ message: "unexpected Discord pin route" }));
          return;
        }

        const before = url.searchParams.get("before");
        const remaining = before ? pins.filter((pin) => pin.pinned_at < before) : pins;
        const items = remaining.slice(
          0,
          Math.min(pageSize, Number(url.searchParams.get("limit") ?? "50")),
        );
        response.end(JSON.stringify({ items, has_more: remaining.length > items.length }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");

      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Discord fixture failed to bind a TCP port");
        }
        const rest = new RequestClient(token, {
          baseUrl: `http://127.0.0.1:${address.port}`,
          queueRequests: false,
        });

        await expect(listChannelPins(rest, "c1")).resolves.toEqual(pins.map((pin) => pin.message));
        expect(paths).toHaveLength(Math.max(1, Math.ceil(pinCount / pageSize)));
        expect(paths.every((path) => path === "/v10/channels/c1/messages/pins")).toBe(true);
        expect(authorizationHeaders.every((header) => header === `Bot ${token}`)).toBe(true);
      } finally {
        server.close();
        await once(server, "close");
      }
    },
  );

  it("routes guild helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([
      [{ id: "c1" }],
      [{ id: "emoji1", name: "party", animated: true }],
      { id: "event1" },
      undefined,
    ]);
    const body = {
      name: "standup",
      scheduled_start_time: "2026-04-29T10:00:00.000Z",
      privacy_level: 2,
      entity_type: 3,
      entity_metadata: { location: "voice" },
    } as const;

    await expect(listGuildChannels(rest, "g1")).resolves.toEqual([{ id: "c1" }]);
    await expect(listGuildEmojis(rest, "g1")).resolves.toEqual([
      { id: "emoji1", name: "party", animated: true },
    ]);
    await expect(createGuildScheduledEvent(rest, "g1", body)).resolves.toEqual({ id: "event1" });
    await createGuildBan(rest, "g1", "u1", { body: { delete_message_seconds: 0 } });

    expect(rest.calls).toEqual([
      { method: "GET", path: Routes.guildChannels("g1") },
      { method: "GET", path: Routes.guildEmojis("g1") },
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

  it("rejects malformed guild emoji responses at the Discord REST boundary", async () => {
    await expect(listGuildEmojis(createFakeRestClient([{ invalid: true }]), "g1")).rejects.toThrow(
      "Invalid Discord guild emoji response.",
    );
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
    await expect(deleteWebhookMessage(rest, "app1", "wtoken", "m1")).resolves.toBeUndefined();
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
