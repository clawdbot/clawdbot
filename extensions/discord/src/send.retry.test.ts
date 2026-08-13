import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./internal/discord.js";
import {
  makeDiscordRest,
  type MockCallSource,
  requestBody,
  timerDelayAt,
} from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

let reactMessageDiscord: typeof import("./send.js").reactMessageDiscord;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;

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

function createRateLimitError(
  response: Response,
  body: { message: string; retry_after: number; global: boolean },
  request?: Request,
): RateLimitError {
  const fallbackRequest =
    request ??
    new Request("https://discord.com/api/v10/channels/789/messages", {
      method: "POST",
    });
  const RateLimitErrorCtor = RateLimitError as unknown as new (
    response: Response,
    body: { message: string; retry_after: number; global: boolean },
    request?: Request,
  ) => RateLimitError;
  return new RateLimitErrorCtor(response, body, fallbackRequest);
}

function createMockRateLimitError(retryAfter = 0.001): RateLimitError {
  const request = new Request("https://discord.com/api/v10/channels/789/messages", {
    method: "POST",
  });
  const response = new Response(null, {
    status: 429,
    headers: {
      "X-RateLimit-Scope": "user",
      "X-RateLimit-Bucket": "test-bucket",
    },
  });
  return createRateLimitError(
    response,
    {
      message: "You are being rate limited.",
      retry_after: retryAfter,
      global: false,
    },
    request,
  );
}

beforeAll(async () => {
  ({ reactMessageDiscord, sendMessageDiscord } = await import("./send.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/web-media");
});

describe("retry rate limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries on Discord rate limits", async () => {
    const { rest, postMock } = makeDiscordRest();
    const rateLimitError = createMockRateLimitError(0);

    postMock
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

    const res = await sendMessageDiscord("channel:789", "hello", {
      cfg: DISCORD_TEST_CFG,
      rest,
      token: "t",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(res.messageId).toBe("msg1");
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("uses retry_after delays when rate limited", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    try {
      const { rest, postMock } = makeDiscordRest();
      const rateLimitError = createMockRateLimitError(0.001);

      postMock
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

      const promise = sendMessageDiscord("channel:789", "hello", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
      });

      const result = await promise;
      expect(result.messageId).toBe("msg1");
      expect(result.channelId).toBe("789");
      expect(result.receipt.primaryPlatformMessageId).toBe("msg1");
      expect(result.receipt.platformMessageIds).toEqual(["msg1"]);
      expect(timerDelayAt(setTimeoutSpy as unknown as MockCallSource)).toBe(1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("stops after max retry attempts", async () => {
    const { rest, postMock } = makeDiscordRest();
    const rateLimitError = createMockRateLimitError(0);

    postMock.mockRejectedValue(rateLimitError);

    await expect(
      sendMessageDiscord("channel:789", "hello", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent non-rate-limit errors", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockRejectedValueOnce(new Error("invalid request"));

    await expect(
      sendMessageDiscord("channel:789", "hello", discordClientOpts(rest)),
    ).rejects.toThrow("invalid request");
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("retries ambiguous network errors with one stable enforced nonce", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

    const result = await sendMessageDiscord("channel:789", "hello", {
      cfg: DISCORD_TEST_CFG,
      rest,
      token: "t",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result.messageId).toBe("msg1");
    expect(postMock).toHaveBeenCalledTimes(2);
    const firstBody = requestBody(postMock as unknown as MockCallSource, 0);
    const secondBody = requestBody(postMock as unknown as MockCallSource, 1);
    expect(firstBody.enforce_nonce).toBe(true);
    expect(secondBody.nonce).toBe(firstBody.nonce);
  });

  it("retries reactions on rate limits", async () => {
    const { rest, putMock } = makeDiscordRest();
    const rateLimitError = createMockRateLimitError(0);

    putMock.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(undefined);

    const res = await reactMessageDiscord("chan1", "msg1", "ok", {
      cfg: DISCORD_TEST_CFG,
      rest,
      token: "t",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(res.ok).toBe(true);
    expect(putMock).toHaveBeenCalledTimes(2);
  });

  it("retries media upload without duplicating overflow text", async () => {
    const { rest, postMock } = makeDiscordRest();
    const rateLimitError = createMockRateLimitError(0);
    const text = "a".repeat(2005);

    postMock
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" })
      .mockResolvedValueOnce({ id: "msg2", channel_id: "789" });

    const res = await sendMessageDiscord("channel:789", text, {
      cfg: DISCORD_TEST_CFG,
      rest,
      token: "t",
      mediaUrl: "https://example.com/photo.jpg",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(res.messageId).toBe("msg1");
    expect(postMock).toHaveBeenCalledTimes(3);
  });
});
