import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const recordChannelActivityMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn(() => ({ channels: { discord: {} } })));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: (cfg: unknown) => cfg ?? loadConfigMock(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivityMock(...args),
  };
});

let sendWebhookMessageDiscord: typeof import("./send.webhook.js").sendWebhookMessageDiscord;

describe("sendWebhookMessageDiscord activity", () => {
  beforeAll(async () => {
    ({ sendWebhookMessageDiscord } = await import("./send.webhook.js"));
  });

  beforeEach(() => {
    recordChannelActivityMock.mockClear();
    loadConfigMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ id: "msg-1", channel_id: "thread-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records outbound channel activity for webhook sends", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "resolved-token",
        },
      },
    };
    const result = await sendWebhookMessageDiscord("hello world", {
      cfg,
      webhookId: "wh-1",
      webhookToken: "tok-1",
      accountId: "runtime",
      threadId: "thread-1",
    });

    expect(result).toEqual({
      messageId: "msg-1",
      channelId: "thread-1",
    });
    expect(recordChannelActivityMock).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "runtime",
      direction: "outbound",
    });
    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});
