import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuSendTargetMock = vi.hoisted(() => vi.fn());
const resolveMarkdownTableModeMock = vi.hoisted(() => vi.fn(() => "preserve"));
const convertMarkdownTablesMock = vi.hoisted(() => vi.fn((text: string) => text));

vi.mock("./send-target.js", () => ({
  resolveFeishuSendTarget: resolveFeishuSendTargetMock,
}));

vi.mock("./runtime.js", () => ({
  setFeishuRuntime: vi.fn(),
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: resolveMarkdownTableModeMock,
        convertMarkdownTables: convertMarkdownTablesMock,
      },
    },
  }),
}));

let sendCardFeishu: typeof import("./send.js").sendCardFeishu;
let sendMessageFeishu: typeof import("./send.js").sendMessageFeishu;

describe("Feishu reply fallback for withdrawn/deleted targets", () => {
  const replyMock = vi.fn();
  const createMock = vi.fn();

  async function expectFallbackResult(
    send: () => Promise<{ messageId?: string }>,
    expectedMessageId: string,
  ) {
    const result = await send();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe(expectedMessageId);
  }

  beforeAll(async () => {
    ({ sendCardFeishu, sendMessageFeishu } = await import("./send.js"));
  });

  afterAll(() => {
    vi.doUnmock("./send-target.js");
    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: {
          message: {
            reply: replyMock,
            create: createMock,
          },
        },
      },
      receiveId: "ou_target",
      receiveIdType: "open_id",
    });
  });

  it("preserves Feishu diagnostics when direct sends reject before response checks", async () => {
    const apiError = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: {
          code: 9499,
          msg: "Bad Request",
          error: {
            log_id: "202604291247104BEF4C42D2420A9AD569",
            troubleshooter:
              "https://open.feishu.cn/search?log_id=202604291247104BEF4C42D2420A9AD569",
          },
        },
      },
    });
    createMock.mockRejectedValue(apiError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        text: "hello",
      }),
    ).rejects.toThrow(
      /Feishu send failed: .*"http_status":400.*"feishu_code":9499.*"feishu_msg":"Bad Request".*"feishu_log_id":"202604291247104BEF4C42D2420A9AD569".*"feishu_troubleshooter":"https:\/\/open\.feishu\.cn\/search\?log_id=202604291247104BEF4C42D2420A9AD569"/,
    );
  });

  it("falls back to create for withdrawn post replies", async () => {
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_new" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          text: "hello",
          replyToMessageId: "om_parent",
        }),
      "om_new",
    );
  });

  it("falls back to create for withdrawn card replies", async () => {
    replyMock.mockResolvedValue({
      code: 231003,
      msg: "The message is not found",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_card_new" },
    });

    await expectFallbackResult(
      () =>
        sendCardFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          card: { schema: "2.0" },
          replyToMessageId: "om_parent",
        }),
      "om_card_new",
    );
  });

  it("still throws for non-withdrawn reply failures", async () => {
    replyMock.mockResolvedValue({
      code: 999999,
      msg: "unknown failure",
    });

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        text: "hello",
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow("Feishu reply failed");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("falls back to create when reply throws a withdrawn SDK error", async () => {
    const sdkError = Object.assign(new Error("request failed"), { code: 230011 });
    replyMock.mockRejectedValue(sdkError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_thrown_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          text: "hello",
          replyToMessageId: "om_parent",
        }),
      "om_thrown_fallback",
    );
  });

  it("falls back to create when card reply throws a not-found AxiosError", async () => {
    const axiosError = Object.assign(new Error("Request failed"), {
      response: { status: 200, data: { code: 231003, msg: "The message is not found" } },
    });
    replyMock.mockRejectedValue(axiosError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_axios_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendCardFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          card: { schema: "2.0" },
          replyToMessageId: "om_parent",
        }),
      "om_axios_fallback",
    );
  });

  it("re-throws non-withdrawn thrown errors for text messages", async () => {
    const sdkError = Object.assign(new Error("rate limited"), { code: 99991400 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        text: "hello",
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow("rate limited");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("falls back to a top-level group send when normal quoted replies target withdrawn messages", async () => {
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: {
          message: {
            reply: replyMock,
            create: createMock,
          },
        },
      },
      receiveId: "oc_group_1",
      receiveIdType: "chat_id",
    });
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_group_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "chat:oc_group_1",
          text: "hello",
          replyToMessageId: "om_parent",
          replyInThread: true,
          allowTopLevelReplyFallback: true,
        }),
      "om_group_fallback",
    );

    expect(replyMock).toHaveBeenCalledWith({
      path: { message_id: "om_parent" },
      data: {
        content: '{"zh_cn":{"content":[[{"tag":"md","text":"hello"}]]}}',
        msg_type: "post",
        reply_in_thread: true,
      },
    });
    expect(createMock).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        content: '{"zh_cn":{"content":[[{"tag":"md","text":"hello"}]]}}',
        receive_id: "oc_group_1",
        msg_type: "post",
      },
    });
  });

  it("falls back to create when normal quoted replies throw withdrawn errors", async () => {
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: {
          message: {
            reply: replyMock,
            create: createMock,
          },
        },
      },
      receiveId: "oc_group_1",
      receiveIdType: "chat_id",
    });
    const sdkError = Object.assign(new Error("request failed"), { code: 230011 });
    replyMock.mockRejectedValue(sdkError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_thrown_thread_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "chat:oc_group_1",
          text: "hello",
          replyToMessageId: "om_parent",
          replyInThread: true,
          allowTopLevelReplyFallback: true,
        }),
      "om_thrown_thread_fallback",
    );
  });

  it("fails native thread replies instead of falling back to a top-level send", async () => {
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "chat:oc_group_1",
        text: "hello",
        replyToMessageId: "om_parent",
        replyInThread: true,
      }),
    ).rejects.toThrow(
      "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
    );

    expect(createMock).not.toHaveBeenCalled();
  });

  it("fails thrown withdrawn native thread replies instead of falling back to create", async () => {
    const sdkError = Object.assign(new Error("request failed"), { code: 230011 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "chat:oc_group_1",
        text: "hello",
        replyToMessageId: "om_parent",
        replyInThread: true,
      }),
    ).rejects.toThrow(
      "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
    );

    expect(createMock).not.toHaveBeenCalled();
  });

  it("preserves non-withdrawn thread reply failures", async () => {
    replyMock.mockResolvedValue({
      code: 999999,
      msg: "unknown failure",
    });

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "chat:oc_group_1",
        text: "hello",
        replyToMessageId: "om_parent",
        replyInThread: true,
        allowTopLevelReplyFallback: true,
      }),
    ).rejects.toThrow("Feishu reply failed");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("preserves thrown non-withdrawn thread reply failures", async () => {
    const sdkError = Object.assign(new Error("rate limited"), { code: 99991400 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "chat:oc_group_1",
        text: "hello",
        replyToMessageId: "om_parent",
        replyInThread: true,
        allowTopLevelReplyFallback: true,
      }),
    ).rejects.toThrow("rate limited");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("still falls back for non-thread replies to withdrawn targets", async () => {
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_non_thread_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          text: "hello",
          replyToMessageId: "om_parent",
          replyInThread: false,
        }),
      "om_non_thread_fallback",
    );
  });

  it("re-throws non-withdrawn thrown errors for card messages", async () => {
    const sdkError = Object.assign(new Error("permission denied"), { code: 99991401 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendCardFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        card: { schema: "2.0" },
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow("permission denied");

    expect(createMock).not.toHaveBeenCalled();
  });
});
