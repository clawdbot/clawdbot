import { createServer, type Server } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestClient } from "../internal/rest.js";
import { sendPollDiscord, sendStickerDiscord } from "../send.outbound.js";
import { handleDiscordMessageAction } from "./handle-action.js";
import { handleDiscordAction } from "./runtime.js";
import { discordMessagingActionRuntime as runtime } from "./runtime.messaging.runtime.js";

const channelId = "123456789012345678";
const messageId = "223456789012345678";
const guildId = "323456789012345678";
const token = "synthetic-message-body-token";
const attachment = { id: "423456789012345678", filename: "example.txt", size: 4 };
const cfg: OpenClawConfig = {
  channels: { discord: { token, groupPolicy: "open" } },
};
const original = { ...runtime };
const originalFetch = globalThis.fetch;
let server: Server;
let rest: RequestClient;
let requests: { method: string; path: string; body: Record<string, unknown> }[];
let current: { content: string; attachments: (typeof attachment)[] };
let unexpectedUrls: string[];
let rejectStructuredCaptionTails: boolean;

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      expect(request.headers.authorization).toBe(`Bot ${token}`);
      const parts: Buffer[] = [];
      for await (const part of request) {
        parts.push(Buffer.from(part));
      }
      const body = JSON.parse(Buffer.concat(parts).toString() || "{}") as Record<string, unknown>;
      const method = request.method ?? "";
      const path = request.url ?? "";
      requests.push({ method, path, body });
      if (typeof body.content === "string" && body.content.length > 2000) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "Content exceeds Discord's 2000 character limit" }));
        return;
      }
      if (
        rejectStructuredCaptionTails &&
        method === "POST" &&
        !("poll" in body) &&
        !("sticker_ids" in body)
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "Synthetic caption tail failure" }));
        return;
      }
      if (method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      if (method === "PATCH") {
        current = { ...current, ...body };
      }
      const result =
        method === "GET"
          ? path.startsWith("/v10/guilds/")
            ? { id: guildId, name: "synthetic-guild" }
            : { id: channelId, type: 0, guild_id: guildId, name: "synthetic-channel" }
          : { id: messageId, channel_id: channelId, ...current, ...body };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP fixture did not bind a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== baseUrl) {
      unexpectedUrls.push(url.href);
      throw new Error("HTTP fixture refused a request outside its loopback server");
    }
    return originalFetch(input, init);
  });
  rest = new RequestClient(token, { baseUrl, timeout: 5000 });
  vi.spyOn(runtime, "editMessageDiscord").mockImplementation((channel, id, payload, opts) =>
    original.editMessageDiscord(channel, id, payload, { ...opts, rest }),
  );
  vi.spyOn(runtime, "deleteMessageDiscord").mockImplementation((channel, id, opts) =>
    original.deleteMessageDiscord(channel, id, { ...opts, rest }),
  );
  vi.spyOn(runtime, "fetchChannelInfoDiscord").mockImplementation((channel, opts) =>
    original.fetchChannelInfoDiscord(channel, { ...opts, rest }),
  );
  vi.spyOn(runtime, "fetchGuildInfoDiscord").mockImplementation((guild, opts) =>
    original.fetchGuildInfoDiscord(guild, { ...opts, rest }),
  );
  vi.spyOn(runtime, "sendMessageDiscord").mockImplementation((to, content, opts) =>
    original.sendMessageDiscord(to, content, { ...opts, rest }),
  );
  vi.spyOn(runtime, "sendDiscordComponentMessage").mockImplementation((to, spec, opts) =>
    original.sendDiscordComponentMessage(to, spec, { ...opts, rest }),
  );
  vi.spyOn(runtime, "sendStickerDiscord").mockImplementation((to, ids, opts) =>
    original.sendStickerDiscord(to, ids, { ...opts, rest }),
  );
  vi.spyOn(runtime, "createThreadDiscord").mockImplementation((channel, payload, opts) =>
    original.createThreadDiscord(channel, payload, { ...opts, rest }),
  );
});

beforeEach(() => {
  requests = [];
  unexpectedUrls = [];
  current = { content: "Initial caption", attachments: [attachment] };
  rejectStructuredCaptionTails = false;
});

afterEach(() => {
  expect(unexpectedUrls).toEqual([]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  rest?.abortAllRequests();
  server?.closeAllConnections();
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

const writes = () => requests.filter((request) => request.method !== "GET");

describe.each(["runtime", "adapter"] as const)("Discord %s message bodies", (entry) => {
  const send = (content: unknown, extra: Record<string, unknown> = {}) =>
    entry === "runtime"
      ? handleDiscordAction(
          { action: "sendMessage", to: ` channel:${channelId} `, content, ...extra },
          cfg,
        )
      : handleDiscordMessageAction({
          action: "send",
          params: { to: ` channel:${channelId} `, message: content, ...extra },
          cfg,
        });
  const edit = (content: unknown, config = cfg, id: unknown = messageId) =>
    entry === "runtime"
      ? handleDiscordAction({ action: "editMessage", channelId, messageId: id, content }, config, {
          conversationReadOrigin: "direct-operator",
        })
      : handleDiscordMessageAction({
          action: "edit",
          params: { to: `channel:${channelId}`, messageId: id, message: content },
          cfg: config,
          conversationReadOrigin: "direct-operator",
        });

  it.each(["Changed caption", "    console.log(1);\n", ""])(
    "edits exact content %j and retains attachments",
    async (content) => {
      await edit(content);
      expect(writes()).toEqual([
        {
          method: "PATCH",
          path: `/v10/channels/${channelId}/messages/${messageId}`,
          body: { content },
        },
      ]);
      expect(current).toEqual({ content, attachments: [attachment] });
    },
  );

  it.each([undefined, null, 42])(
    "rejects absent or non-string edit content %j without mutation",
    async (content) => {
      await expect(edit(content)).rejects.toThrow(/required/);
      expect(writes()).toEqual([]);
    },
  );

  it.each([null, "", "   "])("rejects missing message ID %j without mutation", async (id) => {
    await expect(edit("Changed caption", cfg, id)).rejects.toThrow(/required/);
    expect(writes()).toEqual([]);
  });

  it("normalizes identifiers without normalizing the message body", async () => {
    const content = "  Changed caption\n";
    await edit(content, cfg, ` ${messageId} `);
    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: `/v10/channels/${channelId}/messages/${messageId}`,
        body: { content },
      },
    ]);
  });

  it.each([undefined, null, 42])(
    "rejects plain sends without string content %j",
    async (content) => {
      await expect(send(content)).rejects.toThrow(/required/);
      expect(writes()).toEqual([]);
    },
  );

  it("delivers embeds without a text body", async () => {
    const embeds = [{ title: "Release notes", description: "Version available" }];
    await send(undefined, { embeds });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "POST",
      path: `/v10/channels/${channelId}/messages`,
      body: { embeds },
    });
    expect(writes()[0]?.body).not.toHaveProperty("content");
  });

  it("delivers presentation text without a separate message body", async () => {
    const text = "-# Revenue (bar chart)\n- USD: Q1: 12; Q2: 18";
    await send(
      undefined,
      entry === "adapter"
        ? {
            presentation: {
              blocks: [
                {
                  type: "chart",
                  chartType: "bar",
                  title: "Revenue",
                  categories: ["Q1", "Q2"],
                  series: [{ name: "USD", values: [12, 18] }],
                },
              ],
            },
          }
        : { components: { blocks: [{ type: "text", text }] } },
    );
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "POST",
      path: `/v10/channels/${channelId}/messages`,
      body: { components: [{ type: 17, components: [{ type: 10, content: text }] }] },
    });
    expect(writes()[0]?.body).not.toHaveProperty("content");
  });

  it("keeps disabled and blocked edit targets from mutating", async () => {
    await expect(
      edit("caption", { channels: { discord: { token, actions: { messages: false } } } }),
    ).rejects.toThrow(/disabled/);
    await expect(
      edit("caption", { channels: { discord: { token, groupPolicy: "disabled" } } }),
    ).rejects.toThrow(/not allowed/);
    expect(writes()).toEqual([]);
  });

  it("deletes the exact message through the same target projection", async () => {
    if (entry === "runtime") {
      await handleDiscordAction({ action: "deleteMessage", channelId, messageId }, cfg, {
        conversationReadOrigin: "direct-operator",
      });
    } else {
      await handleDiscordMessageAction({
        action: "delete",
        params: { to: `channel:${channelId}`, messageId },
        cfg,
        conversationReadOrigin: "direct-operator",
      });
    }
    expect(writes()).toEqual([
      { method: "DELETE", path: `/v10/channels/${channelId}/messages/${messageId}`, body: {} },
    ]);
  });

  it.each(["send", "thread-reply", "thread-create", "sticker"] as const)(
    "preserves indentation and trailing newline for %s",
    async (action) => {
      const content = "    console.log(1);\n";
      if (entry === "adapter") {
        await handleDiscordMessageAction({
          action,
          params: {
            to: `channel:${channelId}`,
            channelId,
            threadId: channelId,
            threadName: "example",
            message: content,
            stickerId: ["523456789012345678"],
          },
          cfg,
        });
      } else {
        const actions = {
          send: "sendMessage",
          "thread-reply": "threadReply",
          "thread-create": "threadCreate",
          sticker: "sticker",
        };
        await handleDiscordAction(
          {
            action: actions[action],
            to: `channel:${channelId}`,
            channelId,
            name: "example",
            content,
            stickerIds: ["523456789012345678"],
          },
          cfg,
        );
      }
      const messages = writes().filter((request) => request.path.endsWith("/messages"));
      expect(messages).toHaveLength(1);
      expect(messages[0]?.body.content).toBe(content);
    },
  );
});

describe.each(["sticker", "poll"] as const)("Discord structured %s content", (kind) => {
  it.each([
    [undefined, undefined],
    [" \n", undefined],
    ["Caption", "Caption"],
    ["  Caption\n", "  Caption\n"],
  ])("preserves optional content %j when nonblank", async (content, expected) => {
    const options = { cfg, rest, content };
    if (kind === "sticker") {
      await sendStickerDiscord(`channel:${channelId}`, ["523456789012345678"], options);
    } else {
      await sendPollDiscord(
        `channel:${channelId}`,
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        options,
      );
    }
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body.content).toBe(expected);
    expect(writes()[0]?.body).toHaveProperty(kind === "sticker" ? "sticker_ids" : "poll");
  });

  it("applies the configured Discord Markdown and mention formatting", async () => {
    const formattedCfg: OpenClawConfig = {
      channels: {
        discord: {
          token,
          groupPolicy: "open",
          markdown: { tables: "code" },
          mentionAliases: { ops: "523456789012345678" },
        },
      },
    };
    const content = "__Important__ @ops\n\n| A | B |\n| - | - |\n| x | y |";
    const options = { cfg: formattedCfg, rest, content };
    if (kind === "sticker") {
      await sendStickerDiscord(`channel:${channelId}`, ["523456789012345678"], options);
    } else {
      await sendPollDiscord(
        `channel:${channelId}`,
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        options,
      );
    }

    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body.content).toBe(
      "**Important** <@523456789012345678>\n\n```\n| A | B |\n| --- | --- |\n| x | y |\n```",
    );
  });

  it("chunks captions that formatting expands past Discord's limit", async () => {
    const formattedCfg: OpenClawConfig = {
      channels: {
        discord: {
          token,
          groupPolicy: "open",
          markdown: { tables: "code" },
        },
      },
    };
    const prefix = "x".repeat(1960);
    const content = `${prefix}\n\n| A | B |\n| - | - |\n| x | y |`;
    const options = { cfg: formattedCfg, rest, content, allowedMentions: { parse: [] } };
    const result =
      kind === "sticker"
        ? await sendStickerDiscord(`channel:${channelId}`, ["523456789012345678"], options)
        : await sendPollDiscord(
            `channel:${channelId}`,
            { question: "Lunch?", options: ["Pizza", "Sushi"] },
            options,
          );

    expect(writes()).toHaveLength(2);
    const [structuredWrite, tailWrite] = writes();
    const sentContents = writes().map((write) =>
      typeof write.body.content === "string" ? write.body.content : "",
    );
    expect(sentContents[0]?.startsWith(prefix)).toBe(true);
    expect(sentContents.join("").replace(/`{3,}/gu, "").replace(/\s/gu, "")).toBe(
      `${prefix}|A|B||---|---||x|y|`,
    );
    expect(structuredWrite?.body).toHaveProperty(kind === "sticker" ? "sticker_ids" : "poll");
    expect(tailWrite?.body.content).not.toBe("");
    expect(tailWrite?.body).not.toHaveProperty("sticker_ids");
    expect(tailWrite?.body).not.toHaveProperty("poll");
    expect(writes().map((write) => write.body.allowed_mentions)).toEqual([
      { parse: [] },
      { parse: [] },
    ]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual([
      kind === "sticker" ? "card" : "poll",
      "text",
    ]);
    expect(sentContents.every((sentContent) => sentContent.length <= 2000)).toBe(true);
  });

  it("reports the structured delivery before a caption tail fails", async () => {
    const content = `${"x".repeat(1990)}\n\n| A | B |\n| - | - |\n| x | y |`;
    const onDeliveryResult = vi.fn();
    rejectStructuredCaptionTails = true;
    const options = {
      cfg: {
        channels: {
          discord: { token, groupPolicy: "open" as const, markdown: { tables: "code" as const } },
        },
      },
      rest,
      content,
      onDeliveryResult,
    };

    await expect(
      kind === "sticker"
        ? sendStickerDiscord(`channel:${channelId}`, ["523456789012345678"], options)
        : sendPollDiscord(
            `channel:${channelId}`,
            { question: "Lunch?", options: ["Pizza", "Sushi"] },
            options,
          ),
    ).rejects.toThrow("Synthetic caption tail failure");

    expect(writes()).toHaveLength(2);
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId,
        receipt: expect.objectContaining({
          primaryPlatformMessageId: messageId,
          parts: [expect.objectContaining({ kind: kind === "sticker" ? "card" : "poll" })],
        }),
      }),
    );
  });
});

it("reports sticker delivery through the channel action before a caption tail fails", async () => {
  const onDeliveryResult = vi.fn();
  rejectStructuredCaptionTails = true;

  await expect(
    handleDiscordMessageAction({
      action: "sticker",
      params: {
        to: `channel:${channelId}`,
        stickerId: ["523456789012345678"],
        message: `${"x".repeat(1990)}\n\n| A | B |\n| - | - |\n| x | y |`,
      },
      cfg: {
        channels: {
          discord: { token, groupPolicy: "open", markdown: { tables: "code" } },
        },
      },
      onDeliveryResult,
    }),
  ).rejects.toThrow("Synthetic caption tail failure");

  expect(onDeliveryResult).toHaveBeenCalledOnce();
  expect(onDeliveryResult).toHaveBeenCalledWith(
    expect.objectContaining({
      messageId,
      target: { kind: "channel", id: channelId },
      receipt: expect.objectContaining({ primaryPlatformMessageId: messageId }),
    }),
  );
  expect(onDeliveryResult.mock.calls[0]?.[0]).not.toHaveProperty("channel");
});
