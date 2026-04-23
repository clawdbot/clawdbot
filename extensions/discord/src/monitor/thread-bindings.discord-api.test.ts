import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as discordClientModule from "../client.js";
import * as discordSendModule from "../send.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const DEFAULT_SEND_RESULT = {
  messageId: "msg-1",
  channelId: "thread-1",
};

const restGet = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const sendMessageDiscord = vi.fn<typeof discordSendModule.sendMessageDiscord>();
const sendWebhookMessageDiscord = vi.fn<typeof discordSendModule.sendWebhookMessageDiscord>();
const createDiscordRestClient = vi.fn<typeof discordClientModule.createDiscordRestClient>(
  () =>
    ({
      rest: {
        get: restGet,
      },
    }) as unknown as ReturnType<typeof discordClientModule.createDiscordRestClient>,
);

let maybeSendBindingMessage: typeof import("./thread-bindings.discord-api.js").maybeSendBindingMessage;
let resolveChannelIdForBinding: typeof import("./thread-bindings.discord-api.js").resolveChannelIdForBinding;

beforeAll(async () => {
  ({ maybeSendBindingMessage, resolveChannelIdForBinding } =
    await import("./thread-bindings.discord-api.js"));
});

describe("resolveChannelIdForBinding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    restGet.mockReset();
    sendMessageDiscord.mockReset().mockResolvedValue(DEFAULT_SEND_RESULT);
    sendWebhookMessageDiscord.mockReset().mockResolvedValue(DEFAULT_SEND_RESULT);
    createDiscordRestClient.mockReset().mockImplementation(
      () =>
        ({
          rest: {
            get: restGet,
          },
        }) as unknown as ReturnType<typeof discordClientModule.createDiscordRestClient>,
    );
    vi.spyOn(discordClientModule, "createDiscordRestClient").mockImplementation(
      (...args) =>
        createDiscordRestClient(...args) as unknown as ReturnType<
          typeof discordClientModule.createDiscordRestClient
        >,
    );
    vi.spyOn(discordSendModule, "sendMessageDiscord").mockImplementation((...args) =>
      sendMessageDiscord(...args),
    );
    vi.spyOn(discordSendModule, "sendWebhookMessageDiscord").mockImplementation((...args) =>
      sendWebhookMessageDiscord(...args),
    );
  });

  it("returns explicit channelId without resolving route", async () => {
    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "thread-1",
      channelId: "channel-explicit",
    });

    expect(resolved).toBe("channel-explicit");
    expect(createDiscordRestClient).not.toHaveBeenCalled();
    expect(restGet).not.toHaveBeenCalled();
  });

  it("normalizes prefixed explicit channelId without resolving route", async () => {
    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "thread-1",
      channelId: "channel:123456789012345678",
    });

    expect(resolved).toBe("123456789012345678");
    expect(createDiscordRestClient).not.toHaveBeenCalled();
    expect(restGet).not.toHaveBeenCalled();
  });

  it("strips channel prefix before resolving route", async () => {
    restGet.mockResolvedValueOnce({
      id: "123456789012345678",
      type: ChannelType.GuildText,
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "channel:123456789012345678",
    });

    expect(resolved).toBe("123456789012345678");
    const route = JSON.stringify(restGet.mock.calls[0]?.[0] ?? null);
    expect(route).toContain("123456789012345678");
    expect(route).not.toContain("channel:");
  });

  it("returns parent channel for thread channels", async () => {
    restGet.mockResolvedValueOnce({
      id: "thread-1",
      type: ChannelType.PublicThread,
      parent_id: "channel-parent",
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "thread-1",
    });

    expect(resolved).toBe("channel-parent");
  });

  it("forwards cfg when resolving channel id through Discord client", async () => {
    const cfg = {
      channels: { discord: { token: "tok" } },
    } as OpenClawConfig;
    restGet.mockResolvedValueOnce({
      id: "thread-1",
      type: ChannelType.PublicThread,
      parent_id: "channel-parent",
    });

    await resolveChannelIdForBinding({
      cfg,
      accountId: "default",
      threadId: "thread-1",
    });

    const createDiscordRestClientCalls = createDiscordRestClient.mock.calls as unknown[][];
    expect(createDiscordRestClientCalls[0]?.[1]).toBe(cfg);
  });

  it("keeps non-thread channel id even when parent_id exists", async () => {
    restGet.mockResolvedValueOnce({
      id: "channel-text",
      type: ChannelType.GuildText,
      parent_id: "category-1",
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "channel-text",
    });

    expect(resolved).toBe("channel-text");
  });

  it("keeps forum channel id instead of parent category", async () => {
    restGet.mockResolvedValueOnce({
      id: "forum-1",
      type: ChannelType.GuildForum,
      parent_id: "category-1",
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "forum-1",
    });

    expect(resolved).toBe("forum-1");
  });
});

describe("maybeSendBindingMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sendMessageDiscord.mockReset().mockResolvedValue(DEFAULT_SEND_RESULT);
    sendWebhookMessageDiscord.mockReset().mockResolvedValue(DEFAULT_SEND_RESULT);
    vi.spyOn(discordSendModule, "sendMessageDiscord").mockImplementation((...args) =>
      sendMessageDiscord(...args),
    );
    vi.spyOn(discordSendModule, "sendWebhookMessageDiscord").mockImplementation((...args) =>
      sendWebhookMessageDiscord(...args),
    );
  });

  it("forwards cfg to webhook send path", async () => {
    const cfg = {
      channels: { discord: { token: "tok" } },
    } as OpenClawConfig;
    const record = {
      accountId: "default",
      channelId: "parent-1",
      threadId: "thread-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:test",
      agentId: "main",
      boundBy: "test",
      boundAt: Date.now(),
      lastActivityAt: Date.now(),
      webhookId: "wh_1",
      webhookToken: "tok_1",
    } satisfies ThreadBindingRecord;

    await maybeSendBindingMessage({
      cfg,
      record,
      text: "hello webhook",
    });

    expect(sendWebhookMessageDiscord).toHaveBeenCalledTimes(1);
    expect(sendWebhookMessageDiscord.mock.calls[0]?.[1]).toMatchObject({
      cfg,
      webhookId: "wh_1",
      webhookToken: "tok_1",
      accountId: "default",
      threadId: "thread-1",
    });
    expect(sendMessageDiscord).not.toHaveBeenCalled();
  });
});
