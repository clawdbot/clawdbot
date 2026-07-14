// Feishu tests cover send plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const {
  mockConvertMarkdownTables,
  mockClientGet,
  mockClientList,
  mockClientPatch,
  mockCreateFeishuClient,
  mockResolveMarkdownTableMode,
  mockResolveFeishuAccount,
  mockRuntimeConvertMarkdownTables,
  mockRuntimeResolveMarkdownTableMode,
} = vi.hoisted(() => ({
  mockConvertMarkdownTables: vi.fn((text: string) => text),
  mockClientGet: vi.fn(),
  mockClientList: vi.fn(),
  mockClientPatch: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockResolveMarkdownTableMode: vi.fn(() => "preserve"),
  mockResolveFeishuAccount: vi.fn(),
  mockRuntimeConvertMarkdownTables: vi.fn((text: string) => text),
  mockRuntimeResolveMarkdownTableMode: vi.fn(() => "preserve"),
}));

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: mockResolveMarkdownTableMode,
}));

vi.mock("openclaw/plugin-sdk/text-chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-chunking")>();
  return {
    ...actual,
    convertMarkdownTables: mockConvertMarkdownTables,
  };
});

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
  resolveFeishuRuntimeAccount: mockResolveFeishuAccount,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: mockRuntimeResolveMarkdownTableMode,
        convertMarkdownTables: mockRuntimeConvertMarkdownTables,
      },
    },
  }),
}));

let editMessageFeishu: typeof import("./send.js").editMessageFeishu;
let getMessageFeishu: typeof import("./send.js").getMessageFeishu;
let listFeishuThreadMessages: typeof import("./send.js").listFeishuThreadMessages;
let resolveFeishuCardTemplate: typeof import("./send.js").resolveFeishuCardTemplate;
let sendMarkdownCardFeishu: typeof import("./send.js").sendMarkdownCardFeishu;
let sendMessageFeishu: typeof import("./send.js").sendMessageFeishu;
let sendStructuredCardFeishu: typeof import("./send.js").sendStructuredCardFeishu;

describe("getMessageFeishu", () => {
  beforeAll(async () => {
    ({
      editMessageFeishu,
      getMessageFeishu,
      listFeishuThreadMessages,
      resolveFeishuCardTemplate,
      sendMarkdownCardFeishu,
      sendMessageFeishu,
      sendStructuredCardFeishu,
    } = await import("./send.js"));
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/markdown-table-runtime");
    vi.doUnmock("openclaw/plugin-sdk/text-chunking");
    vi.doUnmock("./client.js");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveMarkdownTableMode.mockReturnValue("preserve");
    mockConvertMarkdownTables.mockImplementation((text: string) => text);
    mockRuntimeResolveMarkdownTableMode.mockReturnValue("preserve");
    mockRuntimeConvertMarkdownTables.mockImplementation((text: string) => text);
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create: vi.fn(),
          get: mockClientGet,
          list: mockClientList,
          patch: mockClientPatch,
        },
      },
    });
  });

  it("sends text without requiring Feishu runtime text helpers", async () => {
    mockRuntimeResolveMarkdownTableMode.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockRuntimeConvertMarkdownTables.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockClientPatch.mockResolvedValueOnce({ code: 0 });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om_send" } }),
          reply: vi.fn(),
          get: mockClientGet,
          list: mockClientList,
          patch: mockClientPatch,
        },
      },
    });

    const result = await sendMessageFeishu({
      cfg: {} as ClawdbotConfig,
      to: "oc_send",
      text: "hello",
    });

    expect(mockResolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg: {},
      channel: "feishu",
    });
    expect(mockConvertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
    expect(typeof result.receipt.sentAt).toBe("number");
    expect(result).toEqual({
      messageId: "om_send",
      chatId: "oc_send",
      receipt: {
        primaryPlatformMessageId: "om_send",
        platformMessageIds: ["om_send"],
        parts: [
          {
            platformMessageId: "om_send",
            kind: "text",
            index: 0,
            raw: {
              channel: "feishu",
              messageId: "om_send",
              chatId: "oc_send",
              conversationId: "oc_send",
            },
            threadId: "oc_send",
          },
        ],
        threadId: "oc_send",
        sentAt: result.receipt.sentAt,
        raw: [
          {
            channel: "feishu",
            messageId: "om_send",
            chatId: "oc_send",
            conversationId: "oc_send",
          },
        ],
      },
    });
  });

  it("sends automatic mentions as native post elements without rewriting body text", async () => {
    const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om_mentions" } });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create,
          reply: vi.fn(),
          get: mockClientGet,
          list: mockClientList,
          patch: mockClientPatch,
        },
      },
    });

    const result = await sendMessageFeishu({
      cfg: {} as ClawdbotConfig,
      to: "oc_send",
      text: 'body <at user_id="ou_body">Body User</at>',
      mentions: [{ openId: "ou_target", name: "Target User", key: "@_user_1" }],
    });

    expect(mockConvertMarkdownTables).toHaveBeenCalledWith(
      'body <at user_id="ou_body">Body User</at>',
      "preserve",
    );
    expect(create).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_send",
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: "at", user_id: "ou_target", user_name: "Target User" },
                { tag: "md", text: 'body <at user_id="ou_body">Body User</at>' },
              ],
            ],
          },
        }),
      },
    });
    expect(typeof result.receipt.sentAt).toBe("number");
    expect(result).toEqual({
      messageId: "om_mentions",
      chatId: "oc_send",
      receipt: {
        primaryPlatformMessageId: "om_mentions",
        platformMessageIds: ["om_mentions"],
        parts: [
          {
            platformMessageId: "om_mentions",
            kind: "text",
            index: 0,
            raw: {
              channel: "feishu",
              messageId: "om_mentions",
              chatId: "oc_send",
              conversationId: "oc_send",
            },
            threadId: "oc_send",
          },
        ],
        threadId: "oc_send",
        sentAt: result.receipt.sentAt,
        raw: [
          {
            channel: "feishu",
            messageId: "om_mentions",
            chatId: "oc_send",
            conversationId: "oc_send",
          },
        ],
      },
    });
  });

  it.each([
    {
      name: "structured",
      send: () =>
        sendStructuredCardFeishu({
          cfg: {} as ClawdbotConfig,
          to: "oc_card",
          text: "hello",
          header: { title: "Agent", template: "space lobster" },
        }),
      expectedHeader: {
        title: { tag: "plain_text", content: "Agent" },
        template: "blue",
      },
    },
    {
      name: "markdown",
      send: () =>
        sendMarkdownCardFeishu({ cfg: {} as ClawdbotConfig, to: "oc_card", text: "hello" }),
      expectedHeader: undefined,
    },
  ])("sends $name cards with schema-2.0 width config", async ({ send, expectedHeader }) => {
    const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om_card" } });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create,
          reply: vi.fn(),
          get: mockClientGet,
          list: mockClientList,
          patch: mockClientPatch,
        },
      },
    });

    await send();

    const request = create.mock.calls[0]?.[0] as { data?: { content?: string } } | undefined;
    expect(JSON.parse(request?.data?.content ?? "null")).toEqual({
      schema: "2.0",
      config: { width_mode: "fill" },
      body: { elements: [{ tag: "markdown", content: "hello" }] },
      ...(expectedHeader ? { header: expectedHeader } : {}),
    });
  });

  it("extracts text content from interactive card elements", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_1",
            chat_id: "oc_1",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [
                  { tag: "markdown", content: "hello markdown" },
                  { tag: "div", text: { content: "hello div" } },
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
    });

    expect(mockClientGet).toHaveBeenCalledWith({
      params: { card_msg_content_type: "user_card_content" },
      path: { message_id: "om_1" },
    });
    expect(result).toEqual({
      messageId: "om_1",
      chatId: "oc_1",
      chatType: undefined,
      senderId: undefined,
      senderOpenId: undefined,
      senderType: undefined,
      content: "hello markdown\nhello div",
      contentType: "interactive",
      createTime: undefined,
      threadId: undefined,
    });
  });

  it("falls through empty interactive card element arrays and locale variants", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_i18n_card",
            chat_id: "oc_i18n_card",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [],
                body: { elements: [] },
                i18n_elements: {
                  zh_cn: [],
                  en_us: [
                    {
                      tag: "markdown",
                      content: "hello ${count} {{label}} {{metadata}}",
                    },
                  ],
                },
                template_variable: {
                  count: 2,
                  label: "tasks",
                  metadata: { ignored: true },
                },
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_i18n_card",
    });

    expect(result).toEqual({
      messageId: "om_i18n_card",
      chatId: "oc_i18n_card",
      chatType: undefined,
      senderId: undefined,
      senderOpenId: undefined,
      senderType: undefined,
      content: "hello 2 tasks {{metadata}}",
      contentType: "interactive",
      createTime: undefined,
      threadId: undefined,
    });
  });

  it("falls back to post-format content when interactive card elements are empty", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_post_card",
            chat_id: "oc_post_card",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [],
                post: {
                  zh_cn: {
                    title: "Card summary",
                    content: [[{ tag: "md", text: "**fallback** body" }]],
                  },
                },
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_post_card",
    });

    expect(result).toEqual({
      messageId: "om_post_card",
      chatId: "oc_post_card",
      chatType: undefined,
      senderId: undefined,
      senderOpenId: undefined,
      senderType: undefined,
      content: "Card summary\n\n**fallback** body",
      contentType: "interactive",
      createTime: undefined,
      threadId: undefined,
    });
  });

  it("extracts text content from post messages", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_post",
            chat_id: "oc_post",
            msg_type: "post",
            body: {
              content: JSON.stringify({
                zh_cn: {
                  title: "Summary",
                  content: [[{ tag: "text", text: "post body" }]],
                },
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_post",
    });

    expect(result).toEqual({
      messageId: "om_post",
      chatId: "oc_post",
      chatType: undefined,
      senderId: undefined,
      senderOpenId: undefined,
      senderType: undefined,
      content: "Summary\n\npost body",
      contentType: "post",
      createTime: undefined,
      threadId: undefined,
    });
  });

  it("returns text placeholder instead of raw JSON for unsupported message types", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_file",
            chat_id: "oc_file",
            msg_type: "file",
            body: {
              content: JSON.stringify({ file_key: "file_v3_123" }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_file",
    });

    expect(result).toEqual({
      messageId: "om_file",
      chatId: "oc_file",
      chatType: undefined,
      senderId: undefined,
      senderOpenId: undefined,
      senderType: undefined,
      content: "[file message]",
      contentType: "file",
      createTime: undefined,
      threadId: undefined,
    });
  });

  it("supports single-object response shape from Feishu API", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        message_id: "om_single",
        chat_id: "oc_single",
        msg_type: "text",
        body: {
          content: JSON.stringify({ text: "single payload" }),
        },
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_single",
    });

    expect(result).toEqual({
      messageId: "om_single",
      chatId: "oc_single",
      chatType: undefined,
      senderId: undefined,
      senderOpenId: undefined,
      senderType: undefined,
      content: "single payload",
      contentType: "text",
      createTime: undefined,
      threadId: undefined,
    });
  });

  it("reuses the same content parsing for thread history messages", async () => {
    mockClientList.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_root",
            msg_type: "text",
            body: {
              content: JSON.stringify({ text: "root starter" }),
            },
          },
          {
            message_id: "om_card",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                body: {
                  elements: [{ tag: "markdown", content: "hello from card 2.0" }],
                },
              }),
            },
            sender: {
              id: "app_1",
              sender_type: "app",
            },
            create_time: "1710000000000",
          },
          {
            message_id: "om_file",
            msg_type: "file",
            body: {
              content: JSON.stringify({ file_key: "file_v3_123" }),
            },
            sender: {
              id: "ou_1",
              sender_type: "user",
            },
            create_time: "1710000001000",
          },
        ],
      },
    });

    const result = await listFeishuThreadMessages({
      cfg: {} as ClawdbotConfig,
      threadId: "omt_1",
      rootMessageId: "om_root",
    });

    expect(mockClientList).toHaveBeenCalledWith({
      params: {
        container_id_type: "thread",
        container_id: "omt_1",
        sort_type: "ByCreateTimeDesc",
        page_size: 21,
        card_msg_content_type: "user_card_content",
      },
    });
    expect(result).toEqual([
      {
        messageId: "om_file",
        senderId: "ou_1",
        senderType: "user",
        contentType: "file",
        content: "[file message]",
        createTime: 1710000001000,
      },
      {
        messageId: "om_card",
        senderId: "app_1",
        senderType: "app",
        contentType: "interactive",
        content: "hello from card 2.0",
        createTime: 1710000000000,
      },
    ]);
  });

  it("does not partially parse malformed thread history create_time values", async () => {
    mockClientList.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_text",
            msg_type: "text",
            body: {
              content: JSON.stringify({ text: "partial time" }),
            },
            sender: {
              id: "ou_1",
              sender_type: "user",
            },
            create_time: "1710000000000ms",
          },
        ],
      },
    });

    const result = await listFeishuThreadMessages({
      cfg: {} as ClawdbotConfig,
      threadId: "omt_1",
      rootMessageId: "om_root",
    });

    expect(result).toEqual([
      {
        messageId: "om_text",
        senderId: "ou_1",
        senderType: "user",
        contentType: "text",
        content: "partial time",
        createTime: undefined,
      },
    ]);
  });
});

describe("editMessageFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          patch: mockClientPatch,
        },
      },
    });
  });

  it("patches post content for text edits", async () => {
    mockRuntimeResolveMarkdownTableMode.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockRuntimeConvertMarkdownTables.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockClientPatch.mockResolvedValueOnce({ code: 0 });

    const result = await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_edit",
      text: "updated body",
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      path: { message_id: "om_edit" },
      data: {
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                {
                  tag: "md",
                  text: "updated body",
                },
              ],
            ],
          },
        }),
      },
    });
    expect(result).toEqual({ messageId: "om_edit", contentType: "post" });
  });

  it("patches interactive content for card edits", async () => {
    mockClientPatch.mockResolvedValueOnce({ code: 0 });

    const result = await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_card",
      card: { schema: "2.0" },
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      path: { message_id: "om_card" },
      data: {
        content: JSON.stringify({ schema: "2.0" }),
      },
    });
    expect(result).toEqual({ messageId: "om_card", contentType: "interactive" });
  });
});

describe("resolveFeishuCardTemplate", () => {
  it("accepts supported Feishu templates", () => {
    expect(resolveFeishuCardTemplate(" purple ")).toBe("purple");
  });

  it("drops unsupported free-form identity themes", () => {
    expect(resolveFeishuCardTemplate("space lobster")).toBeUndefined();
  });
});
