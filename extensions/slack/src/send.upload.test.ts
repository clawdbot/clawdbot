import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSlackBlockTestMocks } from "./blocks.test-helpers.js";

// --- Module mocks (must precede dynamic import) ---
installSlackBlockTestMocks();
const loadOutboundMediaFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_mediaUrl: string, _options?: unknown) => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/png",
    kind: "image",
    fileName: "screenshot.png",
  })),
);
const fetchWithSsrFGuard = vi.fn(
  async (params: { url: string; init?: RequestInit }) =>
    ({
      response: await fetch(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }) as const,
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) =>
    fetchWithSsrFGuard(...(args as [params: { url: string; init?: RequestInit }])),
}));

vi.mock("openclaw/plugin-sdk/fetch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/fetch-runtime")>(
    "openclaw/plugin-sdk/fetch-runtime",
  );
  return {
    ...actual,
    withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: "trusted_env_proxy",
    }),
  };
});

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  const mockedLoadOutboundMediaFromUrl =
    loadOutboundMediaFromUrlMock as unknown as typeof actual.loadOutboundMediaFromUrl;
  return {
    ...actual,
    loadOutboundMediaFromUrl: (...args: Parameters<typeof actual.loadOutboundMediaFromUrl>) =>
      mockedLoadOutboundMediaFromUrl(...args),
  };
});

let sendMessageSlack: typeof import("./send.js").sendMessageSlack;
let clearSlackDmChannelCache: typeof import("./send.js").clearSlackDmChannelCache;
let clearSlackSendQueuesForTest: typeof import("./send.js").clearSlackSendQueuesForTest;
({ sendMessageSlack, clearSlackDmChannelCache, clearSlackSendQueuesForTest } =
  await import("./send.js"));
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

type UploadTestClient = WebClient & {
  conversations: { open: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn> };
  files: {
    getUploadURLExternal: ReturnType<typeof vi.fn>;
    completeUploadExternal: ReturnType<typeof vi.fn>;
  };
};

function createUploadTestClient(): UploadTestClient {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D99RESOLVED" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
    files: {
      getUploadURLExternal: vi.fn(async () => ({
        ok: true,
        upload_url: "https://uploads.slack.test/upload",
        file_id: "F001",
      })),
      completeUploadExternal: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as UploadTestClient;
}

describe("sendMessageSlack file upload with user IDs", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    fetchWithSsrFGuard.mockClear();
    loadOutboundMediaFromUrlMock.mockClear();
    clearSlackDmChannelCache();
    clearSlackSendQueuesForTest();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves bare user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    // Bare user ID — parseSlackTarget classifies this as kind="channel"
    await sendMessageSlack("U2ZH3MFSR", "screenshot", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/screenshot.png",
    });

    // Should call conversations.open to resolve user ID → DM channel
    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U2ZH3MFSR",
    });

    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D99RESOLVED",
        files: [expect.objectContaining({ id: "F001", title: "screenshot.png" })],
      }),
    );
  });

  it("resolves prefixed user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "image", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/photo.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "UABC123",
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("posts text-only user-target DMs directly without conversations.open", async () => {
    const client = createUploadTestClient();
    client.conversations.open.mockRejectedValueOnce(new Error("missing_scope"));

    await sendMessageSlack("user:UABC123", "first", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await sendMessageSlack("user:UABC123", "second", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "UABC123",
        text: "second",
      }),
    );
  });

  it("serializes concurrent sends to the same Slack target", async () => {
    const client = createUploadTestClient();
    let resolveFirst!: () => void;
    client.chat.postMessage.mockImplementation(async (payload: { text?: string }) => {
      if (payload.text === "first") {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return { ts: "1.000" };
      }
      return { ts: "2.000" };
    });

    const first = sendMessageSlack("channel:C123CHAN", "first", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await vi.waitFor(() => expect(client.chat.postMessage).toHaveBeenCalledTimes(1));

    const second = sendMessageSlack("channel:C123CHAN", "second", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await Promise.resolve();

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    resolveFirst();

    await expect(first).resolves.toEqual({ channelId: "C123CHAN", messageId: "1.000" });
    await expect(second).resolves.toEqual({ channelId: "C123CHAN", messageId: "2.000" });
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "second" }),
    );
  });

  it("scopes DM channel resolution cache by token identity", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "first", {
      token: "xoxb-test-a",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/first.png",
    });
    await sendMessageSlack("user:UABC123", "second", {
      token: "xoxb-test-b",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/second.png",
    });

    expect(client.conversations.open).toHaveBeenCalledTimes(2);
  });

  it("sends file directly to channel without conversations.open", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "chart", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/chart.png",
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "C123CHAN" }),
    );
  });

  it("resolves mention-style user ID before file upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("<@U777TEST>", "report", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/report.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U777TEST",
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("uploads bytes to the presigned URL and completes with thread+caption", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/threaded.png",
      threadTs: "171.222",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "screenshot.png",
      length: Buffer.from("fake-image").length,
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://uploads.slack.test/upload",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.slack.test/upload",
        mode: "trusted_env_proxy",
        auditContext: "slack-upload-file",
      }),
    );
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C123CHAN",
        initial_comment: "caption",
        thread_ts: "171.222",
      }),
    );
  });

  it("uses explicit upload filename and title overrides when provided", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/threaded.png",
      uploadFileName: "custom-name.bin",
      uploadTitle: "Custom Title",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ id: "F001", title: "Custom Title" })],
      }),
    );
  });

  it("uses uploadFileName as the title fallback when uploadTitle is omitted", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/threaded.png",
      uploadFileName: "custom-name.bin",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ id: "F001", title: "custom-name.bin" })],
      }),
    );
  });
});
