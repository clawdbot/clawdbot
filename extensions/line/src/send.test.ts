import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  const pushMessageMock = vi.fn();
  const replyMessageMock = vi.fn();
  const showLoadingAnimationMock = vi.fn();
  const getProfileMock = vi.fn();
  const MessagingApiClientMock = vi.fn(function () {
    return {
      pushMessage: pushMessageMock,
      replyMessage: replyMessageMock,
      showLoadingAnimation: showLoadingAnimationMock,
      getProfile: getProfileMock,
    };
  });
  const requireRuntimeConfigMock = vi.fn((cfg: unknown) => cfg ?? {});
  const resolveLineAccountMock = vi.fn(() => ({ accountId: "default" }));
  const resolveLineChannelAccessTokenMock = vi.fn(() => "line-token");
  const recordChannelActivityMock = vi.fn();
  const logVerboseMock = vi.fn();
  const resolvePinnedHostnameWithPolicyMock = vi.fn();
  return {
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
  };
});

vi.mock("@line/bot-sdk", () => ({
  messagingApi: { MessagingApiClient: MessagingApiClientMock },
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  requireRuntimeConfig: requireRuntimeConfigMock,
}));

vi.mock("./accounts.js", () => ({
  resolveLineAccount: resolveLineAccountMock,
}));

vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock,
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
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

describe("LINE send helpers", () => {
  beforeAll(async () => {
    sendModule = await import("./send.js");
  });

  beforeEach(() => {
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
    expect(result).toEqual({ messageId: "push", chatId: "U123" });
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
    expect(result).toEqual({ messageId: "reply", chatId: "C1" });
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

  it("continues when loading animation is unsupported", async () => {
    showLoadingAnimationMock.mockRejectedValueOnce(new Error("unsupported"));

    await expect(
      sendModule.showLoadingAnimation("line:room:R1", { cfg: LINE_TEST_CFG }),
    ).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining("line: loading animation failed (non-fatal)"),
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
    const firstCall = pushMessageMock.mock.calls[0] as [
      { messages: Array<{ quickReply?: { items: unknown[] } }> },
    ];
    expect(firstCall[0].messages[0].quickReply?.items).toHaveLength(13);
  });
});
