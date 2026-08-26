import { ChannelType, Routes } from "discord-api-types/v10";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDiscordMessageCreateAmbiguity } from "./retry.js";
import {
  makeDiscordRest,
  requestBody,
  requestPath,
  type MockCallSource,
} from "./send.test-harness.js";

let createThreadDiscord: typeof import("./send.js").createThreadDiscord;
let DiscordThreadInitialMessageError: typeof import("./send.js").DiscordThreadInitialMessageError;

const DISCORD_TEST_CFG = {
  channels: {
    discord: {
      accounts: {
        default: {},
      },
    },
  },
};

function discordClientOpts(rest: ReturnType<typeof makeDiscordRest>["rest"]) {
  return { cfg: DISCORD_TEST_CFG, rest, token: "t" };
}

const requireRecord = createRequireRecord("object", "expected-label");

beforeAll(async () => {
  ({ createThreadDiscord, DiscordThreadInitialMessageError } = await import("./send.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendMessageDiscord", () => {
  it("keeps forum starter messages within Discord's content limit", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    const content = "a".repeat(2001);

    await createThreadDiscord("chan1", { name: "thread", content }, discordClientOpts(rest));

    expect(postMock).toHaveBeenCalledTimes(2);
    expect(requestBody(postMock as unknown as MockCallSource, 0)).toEqual({
      name: "thread",
      message: { content: "a".repeat(2000) },
    });
    expect(requestPath(postMock as unknown as MockCallSource, 1)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(requestBody(postMock as unknown as MockCallSource, 1)).toMatchObject({
      content: "a",
      enforce_nonce: true,
    });
  });

  it("keeps sub-limit multi-line forum content in one starter message", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    const content = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");

    await createThreadDiscord("chan1", { name: "thread", content }, discordClientOpts(rest));

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(requestBody(postMock as unknown as MockCallSource)).toEqual({
      name: "thread",
      message: { content },
    });
  });

  it("reports a delivered forum starter when a continuation chunk fails", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock
      .mockResolvedValueOnce({ id: "t1", message: { id: "starter1", channel_id: "t1" } })
      .mockRejectedValueOnce(Object.assign(new Error("missing access"), { status: 403 }));

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "a".repeat(2001) },
        discordClientOpts(rest),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    expect(requireRecord(thrown, "thread initial message error").initialMessageDelivery).toEqual({
      starterMessageDelivered: true,
      deliveredChunkCount: 1,
      deliveredMessageIds: ["starter1"],
      failedChunkDelivery: "not_delivered",
      failedChunkIndex: 1,
      totalChunkCount: 2,
    });
  });

  it("reports an exhausted ambiguous forum continuation as unknown delivery", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    const ambiguous = Object.assign(new Error("response lost"), { status: 502 });
    postMock
      .mockResolvedValueOnce({ id: "t1", message: { id: "starter1", channel_id: "t1" } })
      .mockRejectedValue(ambiguous);

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "a".repeat(2001) },
        {
          ...discordClientOpts(rest),
          retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(postMock).toHaveBeenCalledTimes(3);
    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    expect(hasDiscordMessageCreateAmbiguity(thrown)).toBe(true);
    expect(requireRecord(thrown, "thread initial message error").message).toContain(
      "delivery of the remaining initial content could not be confirmed",
    );
    expect(requireRecord(thrown, "thread initial message error").initialMessageDelivery).toEqual({
      starterMessageDelivered: true,
      deliveredChunkCount: 1,
      deliveredMessageIds: ["starter1"],
      failedChunkDelivery: "unknown",
      failedChunkIndex: 1,
      totalChunkCount: 2,
    });
  });

  it("chunks long initial messages for non-forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    const content = "a".repeat(2001);

    await createThreadDiscord("chan1", { name: "thread", content }, discordClientOpts(rest));

    expect(postMock).toHaveBeenCalledTimes(3);
    expect(requestPath(postMock as unknown as MockCallSource, 1)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(requestBody(postMock as unknown as MockCallSource, 1)).toMatchObject({
      content: "a".repeat(2000),
      enforce_nonce: true,
    });
    expect(requestPath(postMock as unknown as MockCallSource, 2)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(requestBody(postMock as unknown as MockCallSource, 2)).toMatchObject({
      content: "a",
      enforce_nonce: true,
    });
  });

  it("keeps sub-limit multi-line non-forum content in one initial message", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1", channel_id: "t1" });
    const content = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");

    await createThreadDiscord("chan1", { name: "thread", content }, discordClientOpts(rest));

    expect(postMock).toHaveBeenCalledTimes(2);
    expect(requestBody(postMock as unknown as MockCallSource, 1)).toMatchObject({ content });
  });

  it("reports delivered non-forum chunks when a later chunk fails", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock
      .mockResolvedValueOnce({ id: "t1", name: "thread", type: ChannelType.PublicThread })
      .mockResolvedValueOnce({ id: "msg1", channel_id: "t1" })
      .mockRejectedValueOnce(Object.assign(new Error("missing access"), { status: 403 }));

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "a".repeat(4001) },
        discordClientOpts(rest),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    expect(requireRecord(thrown, "thread initial message error").initialMessageDelivery).toEqual({
      starterMessageDelivered: false,
      deliveredChunkCount: 1,
      deliveredMessageIds: ["msg1"],
      failedChunkDelivery: "not_delivered",
      failedChunkIndex: 1,
      totalChunkCount: 3,
    });
  });

  it("reports an exhausted ambiguous non-forum chunk as unknown delivery", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    const ambiguous = Object.assign(new Error("response lost"), { status: 502 });
    postMock
      .mockResolvedValueOnce({ id: "t1", name: "thread", type: ChannelType.PublicThread })
      .mockResolvedValueOnce({ id: "msg1", channel_id: "t1" })
      .mockRejectedValue(ambiguous);

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "a".repeat(4001) },
        {
          ...discordClientOpts(rest),
          retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(postMock).toHaveBeenCalledTimes(4);
    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    expect(hasDiscordMessageCreateAmbiguity(thrown)).toBe(true);
    expect(requireRecord(thrown, "thread initial message error").message).toContain(
      "delivery of the remaining initial content could not be confirmed",
    );
    expect(requireRecord(thrown, "thread initial message error").initialMessageDelivery).toEqual({
      starterMessageDelivered: false,
      deliveredChunkCount: 1,
      deliveredMessageIds: ["msg1"],
      failedChunkDelivery: "unknown",
      failedChunkIndex: 1,
      totalChunkCount: 3,
    });
  });

  it("retries continuation sends with a stable nonce per chunk", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock
      .mockResolvedValueOnce({ id: "t1", name: "thread", type: ChannelType.PublicThread })
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ id: "msg1", channel_id: "t1" })
      .mockResolvedValueOnce({ id: "msg2", channel_id: "t1" });

    await createThreadDiscord(
      "chan1",
      { name: "thread", content: "a".repeat(2001) },
      {
        ...discordClientOpts(rest),
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      },
    );

    expect(postMock).toHaveBeenCalledTimes(4);
    const firstAttempt = requestBody(postMock as unknown as MockCallSource, 1);
    const retryAttempt = requestBody(postMock as unknown as MockCallSource, 2);
    const nextChunk = requestBody(postMock as unknown as MockCallSource, 3);
    expect(firstAttempt.enforce_nonce).toBe(true);
    expect(retryAttempt.nonce).toBe(firstAttempt.nonce);
    expect(nextChunk.enforce_nonce).toBe(true);
    expect(nextChunk.nonce).not.toBe(firstAttempt.nonce);
  });
});
