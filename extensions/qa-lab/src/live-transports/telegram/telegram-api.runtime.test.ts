import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard }));

import {
  buildTelegramQaConfig,
  callTelegramApi,
  isRecoverableTelegramQaPollError,
  normalizeTelegramObservedMessage,
  parseTelegramQaCredentialPayload,
  resolveTelegramQaRuntimeEnv,
  TelegramQaApiError,
  waitForTelegramPollRetryDelay,
  waitForTelegramChannelRunning,
} from "./telegram-api.runtime.js";

describe("Telegram QA API boundary", () => {
  beforeEach(() => {
    fetchWithSsrFGuard.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses env and leased credential payloads", () => {
    expect(
      resolveTelegramQaRuntimeEnv({
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "placeholder",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "placeholder",
      }),
    ).toEqual({
      groupId: "-100123",
      driverToken: "placeholder",
      sutToken: "placeholder",
    });
    expect(
      parseTelegramQaCredentialPayload({
        groupId: "-100456",
        driverToken: "placeholder",
        sutToken: "placeholder",
      }),
    ).toEqual({
      groupId: "-100456",
      driverToken: "placeholder",
      sutToken: "placeholder",
    });
    expect(() =>
      parseTelegramQaCredentialPayload({
        groupId: "group-name",
        driverToken: "placeholder",
        sutToken: "placeholder",
      }),
    ).toThrow("numeric Telegram chat id");
  });

  it("normalizes rich edited messages and native reply metadata", () => {
    expect(
      normalizeTelegramObservedMessage({
        update_id: 9,
        edited_message: {
          message_id: 42,
          date: 123,
          chat: { id: -100123 },
          from: { id: 2, is_bot: true, username: "sut_bot" },
          rich_message: {
            blocks: [{ text: "final " }, { text: [{ text: "reply" }] }],
          },
          reply_to_message: { message_id: 41 },
        },
      }),
    ).toMatchObject({
      updateId: 9,
      messageId: 42,
      chatId: -100123,
      senderId: 2,
      senderIsBot: true,
      text: "final \nreply",
      replyToMessageId: 41,
      timestamp: 123_000,
    });
  });

  it("builds the isolated Telegram gateway config", () => {
    const config = buildTelegramQaConfig(
      { plugins: { allow: ["qa-lab"] } },
      {
        groupId: "-100123",
        sutToken: "placeholder",
        driverBotId: 1,
        sutAccountId: "sut",
        requireMention: true,
      },
    );

    expect(config.plugins?.allow).toEqual(["qa-lab", "telegram"]);
    expect(config.channels?.telegram).toMatchObject({
      enabled: true,
      defaultAccount: "sut",
      accounts: {
        sut: {
          botToken: "placeholder",
          dmPolicy: "disabled",
          groups: {
            "-100123": {
              groupPolicy: "allowlist",
              allowFrom: ["1"],
              requireMention: true,
            },
          },
        },
      },
    });
    expect(config.channels?.telegram?.accounts?.sut?.replyToMode).toBeUndefined();
  });

  it("disables mention gating only inside the exact leased QA group", () => {
    const config = buildTelegramQaConfig(
      {},
      {
        groupId: "-100123",
        sutToken: "placeholder",
        driverBotId: 1,
        sutAccountId: "sut",
        requireMention: false,
      },
    );

    expect(config.channels?.telegram?.groups).toBeUndefined();
    expect(config.channels?.telegram?.accounts?.sut?.groups).toEqual({
      "-100123": {
        groupPolicy: "allowlist",
        allowFrom: ["1"],
        requireMention: false,
      },
    });
  });

  it("waits for the selected Telegram account to become connected", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        channelAccounts: {
          telegram: [{ accountId: "sut", running: true, connected: false }],
        },
      })
      .mockResolvedValueOnce({
        channelAccounts: {
          telegram: [{ accountId: "sut", running: true, connected: true }],
        },
      });

    await waitForTelegramChannelRunning({ call }, "sut", { timeoutMs: 100, pollMs: 1 });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("classifies transient polling failures", () => {
    expect(isRecoverableTelegramQaPollError(new Error("socket hang up"))).toBe(true);
    expect(isRecoverableTelegramQaPollError(new Error("Telegram unauthorized"))).toBe(false);
  });

  it.each([
    { errorCode: 400, description: "Bad Request" },
    { errorCode: 401, description: "Unauthorized" },
    { errorCode: 404, description: "Not Found" },
    {
      errorCode: 409,
      description:
        "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
    },
  ])("preserves typed terminal Telegram $errorCode errors", async ({ errorCode, description }) => {
    const release = vi.fn();
    fetchWithSsrFGuard.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          ok: false,
          error_code: errorCode,
          description,
          parameters: { retry_after: 3 },
        }),
        { status: errorCode },
      ),
      release,
    });

    const error = await callTelegramApi("placeholder", "getUpdates").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TelegramQaApiError);
    expect(error).toMatchObject({
      method: "getUpdates",
      error_code: errorCode,
      description,
      parameters: { retry_after: 3 },
      status: errorCode,
    });
    expect(isRecoverableTelegramQaPollError(error)).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 502])("retries typed transient Telegram %s errors", (errorCode) => {
    expect(
      isRecoverableTelegramQaPollError(
        new TelegramQaApiError(
          "getUpdates",
          errorCode,
          "transient Telegram failure",
          undefined,
          errorCode,
        ),
      ),
    ).toBe(true);
  });

  it("honors retry_after and caps exponential poll backoff", async () => {
    vi.useFakeTimers();
    const rateLimit = new TelegramQaApiError(
      "getUpdates",
      429,
      "Too Many Requests",
      { retry_after: 3 },
      429,
    );
    const serverError = new TelegramQaApiError("getUpdates", 502, "Bad Gateway", undefined, 502);
    const cases = [
      { error: rateLimit, attempt: 7, delayMs: 3_000 },
      ...[250, 500, 1_000, 2_000, 2_000].map((delayMs, index) => ({
        error: serverError,
        attempt: index + 1,
        delayMs,
      })),
      ...[250, 500, 1_000, 2_000, 2_000].map((delayMs, index) => ({
        error: new Error("fetch failed"),
        attempt: index + 1,
        delayMs,
      })),
    ];

    for (const testCase of cases) {
      let settled = false;
      const waiting = waitForTelegramPollRetryDelay(
        testCase.error,
        testCase.attempt,
        new AbortController().signal,
      ).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(testCase.delayMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(settled).toBe(true);
    }
  });

  it("aborts an in-flight Telegram poll retry delay", async () => {
    const controller = new AbortController();
    const waiting = waitForTelegramPollRetryDelay(
      new TelegramQaApiError("getUpdates", 429, "Too Many Requests", { retry_after: 60 }, 429),
      1,
      controller.signal,
    );

    controller.abort(new Error("observer cleanup"));

    await expect(waiting).rejects.toThrow("aborted");
  });

  it("preserves a non-JSON HTTP error as a typed Telegram status and releases transport", async () => {
    const release = vi.fn();
    fetchWithSsrFGuard.mockResolvedValue({
      response: new Response("<html>bad gateway</html>", {
        headers: { "content-type": "text/html" },
        status: 502,
      }),
      release,
    });

    const error = await callTelegramApi("placeholder", "getUpdates").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TelegramQaApiError);
    expect(error).toMatchObject({
      method: "getUpdates",
      error_code: 502,
      description: "getUpdates failed with status 502",
      status: 502,
    });
    expect(isRecoverableTelegramQaPollError(error)).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});
