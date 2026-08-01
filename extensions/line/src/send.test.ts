import { HTTPFetchError } from "@line/bot-sdk";
// Line tests cover send plugin behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  pushMessageMock,
  replyMessageMock,
  lineFetchMock,
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
  const lineFetchMockLocal = vi.fn();
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
    lineFetchMock: lineFetchMockLocal,
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

vi.mock("@line/bot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@line/bot-sdk")>();
  return {
    ...actual,
    messagingApi: { ...actual.messagingApi, MessagingApiClient: MessagingApiClientMock },
  };
});

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

  function expectedMediaSendResult(chatId: string, messageId: string, messageCount: number) {
    const raw = {
      channel: "line",
      chatId,
      conversationId: chatId,
      messageId,
      meta: { messageCount },
    };
    return {
      chatId,
      messageId,
      receipt: {
        parts: [{ index: 0, kind: "media", platformMessageId: messageId, raw, threadId: chatId }],
        platformMessageIds: [messageId],
        primaryPlatformMessageId: messageId,
        raw: [raw],
        sentAt: fixedSentAt,
        threadId: chatId,
      },
    };
  }

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
    lineFetchMock.mockReset();
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
    pushMessageMock.mockResolvedValue({ sentMessages: [{ id: "push" }] });
    replyMessageMock.mockResolvedValue({ sentMessages: [{ id: "reply" }] });
    showLoadingAnimationMock.mockResolvedValue({});
    lineFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (typeof init?.body !== "string") {
        throw new Error("LINE test fetch requires a JSON string request body");
      }
      const payload = JSON.parse(init.body);
      const provider = requestUrl.endsWith("/push") ? pushMessageMock : replyMessageMock;
      const body = await provider(payload);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", lineFetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("limits quick reply items to 13", () => {
    const labels = [
      ...Array.from({ length: 13 }, () => " \t "),
      ...Array.from({ length: 14 }, (_, index) => `  Option ${index + 1}  `),
    ];
    const quickReply = sendModule.createQuickReplyItems(labels);

    expect(quickReply.items).toHaveLength(13);
    expect(quickReply.items?.map((item) => item.action?.label)).toEqual(
      Array.from({ length: 13 }, (_, index) => `Option ${index + 1}`),
    );
    expect(
      sendModule.createTextMessageWithQuickReplies("Pick one", [" \t "]).quickReply,
    ).toBeUndefined();
  });

  it("counts quick reply labels in grapheme clusters", () => {
    const label = "1234567890123456789😀";
    const quickReply = sendModule.createQuickReplyItems([label]);
    const item = quickReply.items?.[0] as { action: { label: string; text: string } } | undefined;

    expect(item?.action.label).toBe(label);
    expect(item?.action.text).toBe(label);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(item?.action.label ?? "")).toBe(false);
  });

  it("keeps provider-valid Flex text across helpers and direct pushes", async () => {
    const contents = { type: "bubble" as const };
    const altText = "a".repeat(1200);

    expect(sendModule.createFlexMessage(altText, contents).altText).toBe(altText);

    const oversized = sendModule.createFlexMessage(`${"a".repeat(1499)}😀 overflow`, contents);
    expect(oversized.altText).toBe("a".repeat(1499));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(oversized.altText)).toBe(false);
    await sendModule.pushFlexMessage("U123", altText, { type: "bubble" }, { cfg: LINE_TEST_CFG });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U123",
      messages: [{ type: "flex", altText, contents: { type: "bubble" } }],
    });
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
    expect(result).toEqual(expectedMediaSendResult("U123", "push", 1));
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
    expect(result).toEqual(expectedMediaSendResult("C1", "reply", 2));
  });

  it.each([
    {
      route: "push",
      ids: ["613452345678901234", "613452345678901235"],
      provider: pushMessageMock,
      send: () =>
        sendModule.pushMessagesLine(
          "line:user:U123",
          [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
          { cfg: LINE_TEST_CFG },
        ),
    },
    {
      route: "reply",
      ids: ["713452345678901234", "713452345678901235"],
      provider: replyMessageMock,
      send: () =>
        sendModule.sendMessageLine("line:group:C1", "Hello", {
          cfg: LINE_TEST_CFG,
          replyToken: "reply-token",
          mediaUrl: "https://example.com/media.jpg",
        }),
    },
  ])(
    "preserves every provider message id returned by a LINE $route",
    async ({ ids, provider, send }) => {
      provider.mockResolvedValueOnce({ sentMessages: ids.map((id) => ({ id })) });
      const result = await send();
      expect(result.messageId).toBe(ids[0]);
      expect(result.receipt.platformMessageIds).toEqual(ids);
    },
  );

  it.each([
    {
      label: "push",
      send: () => sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }),
      provider: pushMessageMock,
    },
    {
      label: "reply",
      send: () =>
        sendModule.sendMessageLine("U123", "Hello", {
          cfg: LINE_TEST_CFG,
          replyToken: "reply-token",
        }),
      provider: replyMessageMock,
    },
  ])("preserves a finalized $label when activity recording fails", async ({ send, provider }) => {
    provider.mockResolvedValueOnce({ sentMessages: [{ id: "line-provider-final" }] });
    recordChannelActivityMock.mockImplementationOnce(() => {
      throw new Error("activity store unavailable");
    });

    let caught: unknown;
    try {
      await send();
    } catch (error) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial LINE delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["line-provider-final"],
      receipt: {
        primaryPlatformMessageId: "line-provider-final",
        platformMessageIds: ["line-provider-final"],
        threadId: "U123",
        parts: [
          {
            platformMessageId: "line-provider-final",
            kind: "text",
            raw: { chatId: "U123", meta: { messageCount: 1 } },
          },
        ],
      },
      visibleReplySent: true,
    });
  });

  it.each([
    {
      label: "push",
      send: () => sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }),
      provider: pushMessageMock,
    },
    {
      label: "reply",
      send: () =>
        sendModule.sendMessageLine("U123", "Hello", {
          cfg: LINE_TEST_CFG,
          replyToken: "reply-token",
        }),
      provider: replyMessageMock,
    },
  ])(
    "preserves accepted delivery when a $label response omits its provider message ids",
    async ({ send, provider }) => {
      provider.mockResolvedValueOnce({ sentMessages: [] });

      let caught: unknown;
      try {
        await send();
      } catch (error) {
        caught = error;
      }

      expect(isChannelPartialDeliveryError(caught)).toBe(true);
      if (!isChannelPartialDeliveryError(caught)) {
        throw new Error("expected an accepted LINE delivery without an identity");
      }
      expect(caught.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
      expect(recordChannelActivityMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { operation: "push", body: "{" },
    { operation: "push", body: "" },
    { operation: "reply", body: "{" },
    { operation: "reply", body: "" },
  ])("does not retry an accepted $operation response with an unreadable receipt", async (input) => {
    lineFetchMock.mockResolvedValueOnce(
      new Response(input.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const send =
      input.operation === "push"
        ? () => sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG })
        : () =>
            sendModule.sendMessageLine("U123", "Hello", {
              cfg: LINE_TEST_CFG,
              replyToken: "reply-token",
            });

    let caught: unknown;
    try {
      await send();
    } catch (error) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected an accepted LINE delivery without a readable identity");
    }
    expect(caught.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
    expect(lineFetchMock).toHaveBeenCalledOnce();
    expect(recordChannelActivityMock).not.toHaveBeenCalled();
  });

  it("keeps rejected LINE sends distinguishable from accepted delivery", async () => {
    lineFetchMock.mockResolvedValueOnce(
      new Response("invalid payload", { status: 400, statusText: "Bad Request" }),
    );

    let caught: unknown;
    try {
      await sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HTTPFetchError);
    expect(isChannelPartialDeliveryError(caught)).toBe(false);
    expect(caught).toMatchObject({
      status: 400,
      statusText: "Bad Request",
      body: "invalid payload",
    });
  });

  it("does not misclassify network SyntaxErrors as provider acceptance", async () => {
    const failure = new SyntaxError("upstream network decoder failed");
    lineFetchMock.mockRejectedValueOnce(failure);

    await expect(sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG })).rejects.toBe(
      failure,
    );
    expect(isChannelPartialDeliveryError(failure)).toBe(false);
  });

  it.each([
    {
      label: "push",
      send: () =>
        sendModule.pushMessagesLine("U123", [{ type: "text", text: "Hello" }], {
          cfg: LINE_TEST_CFG,
        }),
      provider: pushMessageMock,
    },
    {
      label: "reply",
      send: () =>
        sendModule.sendMessageLine("U123", "Hello", {
          cfg: LINE_TEST_CFG,
          replyToken: "reply-token",
        }),
      provider: replyMessageMock,
    },
  ])(
    "retains valid identities from a partially invalid accepted $label response",
    async ({ send, provider }) => {
      provider.mockResolvedValueOnce({
        sentMessages: [{ id: "line-provider-delivered" }, { id: "   " }],
      });

      let caught: unknown;
      try {
        await send();
      } catch (error) {
        caught = error;
      }

      expect(isChannelPartialDeliveryError(caught)).toBe(true);
      if (!isChannelPartialDeliveryError(caught)) {
        throw new Error("expected a partially identifiable accepted LINE delivery");
      }
      expect(caught.deliveryResult).toEqual({
        messageIds: ["line-provider-delivered"],
        visibleReplySent: true,
      });
      expect(recordChannelActivityMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "object receipt container", sentMessages: {} },
    { name: "null receipt entry", sentMessages: [null] },
    { name: "missing entry identifier", sentMessages: [{}] },
  ])("preserves accepted delivery for a malformed $name", async ({ sentMessages }) => {
    pushMessageMock.mockResolvedValueOnce({ sentMessages });

    let caught: unknown;
    try {
      await sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG });
    } catch (error) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected an accepted LINE delivery with a malformed receipt");
    }
    expect(caught.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
    expect(pushMessageMock).toHaveBeenCalledOnce();
    expect(recordChannelActivityMock).not.toHaveBeenCalled();
  });

  it("preserves literal internal-looking text in low-level sends", async () => {
    const text = "⚠️ 🛠️ `search repos (agent)` failed";

    await sendModule.sendMessageLine("line:user:U123", text, { cfg: LINE_TEST_CFG });

    expect(pushMessageMock).toHaveBeenCalledWith({
      to: "U123",
      messages: [{ type: "text", text }],
    });
  });

  it.each([
    { target: "line:user:U100", chatId: "U100", trackingId: "track-1", expected: "track-1" },
    { target: "line:group:C100", chatId: "C100", trackingId: "track-group", expected: undefined },
  ])(
    "normalizes video tracking by recipient $target",
    async ({ target, chatId, trackingId, expected }) => {
      await sendModule.sendMessageLine(target, "Video", {
        cfg: LINE_TEST_CFG,
        mediaUrl: "https://example.com/video.mp4",
        mediaKind: "video",
        previewImageUrl: "https://example.com/preview.jpg",
        trackingId,
      });

      expect(pushMessageMock).toHaveBeenCalledWith({
        to: chatId,
        messages: [
          {
            type: "video",
            originalContentUrl: "https://example.com/video.mp4",
            previewImageUrl: "https://example.com/preview.jpg",
            ...(expected ? { trackingId: expected } : {}),
          },
          {
            type: "text",
            text: "Video",
          },
        ],
      });
    },
  );

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

  it("normalizes quick replies across push and reply provider boundaries", async () => {
    const options = { cfg: LINE_TEST_CFG };
    await sendModule.pushTextMessageWithQuickReplies(
      "U-quick",
      "Pick one",
      [
        ...Array.from({ length: 13 }, () => " \t "),
        ...Array.from({ length: 14 }, (_, index) => `  Choice ${index + 1}  `),
      ],
      options,
    );

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    const [{ messages }] = pushMessageMock.mock.calls[0] as [
      { messages: Array<{ quickReply?: { items: unknown[] } }> },
    ];
    const items = messages[0]?.quickReply?.items;
    expect(items).toHaveLength(13);
    expect(items?.[0]).toMatchObject({ action: { label: "Choice 1", text: "Choice 1" } });

    const validActions = Array.from({ length: 13 }, (_, index) => ({
      type: "message" as const,
      label: `Option ${index + 1}`,
      text: `Option ${index + 1}`,
    }));
    const legacy = { type: "postback" as const, label: "Legacy", data: "old", text: "Old" };
    const modern = { ...legacy, label: "Modern", data: "new", displayText: "New" };
    const repaired = {
      imageUrl: "https://example.com/icon.png",
      action: { type: "message" as const, label: "Repaired", text: "Repaired" },
    };
    const emptyDataActions = [
      { type: "postback" as const, label: "Empty callback", data: "" },
      { type: "datetimepicker" as const, label: "Empty date", data: "", mode: "date" as const },
    ];
    const rawItems = [
      { type: "action" as const },
      ...[
        { type: "message" as const, label: " \t ", text: "blank" },
        ...(["message", "uri", "postback", "datetimepicker"] as const).map((type) => ({
          type,
          label: `Missing ${type}`,
        })),
      ].map((action) => ({ type: "action" as const, action })),
      repaired,
      { ...repaired, type: "unsupported" },
      ...[modern, legacy, ...emptyDataActions, ...validActions].map((action) => ({
        type: "action" as const,
        action,
      })),
    ];
    const expectedItems = [
      { ...repaired, type: "action" },
      { ...repaired, type: "action" },
      ...[
        { type: "postback", label: "Modern", data: "new", displayText: "New" },
        { type: "postback", label: "Legacy", data: "old", displayText: "Old" },
        ...emptyDataActions,
        ...validActions.slice(0, 7),
      ].map((action) => ({ type: "action", action })),
    ];
    for (const route of ["quick-reply push", "raw push", "reply"] as const) {
      for (const raw of route === "quick-reply push" ? [false] : [false, true]) {
        const provider = route === "reply" ? replyMessageMock : pushMessageMock;
        provider.mockClear();
        const message = {
          type: "text" as const,
          text: "Pick one",
          quickReply: { items: raw ? rawItems : [] },
        };
        if (route === "quick-reply push") {
          await sendModule.pushTextMessageWithQuickReplies("U-quick", message.text, [""], options);
        } else if (route === "raw push") {
          await sendModule.pushMessagesLine("U-quick", [message], options);
        } else {
          await sendModule.replyMessageLine("reply-token", [message], options);
        }

        expect(provider).toHaveBeenCalledExactlyOnceWith({
          ...(route === "reply" ? { replyToken: "reply-token" } : { to: "U-quick" }),
          messages: [
            {
              type: "text",
              text: "Pick one",
              ...(raw
                ? {
                    quickReply: {
                      items: expectedItems,
                    },
                  }
                : {}),
            },
          ],
        });
      }
    }
  });
});
