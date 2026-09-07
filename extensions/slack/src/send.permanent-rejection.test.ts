import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it, vi } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import { rethrowSlackPermanentOutboundApiRejection } from "./client-delivery.js";
import { isSlackInvalidBlocksError } from "./native-data-blocks.js";

const { sendMessageSlack } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };
const SLACK_TEXT_LIMIT = 8000;

function slackPlatformError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: code },
  });
}

describe("sendMessageSlack permanent provider rejections", () => {
  it.each(["messages_tab_disabled", "account_inactive"])(
    "marks Slack %s as a permanent non-dispatch",
    async (code) => {
      const client = createSlackSendTestClient();
      const rejection = slackPlatformError(code);
      const onPlatformSendDispatch = vi.fn();
      client.chat.postMessage.mockRejectedValueOnce(rejection);

      const caught = await sendMessageSlack("channel:C123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        onPlatformSendDispatch,
      }).catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(caught).toMatchObject({ retryable: false, cause: rejection });
      expect(caught).toMatchObject({ message: expect.stringContaining(code) });
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
    },
  );

  it("marks account_inactive from durable DM resolution as a permanent non-dispatch", async () => {
    const client = createSlackSendTestClient();
    const rejection = slackPlatformError("account_inactive");
    client.conversations.open.mockRejectedValueOnce(rejection);

    const caught = await sendMessageSlack("user:U123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      deliveryQueueId: "queue-dm-account-inactive",
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(caught).toMatchObject({ retryable: false, cause: rejection });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("retains earlier Slack delivery evidence when a later chunk is permanently rejected", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage
      .mockResolvedValueOnce({ ts: "171234.100", channel: "C123" })
      .mockRejectedValueOnce(slackPlatformError("messages_tab_disabled"));
    const delivered: string[] = [];

    const caught = await sendMessageSlack("channel:C123", "a".repeat(SLACK_TEXT_LIMIT + 1), {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      onDeliveryResult: (result) => {
        delivered.push(result.messageId);
      },
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(delivered).toEqual(["171234.100"]);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("does not classify a persistence callback failure as a Slack API rejection", async () => {
    const client = createSlackSendTestClient();
    const callbackError = slackPlatformError("messages_tab_disabled");
    client.chat.postMessage.mockResolvedValueOnce({ ts: "171234.100", channel: "C123" });

    const caught = await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      onDeliveryResult: () => {
        throw callbackError;
      },
    }).catch((error: unknown) => error);

    expect(caught).toBe(callbackError);
    expect(caught).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });

  it.each([
    [
      "rate limit",
      Object.assign(new Error("A rate limit was exceeded"), {
        code: "slack_webapi_rate_limited_error",
        retryAfter: 1,
      }),
    ],
    [
      "HTTP 500",
      Object.assign(new Error("An HTTP protocol error occurred"), {
        code: "slack_webapi_http_error",
        statusCode: 500,
      }),
    ],
    [
      "network reset",
      Object.assign(new Error("A request error occurred: read ECONNRESET"), {
        code: "slack_webapi_request_error",
        original: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      }),
    ],
  ])("does not terminalize a Slack %s", async (_name, error) => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce(error);

    const caught = await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    }).catch((caughtError: unknown) => caughtError);

    expect(caught).toBe(error);
    expect(caught).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });

  it.each([
    ["null", null],
    ["an unlisted platform error code", slackPlatformError("channel_not_found")],
  ])("rethrows %s by identity", (_name, rejection) => {
    let caught: unknown = "not thrown";
    try {
      rethrowSlackPermanentOutboundApiRejection(rejection);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(rejection);
  });

  it("keeps a non-Error invalid_blocks rejection matchable after the send boundary", () => {
    let caught: unknown = "not thrown";
    try {
      rethrowSlackPermanentOutboundApiRejection({ data: { error: "invalid_blocks" } });
    } catch (error) {
      caught = error;
    }
    expect(isSlackInvalidBlocksError(caught)).toBe(true);
  });
});
