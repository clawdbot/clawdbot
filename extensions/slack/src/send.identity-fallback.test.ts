import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSendTestClient, installSlackBlockTestMocks } from "./blocks.test-helpers.js";

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: vi.fn(),
  danger: (message: string) => message,
  shouldLogVerbose: () => false,
}));

installSlackBlockTestMocks();
const { sendMessageSlack } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

type SlackMissingScopeError = Error & {
  data?: {
    error?: string;
    needed?: string;
    response_metadata?: { scopes?: string[]; acceptedScopes?: string[] };
  };
};

function buildMissingScopeError(overrides?: {
  needed?: string;
  scopes?: string[];
  acceptedScopes?: string[];
}): SlackMissingScopeError {
  const err = new Error("An API error occurred: missing_scope") as SlackMissingScopeError;
  const response_metadata =
    overrides?.scopes || overrides?.acceptedScopes
      ? {
          ...(overrides?.scopes ? { scopes: overrides.scopes } : {}),
          ...(overrides?.acceptedScopes ? { acceptedScopes: overrides.acceptedScopes } : {}),
        }
      : undefined;
  err.data = {
    error: "missing_scope",
    ...(overrides?.needed != null ? { needed: overrides.needed } : {}),
    ...(response_metadata ? { response_metadata } : {}),
  };
  return err;
}

describe("sendMessageSlack customize-scope fallback", () => {
  beforeEach(() => {
    vi.mocked(logVerbose).mockClear();
  });

  it("retries without identity when needed contains chat:write.customize", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage)
      .mockRejectedValueOnce(buildMissingScopeError({ needed: "chat:write.customize" }))
      .mockResolvedValueOnce({ ts: "171234.567" });

    const result = await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      identity: { username: "Bot", iconUrl: "https://example.com/bot.png" },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const [firstCall] = vi.mocked(client.chat.postMessage).mock.calls[0];
    const [secondCall] = vi.mocked(client.chat.postMessage).mock.calls[1];
    expect(firstCall).toEqual({
      channel: "C123",
      text: "hello",
      username: "Bot",
      icon_url: "https://example.com/bot.png",
    });
    expect(secondCall).toEqual({
      channel: "C123",
      text: "hello",
    });
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      "slack send: missing chat:write.customize, retrying without custom identity",
    );
    expect(result.messageId).toBe("171234.567");
  });

  it("retries when chat:write.customize appears only in response_metadata.acceptedScopes", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage)
      .mockRejectedValueOnce(
        buildMissingScopeError({ acceptedScopes: ["chat:write", "chat:write.customize"] }),
      )
      .mockResolvedValueOnce({ ts: "171234.567" });

    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      identity: { iconEmoji: ":robot_face:" },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const [secondCall] = vi.mocked(client.chat.postMessage).mock.calls[1];
    expect(secondCall).not.toHaveProperty("icon_emoji");
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      "slack send: missing chat:write.customize, retrying without custom identity",
    );
  });

  it("retries when chat:write.customize appears only in response_metadata.scopes", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage)
      .mockRejectedValueOnce(buildMissingScopeError({ scopes: ["chat:write.customize"] }))
      .mockResolvedValueOnce({ ts: "171234.567" });

    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      identity: { username: "Bot" },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      "slack send: missing chat:write.customize, retrying without custom identity",
    );
  });

  it("rethrows missing_scope errors that reference a different scope", async () => {
    const client = createSlackSendTestClient();
    const err = buildMissingScopeError({ needed: "channels:history" });
    vi.mocked(client.chat.postMessage).mockRejectedValueOnce(err);

    await expect(
      sendMessageSlack("channel:C123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        identity: { username: "Bot" },
      }),
    ).rejects.toThrow("An API error occurred: missing_scope (needed: channels:history)");

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("rethrows customize-scope errors when identity is empty", async () => {
    const client = createSlackSendTestClient();
    const err = buildMissingScopeError({ needed: "chat:write.customize" });
    vi.mocked(client.chat.postMessage).mockRejectedValueOnce(err);

    await expect(
      sendMessageSlack("channel:C123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
      }),
    ).rejects.toThrow("An API error occurred: missing_scope (needed: chat:write.customize)");

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("preserves Slack missing-scope details for delivery queue recovery", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage).mockRejectedValueOnce(
      buildMissingScopeError({
        needed: "im:write",
        scopes: ["chat:write", "users:read"],
        acceptedScopes: ["im:write", "mpim:write"],
      }),
    );

    await expect(
      sendMessageSlack("channel:C123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
      }),
    ).rejects.toThrow(
      "An API error occurred: missing_scope (needed: im:write; granted: chat:write, users:read; accepted: im:write, mpim:write)",
    );
  });

  it("preserves Slack missing-scope details while opening DMs", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.conversations.open).mockRejectedValueOnce(
      buildMissingScopeError({
        needed: "im:write",
        scopes: ["chat:write"],
      }),
    );

    await expect(
      sendMessageSlack("user:U123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        threadTs: "171234.100",
      }),
    ).rejects.toThrow(
      "An API error occurred: missing_scope (needed: im:write; granted: chat:write)",
    );
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});
