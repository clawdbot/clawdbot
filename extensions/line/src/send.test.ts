// Line tests cover send plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  pushMessageMock,
  replyMessageMock,
  showLoadingAnimationMock,
  getProfileMock,
  MessagingApiClientMock,
  requireRuntimeConfigMock,
  resolveLineAccountMock,
  resolveLineChannelAccessTokenMock,
  recordChannelActivityMock,
  logVerboseMock,
  resolvePinnedHostnameWithPolicyMock,
} = vi.hoisted(() => {
  const pushMessageMockLocal = vi.fn();
  const replyMessageMockLocal = vi.fn();
  const showLoadingAnimationMockLocal = vi.fn();
  const getProfileMockLocal = vi.fn();
  const MessagingApiClientMockLocal = vi.fn(function () {
    return {
      pushMessage: pushMessageMockLocal,
      replyMessage: replyMessageMockLocal,
      showLoadingAnimation: showLoadingAnimationMockLocal,
      getProfile: getProfileMockLocal,
    };
  });
  const requireRuntimeConfigMockLocal = vi.fn((cfg: unknown) => cfg ?? {});
  const resolveLineAccountMockLocal = vi.fn(() => ({ accountId: "default" }));
  const resolveLineChannelAccessTokenMockLocal = vi.fn(() => "line-token");
  const recordChannelActivityMockLocal = vi.fn();
  const logVerboseMockLocal = vi.fn();
  const resolvePinnedHostnameWithPolicyMockLocal = vi.fn();
  return {
    pushMessageMock: pushMessageMockLocal,
    replyMessageMock: replyMessageMockLocal,
    showLoadingAnimationMock: showLoadingAnimationMockLocal,
    getProfileMock: getProfileMockLocal,
    MessagingApiClientMock: MessagingApiClientMockLocal,
    requireRuntimeConfigMock: requireRuntimeConfigMockLocal,
    resolveLineAccountMock: resolveLineAccountMockLocal,
    resolveLineChannelAccessTokenMock: resolveLineChannelAccessTokenMockLocal,
    recordChannelActivityMock: recordChannelActivityMockLocal,
    logVerboseMock: logVerboseMockLocal,
    resolvePinnedHostnameWithPolicyMock: resolvePinnedHostnameWithPolicyMockLocal,
  };
});

vi.mock("@line/bot-sdk", () => ({
  messagingApi: { MessagingApiClient: MessagingApiClientMock },
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: requireRuntimeConfigMock,
}));

vi.mock("./accounts.js", () => ({
  resolveLineAccount: resolveLineAccountMock,
}));

vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock,
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", () => ({
  recordChannelActivity: recordChannelActivityMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: logVerboseMock,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

let sendModule: typeof import("./send.js");

const LINE_TEST_CFG = {
  channels: {
    line: {
      accounts: {
        default: {},
      },
    },
  },
};

function createCredentialBearingHttpUrl(): string {
  const url = new URL("http://example.com/image.jpg");
  url.username = ["line", "user"].join("-");
  url.password = ["line", "fixture"].join("-");
  url.searchParams.set("auth", ["line", "query"].join("-"));
  return url.href;
}

describe("LINE send helpers", () => {
  const fixedSentAt = 1_800_000_000_000;

  beforeAll(async () => {
    sendModule = await import("./send.js");
  });

  afterAll(() => {
    vi.doUnmock("@line/bot-sdk");
    vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./channel-access-token.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.setSystemTime(fixedSentAt);
    pushMessageMock.mockReset();
    replyMessageMock.mockReset();
    showLoadingAnimationMock.mockReset();
    getProfileMock.mockReset();
    MessagingApiClientMock.mockReset();
    requireRuntimeConfigMock.mockClear();
    resolveLineAccountMock.mockReset();
    resolveLineChannelAccessTokenMock.mockReset();
    recordChannelActivityMock.mockReset();
    logVerboseMock.mockReset();
    resolvePinnedHostnameWithPolicyMock.mockReset();

    MessagingApiClientMock.mockImplementation(function () {
      return {
        pushMessage: pushMessageMock,
        replyMessage: replyMessageMock,
        showLoadingAnimation: showLoadingAnimationMock,
        getProfile: getProfileMock,
      };
    });
    requireRuntimeConfigMock.mockImplementation((cfg: unknown) => cfg ?? LINE_TEST_CFG);
    resolveLineAccountMock.mockReturnValue({ accountId: "default" });
    resolveLineChannelAccessTokenMock.mockReturnValue("line-token");
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    pushMessageMock.mockResolvedValue({});
    replyMessageMock.mockResolvedValue({});
    showLoadingAnimationMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("limits quick reply items to 13", () => {
    const labels = Array.from({ length: 20 }, (_, index) => `Option ${index + 1}`);
    const quickReply = sendModule.createQuickReplyItems(labels);

    expect(quickReply.items).toHaveLength(13);
  });

  it("counts quick reply labels in grapheme clusters", () => {
    const label = "1234567890123456789😀";
    const quickReply = sendModule.createQuickReplyItems([label]);
    const item = quickReply.items?.[0] as { action: { label: string; text: string } } | undefined;

    expect(item?.action.label).toBe(label);
    expect(item?.action.text).toBe(label);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(item?.action.label ?? "")).toBe(false);
  });

  it("normalizes raw Flex actions at both outbound API boundaries", async () => {
    const oversizedPostback = { type: "postback", label: "Open", data: "x".repeat(301) };
    const oversizedUri = {
      type: "uri",
      label: "Open",
      uri: `https://e.example/?q=${"x".repeat(1200)}`,
    };
    const message = {
      type: "flex",
      altText: "Raw Flex",
      contents: {
        type: "bubble",
        action: oversizedPostback,
        hero: {
          type: "video",
          url: "https://e.example/video.mp4",
          previewUrl: "https://e.example/preview.jpg",
          altContent: {
            type: "image",
            url: "https://e.example/preview.jpg",
            size: "full",
          },
          action: oversizedUri,
        },
        body: {
          type: "box",
          layout: "vertical",
          action: oversizedPostback,
          contents: [
            { type: "text", text: "Open", action: oversizedUri },
            { type: "button", action: oversizedPostback },
            {
              type: "text",
              text: "Still works",
              action: { type: "message", label: "Unavailable", text: "keep" },
            },
          ],
        },
      },
    };

    await sendModule.pushMessagesLine("U123", [message] as never, { cfg: LINE_TEST_CFG });
    await sendModule.replyMessageLine("reply-token", [message] as never, { cfg: LINE_TEST_CFG });

    const pushed = pushMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ contents: Record<string, unknown> }>;
    };
    const replied = replyMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ contents: Record<string, unknown> }>;
    };
    expect(pushed.messages[0]?.contents).toEqual(replied.messages[0]?.contents);

    const contents = pushed.messages[0]?.contents as {
      action?: unknown;
      hero: { type: string; action?: unknown };
      body: { action?: unknown; contents: Array<{ action?: unknown; text?: string }> };
    };
    const unavailableAction = {
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    };
    expect(contents.action).toBeUndefined();
    expect(contents.hero).toEqual({
      type: "video",
      url: "https://e.example/video.mp4",
      previewUrl: "https://e.example/preview.jpg",
      altContent: {
        type: "image",
        url: "https://e.example/preview.jpg",
        size: "full",
      },
    });
    expect(contents.body.action).toBeUndefined();
    expect(contents.body.contents[0]?.action).toBeUndefined();
    expect(contents.body.contents[1]?.action).toEqual(unavailableAction);
    expect(contents.body.contents[2]?.action).toEqual({
      type: "message",
      label: "Unavailable",
      text: "keep",
    });
    expect(contents.body.contents.slice(3).map((item) => item.text)).toEqual([
      "Action unavailable: callback data exceeds LINE's limit.\nLink unavailable: URL exceeds LINE's limit.",
    ]);
    expect(message.contents.action).toBe(oversizedPostback);
  });

  it("normalizes raw imagemap actions at both outbound API boundaries", async () => {
    const area = { x: 0, y: 0, width: 520, height: 1040 };
    const videoArea = { x: 520, y: 0, width: 520, height: 1040 };
    const message = {
      type: "imagemap",
      baseUrl: "https://e.example/imagemap",
      altText: "Map",
      baseSize: { width: 1040, height: 1040 },
      actions: [
        {
          type: "uri",
          label: "Open",
          linkUri: `https://e.example/?q=${"x".repeat(1200)}`,
          area,
        },
        ...Array.from({ length: 49 }, (_, index) => ({
          type: "message",
          label: `Item ${index}`,
          text: `item-${index}`,
          area,
        })),
      ],
      video: {
        originalContentUrl: "https://e.example/video.mp4",
        previewImageUrl: "https://e.example/preview.jpg",
        area: videoArea,
        externalLink: {
          linkUri: `https://e.example/video?q=${"x".repeat(1200)}`,
          label: "Open video",
        },
      },
    };

    await sendModule.pushMessagesLine("U123", [message] as never, { cfg: LINE_TEST_CFG });
    await sendModule.replyMessageLine("reply-token", [message] as never, { cfg: LINE_TEST_CFG });

    const pushed = pushMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ actions: unknown[]; video?: { externalLink?: unknown } }>;
    };
    const replied = replyMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ actions: unknown[] }>;
    };
    expect(pushed.messages[0]?.actions).toEqual(replied.messages[0]?.actions);
    expect(pushed.messages[0]?.actions).toHaveLength(50);
    expect(pushed.messages[0]?.actions[0]).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
      area,
    });
    expect(pushed.messages[0]?.actions[1]).toMatchObject({
      type: "message",
      text: "item-0",
    });
    expect(pushed.messages[0]?.actions[49]).toMatchObject({
      type: "message",
      text: "item-48",
    });
    expect(pushed.messages[0]?.video?.externalLink).toBeUndefined();
    expect(message.actions[0]?.type).toBe("uri");
  });

  it("counts imagemap message text in UTF-16 units at both outbound API boundaries", async () => {
    const area = { x: 0, y: 0, width: 1040, height: 1040 };
    const exactText = "😀".repeat(200);
    const message = {
      type: "imagemap",
      baseUrl: "https://e.example/imagemap",
      altText: "Map",
      baseSize: { width: 1040, height: 1040 },
      actions: [
        { type: "message", label: "Exact", text: exactText, area },
        { type: "message", label: "Too long", text: `${exactText}😀`, area },
      ],
    };

    await sendModule.pushMessagesLine("U123", [message] as never, { cfg: LINE_TEST_CFG });
    await sendModule.replyMessageLine("reply-token", [message] as never, { cfg: LINE_TEST_CFG });

    const pushed = pushMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ actions: unknown[] }>;
    };
    const replied = replyMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ actions: unknown[] }>;
    };
    expect(pushed.messages[0]?.actions).toEqual(replied.messages[0]?.actions);
    expect(pushed.messages[0]?.actions).toEqual([
      { type: "message", label: "Exact", text: exactText, area },
      {
        type: "message",
        label: "Unavailable",
        text: "Action unavailable: message text exceeds LINE's limit.",
        area,
      },
    ]);
  });

  it("counts imagemap video-link labels in UTF-16 units", async () => {
    const message = {
      type: "imagemap",
      baseUrl: "https://e.example/imagemap",
      altText: "Map",
      baseSize: { width: 1040, height: 1040 },
      actions: [],
      video: {
        originalContentUrl: "https://e.example/video.mp4",
        previewImageUrl: "https://e.example/preview.jpg",
        area: { x: 0, y: 0, width: 1040, height: 1040 },
        externalLink: {
          linkUri: "https://e.example/video",
          label: "😀".repeat(16),
        },
      },
    };

    await sendModule.pushMessagesLine("U123", [message] as never, { cfg: LINE_TEST_CFG });

    const pushed = pushMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ video: { externalLink: { label: string } } }>;
    };
    expect(pushed.messages[0]?.video.externalLink.label).toBe("😀".repeat(15));
  });

  it("pushes images via normalized LINE target", async () => {
    const result = await sendModule.pushImageMessage(
      "line:user:U123",
      "https://example.com/original.jpg",
      undefined,
      { cfg: LINE_TEST_CFG, verbose: true },
    );

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U123",
      messages: [
        {
          type: "image",
          originalContentUrl: "https://example.com/original.jpg",
          previewImageUrl: "https://example.com/original.jpg",
        },
      ],
    });
    expect(recordChannelActivityMock).toHaveBeenCalledWith({
      channel: "line",
      accountId: "default",
      direction: "outbound",
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: pushed image to U123");
    expect(result).toEqual({
      chatId: "U123",
      messageId: "push",
      receipt: {
        parts: [
          {
            index: 0,
            kind: "media",
            platformMessageId: "push",
            raw: {
              channel: "line",
              chatId: "U123",
              conversationId: "U123",
              messageId: "push",
              meta: { messageCount: 1 },
            },
            threadId: "U123",
          },
        ],
        platformMessageIds: ["push"],
        primaryPlatformMessageId: "push",
        raw: [
          {
            channel: "line",
            chatId: "U123",
            conversationId: "U123",
            messageId: "push",
            meta: { messageCount: 1 },
          },
        ],
        sentAt: fixedSentAt,
        threadId: "U123",
      },
    });
  });

  it("replies when reply token is provided", async () => {
    const result = await sendModule.sendMessageLine("line:group:C1", "Hello", {
      cfg: LINE_TEST_CFG,
      replyToken: "reply-token",
      mediaUrl: "https://example.com/media.jpg",
      verbose: true,
    });

    expect(replyMessageMock).toHaveBeenCalledTimes(1);
    expect(pushMessageMock).not.toHaveBeenCalled();
    expect(replyMessageMock).toHaveBeenCalledWith({
      replyToken: "reply-token",
      messages: [
        {
          type: "image",
          originalContentUrl: "https://example.com/media.jpg",
          previewImageUrl: "https://example.com/media.jpg",
        },
        {
          type: "text",
          text: "Hello",
        },
      ],
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: replied to C1");
    expect(result).toEqual({
      chatId: "C1",
      messageId: "reply",
      receipt: {
        parts: [
          {
            index: 0,
            kind: "media",
            platformMessageId: "reply",
            raw: {
              channel: "line",
              chatId: "C1",
              conversationId: "C1",
              messageId: "reply",
              meta: { messageCount: 2 },
            },
            threadId: "C1",
          },
        ],
        platformMessageIds: ["reply"],
        primaryPlatformMessageId: "reply",
        raw: [
          {
            channel: "line",
            chatId: "C1",
            conversationId: "C1",
            messageId: "reply",
            meta: { messageCount: 2 },
          },
        ],
        sentAt: fixedSentAt,
        threadId: "C1",
      },
    });
  });

  it("preserves literal internal-looking text in low-level sends", async () => {
    const text = "⚠️ 🛠️ `search repos (agent)` failed";

    await sendModule.sendMessageLine("line:user:U123", text, { cfg: LINE_TEST_CFG });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U123",
      messages: [{ type: "text", text }],
    });
  });

  it("sends video with explicit image preview URL", async () => {
    await sendModule.sendMessageLine("line:user:U100", "Video", {
      cfg: LINE_TEST_CFG,
      mediaUrl: "https://example.com/video.mp4",
      mediaKind: "video",
      previewImageUrl: "https://example.com/preview.jpg",
      trackingId: "track-1",
    });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U100",
      messages: [
        {
          type: "video",
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
          trackingId: "track-1",
        },
        {
          type: "text",
          text: "Video",
        },
      ],
    });
  });

  it("throws when video preview URL is missing", async () => {
    await expect(
      sendModule.sendMessageLine("line:user:U200", "Video", {
        cfg: LINE_TEST_CFG,
        mediaUrl: "https://example.com/video.mp4",
        mediaKind: "video",
      }),
    ).rejects.toThrow(/require previewimageurl/i);
  });

  it("blocks private-network media URLs before calling LINE", async () => {
    resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
      new Error("SSRF blocked private network target"),
    );

    await expect(
      sendModule.sendMessageLine("line:user:U200", "Image", {
        cfg: LINE_TEST_CFG,
        mediaUrl: "https://127.0.0.1/image.jpg",
      }),
    ).rejects.toThrow(/private network/i);

    expect(pushMessageMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "send media URL",
      run: () =>
        sendModule.sendMessageLine("line:user:U200", "Image", {
          cfg: LINE_TEST_CFG,
          mediaUrl: createCredentialBearingHttpUrl(),
        }),
    },
    {
      name: "send preview URL",
      run: () =>
        sendModule.sendMessageLine("line:user:U200", "Video", {
          cfg: LINE_TEST_CFG,
          mediaUrl: "https://example.com/video.mp4",
          mediaKind: "video",
          previewImageUrl: createCredentialBearingHttpUrl(),
        }),
    },
    {
      name: "push image URL",
      run: () =>
        sendModule.pushImageMessage("line:user:U200", createCredentialBearingHttpUrl(), undefined, {
          cfg: LINE_TEST_CFG,
        }),
    },
    {
      name: "push image preview URL",
      run: () =>
        sendModule.pushImageMessage(
          "line:user:U200",
          "https://example.com/image.jpg",
          createCredentialBearingHttpUrl(),
          { cfg: LINE_TEST_CFG },
        ),
    },
  ])("does not expose credentials from an insecure $name", async ({ run }) => {
    await expect(run()).rejects.toThrow(new Error("LINE outbound media URL must use HTTPS"));
    expect(pushMessageMock).not.toHaveBeenCalled();
    expect(replyMessageMock).not.toHaveBeenCalled();
  });

  it("omits trackingId for non-user destinations", async () => {
    await sendModule.sendMessageLine("line:group:C100", "Video", {
      cfg: LINE_TEST_CFG,
      mediaUrl: "https://example.com/video.mp4",
      mediaKind: "video",
      previewImageUrl: "https://example.com/preview.jpg",
      trackingId: "track-group",
    });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "C100",
      messages: [
        {
          type: "video",
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
        },
        {
          type: "text",
          text: "Video",
        },
      ],
    });
  });

  it("throws when push messages are empty", async () => {
    await expect(sendModule.pushMessagesLine("U123", [], { cfg: LINE_TEST_CFG })).rejects.toThrow(
      "Message must be non-empty for LINE sends",
    );
  });

  it("rejects lowercased LINE-shaped recipients (#81628 safety net)", async () => {
    // 33-char value with lowercase leading char — what an upstream session-key
    // fragment looked like before the cron-tool fix. LINE rejects with HTTP 400
    // anyway; throwing locally keeps the failure permanent so delivery-recovery
    // moves the entry to failed/ immediately instead of silently retrying 5×.
    await expect(
      sendModule.pushMessagesLine(
        "cabcdef0123456789abcdef0123456789",
        [{ type: "text", text: "hello" }],
        { cfg: LINE_TEST_CFG },
      ),
    ).rejects.toThrow(/Recipient is not a valid LINE id/);
    expect(pushMessageMock).not.toHaveBeenCalled();
  });

  it("preserves UTF-16 boundaries in invalid recipient diagnostics", async () => {
    await expect(
      sendModule.pushMessagesLine(`aab😀${"x".repeat(40)}`, [{ type: "text", text: "hello" }], {
        cfg: LINE_TEST_CFG,
      }),
    ).rejects.toThrow(
      "Recipient is not a valid LINE id (case-sensitive; expected leading capital C/U/R): aab…",
    );
    await expect(
      sendModule.pushMessagesLine(`aa😀${"y".repeat(40)}`, [{ type: "text", text: "hello" }], {
        cfg: LINE_TEST_CFG,
      }),
    ).rejects.toThrow(
      "Recipient is not a valid LINE id (case-sensitive; expected leading capital C/U/R): aa😀…",
    );
    expect(pushMessageMock).not.toHaveBeenCalled();
  });

  it("accepts case-exact LINE recipients with the leading capital preserved", async () => {
    await sendModule.pushMessagesLine(
      "Cabcdef0123456789abcdef0123456789",
      [{ type: "text", text: "hello" }],
      { cfg: LINE_TEST_CFG },
    );
    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "Cabcdef0123456789abcdef0123456789",
      messages: [{ type: "text", text: "hello" }],
    });
  });

  it("logs HTTP body when push fails", async () => {
    const err = new Error("LINE push failed") as Error & {
      status: number;
      statusText: string;
      body: string;
    };
    err.status = 400;
    err.statusText = "Bad Request";
    err.body = "invalid flex payload";
    pushMessageMock.mockRejectedValueOnce(err);

    await expect(
      sendModule.pushMessagesLine("U999", [{ type: "text", text: "hello" }], {
        cfg: LINE_TEST_CFG,
      }),
    ).rejects.toThrow("LINE push failed");

    expect(logVerboseMock).toHaveBeenCalledWith(
      "line: push message failed (400 Bad Request): invalid flex payload",
    );
  });

  it("caches profile results by default", async () => {
    getProfileMock.mockResolvedValue({
      displayName: "Peter",
      pictureUrl: "https://example.com/peter.jpg",
    });

    const first = await sendModule.getUserProfile("U-cache", { cfg: LINE_TEST_CFG });
    const second = await sendModule.getUserProfile("U-cache", { cfg: LINE_TEST_CFG });

    expect(first).toEqual({
      displayName: "Peter",
      pictureUrl: "https://example.com/peter.jpg",
    });
    expect(second).toEqual(first);
    expect(getProfileMock).toHaveBeenCalledTimes(1);
  });

  it("bounds profile cache entries across distinct users", async () => {
    getProfileMock.mockImplementation(async (userId: string) => ({
      displayName: userId,
    }));

    for (let index = 0; index <= 1000; index += 1) {
      await sendModule.getUserProfile(`U-profile-${index}`, { cfg: LINE_TEST_CFG });
    }
    await sendModule.getUserProfile("U-profile-0", { cfg: LINE_TEST_CFG });

    expect(getProfileMock).toHaveBeenCalledTimes(1002);
  });

  it("continues when loading animation is unsupported", async () => {
    showLoadingAnimationMock.mockRejectedValueOnce(new Error("unsupported"));

    await expect(
      sendModule.showLoadingAnimation("line:room:R1", { cfg: LINE_TEST_CFG }),
    ).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      "line: loading animation failed (non-fatal): Error: unsupported",
    );
  });

  it("pushes quick-reply text and caps to 13 buttons", async () => {
    await sendModule.pushTextMessageWithQuickReplies(
      "U-quick",
      "Pick one",
      Array.from({ length: 20 }, (_, index) => `Choice ${index + 1}`),
      { cfg: LINE_TEST_CFG },
    );

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = pushMessageMock.mock.calls.at(0) as [
      { messages: Array<{ quickReply?: { items: unknown[] } }> },
    ];
    const payload = expectDefined(firstCall[0], "LINE push payload");
    expect(expectDefined(payload.messages[0], "LINE push message").quickReply?.items).toHaveLength(
      13,
    );
  });
});
