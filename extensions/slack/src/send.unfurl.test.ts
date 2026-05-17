import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { sendMessageSlack } from "./send.js";

type SlackUnfurlTestClient = WebClient & {
  chat: { postMessage: ReturnType<typeof vi.fn> };
  conversations: { open: ReturnType<typeof vi.fn> };
};

function createSlackSendTestClient(): SlackUnfurlTestClient {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
  } as unknown as SlackUnfurlTestClient;
}

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

function missingCustomizeScopeError(): Error {
  return Object.assign(new Error("An API error occurred: missing_scope"), {
    data: {
      error: "missing_scope",
      needed: "chat:write.customize",
    },
  });
}

function requirePostMessagePayload(client: SlackUnfurlTestClient, index = 0) {
  const payload = client.chat.postMessage.mock.calls[index]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!payload) {
    throw new Error(`chat.postMessage call ${index} missing`);
  }
  return payload;
}

function requireLastPostMessagePayload(client: SlackUnfurlTestClient) {
  return requirePostMessagePayload(client, client.chat.postMessage.mock.calls.length - 1);
}

describe("sendMessageSlack unfurl controls", () => {
  it("defaults unfurl_links to false when config is unset", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      cfg: slackConfig({ botToken: "xoxb-test" }),
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const payload = requirePostMessagePayload(client);
    expect(payload.unfurl_links).toBe(false);
    expect("unfurl_media" in payload).toBe(false);
  });

  it("passes message metadata to chat.postMessage", async () => {
    const client = createSlackSendTestClient();
    const metadata = {
      event_type: "assistant_thread_context",
      event_payload: { channel_id: "C123", team_id: "T123" },
    };

    await sendMessageSlack("channel:C123", "assistant reply", {
      token: "xoxb-test",
      cfg: slackConfig({ botToken: "xoxb-test" }),
      client,
      metadata,
    });

    const payload = requirePostMessagePayload(client);
    expect(payload.metadata).toEqual(metadata);
  });

  it("passes top-level Slack unfurl flags to chat.postMessage", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      cfg: slackConfig({
        botToken: "xoxb-test",
        unfurlLinks: false,
        unfurlMedia: false,
      }),
      client,
    });

    const payload = requirePostMessagePayload(client);
    expect(payload.unfurl_links).toBe(false);
    expect(payload.unfurl_media).toBe(false);
  });

  it("lets account-level Slack unfurl flags override top-level defaults", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      accountId: "work",
      cfg: slackConfig({
        botToken: "xoxb-root",
        unfurlLinks: false,
        unfurlMedia: true,
        accounts: {
          work: {
            unfurlLinks: true,
            unfurlMedia: false,
          },
        },
      }),
      client,
    });

    const payload = requirePostMessagePayload(client);
    expect(payload.unfurl_links).toBe(true);
    expect(payload.unfurl_media).toBe(false);
  });

  it("applies Slack unfurl flags to block messages", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      cfg: slackConfig({
        botToken: "xoxb-test",
        unfurlLinks: false,
        unfurlMedia: false,
      }),
      client,
      blocks: [{ type: "divider" }],
    });

    const payload = requirePostMessagePayload(client);
    expect(payload.blocks).toEqual([{ type: "divider" }]);
    expect(payload.unfurl_links).toBe(false);
    expect(payload.unfurl_media).toBe(false);
  });

  it("preserves Slack unfurl flags when custom identity falls back", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage
      .mockRejectedValueOnce(missingCustomizeScopeError())
      .mockResolvedValueOnce({ ts: "171234.567" });

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      cfg: slackConfig({
        botToken: "xoxb-test",
        unfurlLinks: false,
        unfurlMedia: false,
      }),
      client,
      identity: {
        username: "OpenClaw",
      },
    });

    const payload = requireLastPostMessagePayload(client);
    expect(payload.unfurl_links).toBe(false);
    expect(payload.unfurl_media).toBe(false);
  });

  it("applies Slack unfurl flags to every text chunk", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "a".repeat(8500), {
      token: "xoxb-test",
      cfg: slackConfig({
        botToken: "xoxb-test",
        unfurlLinks: false,
        unfurlMedia: false,
      }),
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    for (const [payload] of client.chat.postMessage.mock.calls) {
      const postPayload = payload as Record<string, unknown>;
      expect(postPayload.unfurl_links).toBe(false);
      expect(postPayload.unfurl_media).toBe(false);
    }
  });
});
