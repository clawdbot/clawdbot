import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const recordChannelActivityMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn(() => ({ channels: { discord: {} } })));
let dateNowSpy: ReturnType<typeof vi.spyOn>;

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

type MockWithCalls = { mock: { calls: unknown[][] } };

function firstMockCall(mock: MockWithCalls, label: string): unknown[] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("sendWebhookMessageDiscord activity", () => {
  beforeAll(async () => {
    ({ sendWebhookMessageDiscord } = await import("./send.webhook.js"));
  });

  beforeEach(() => {
    recordChannelActivityMock.mockClear();
    loadConfigMock.mockClear();
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
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
    dateNowSpy.mockRestore();
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
      receipt: {
        primaryPlatformMessageId: "msg-1",
        platformMessageIds: ["msg-1"],
        parts: [
          {
            platformMessageId: "msg-1",
            kind: "text",
            index: 0,
            threadId: "thread-1",
            raw: {
              channel: "discord",
              messageId: "msg-1",
              channelId: "thread-1",
            },
          },
        ],
        threadId: "thread-1",
        sentAt: 1_700_000_000_000,
        raw: [
          {
            channel: "discord",
            messageId: "msg-1",
            channelId: "thread-1",
          },
        ],
      },
    });
    expect(recordChannelActivityMock).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "runtime",
      direction: "outbound",
    });
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("rewrites configured mention aliases for webhook sends", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "resolved-token",
          mentionAliases: {
            opslead: "123456789012345678",
          },
        },
      },
    };
    await sendWebhookMessageDiscord("hello @OpsLead", {
      cfg,
      webhookId: "wh-1",
      webhookToken: "tok-1",
      accountId: "runtime",
      threadId: "thread-1",
    });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstMockCall(fetchMock, "fetch")).toEqual([
      "https://discord.com/api/v10/webhooks/wh-1/tok-1?wait=true&thread_id=thread-1",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content: "hello <@123456789012345678>",
        }),
      },
    ]);
  });
});
