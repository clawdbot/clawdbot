import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginRuntime } from "../runtime-api.js";

const createFeishuToolClientMock = vi.hoisted(() => vi.fn());
const resolveAnyEnabledFeishuToolsConfigMock = vi.hoisted(() => vi.fn());
const cleanupAmbientCommentTypingReactionMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("./tool-account.js", () => ({
  createFeishuToolClient: createFeishuToolClientMock,
  resolveAnyEnabledFeishuToolsConfig: resolveAnyEnabledFeishuToolsConfigMock,
}));

vi.mock("./comment-reaction.js", () => ({
  cleanupAmbientCommentTypingReaction: cleanupAmbientCommentTypingReactionMock,
}));

let registerFeishuDriveTools: typeof import("./drive.js").registerFeishuDriveTools;

function createFeishuToolRuntime(): PluginRuntime {
  return {} as PluginRuntime;
}

function createDriveToolApi(params: {
  config: OpenClawPluginApi["config"];
  registerTool: OpenClawPluginApi["registerTool"];
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "feishu-test",
    name: "Feishu Test",
    source: "local",
    config: params.config,
    runtime: createFeishuToolRuntime(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool: params.registerTool,
  });
}

describe("registerFeishuDriveTools", () => {
  const requestMock = vi.fn();

  beforeAll(async () => {
    ({ registerFeishuDriveTools } = await import("./drive.js"));
  });

  afterAll(() => {
    vi.doUnmock("./tool-account.js");
    vi.doUnmock("./comment-reaction.js");
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveAnyEnabledFeishuToolsConfigMock.mockReturnValue({
      doc: false,
      chat: false,
      wiki: false,
      drive: true,
      perm: false,
      scopes: false,
    });
    createFeishuToolClientMock.mockReturnValue({
      request: requestMock,
    });
    cleanupAmbientCommentTypingReactionMock.mockResolvedValue(false);
  });

  it("registers feishu_drive and handles comment actions", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });
    expect(tool?.name).toBe("feishu_drive");

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "0",
        items: [
          {
            comment_id: "c1",
            quote: "quoted text",
            reply_list: {
              replies: [
                {
                  reply_id: "r1",
                  user_id: "ou_author",
                  content: {
                    elements: [
                      {
                        type: "text_run",
                        text_run: { text: "root comment" },
                      },
                    ],
                  },
                },
                {
                  reply_id: "r2",
                  user_id: "ou_reply",
                  content: {
                    elements: [
                      {
                        type: "text_run",
                        text_run: { text: "reply text" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const listResult = await tool.execute("call-1", {
      action: "list_comments",
      file_token: "doc_1",
      file_type: "docx",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(listResult.details).toEqual(
      expect.objectContaining({
        comments: [
          expect.objectContaining({
            comment_id: "c1",
            text: "root comment",
            quote: "quoted text",
            replies: [expect.objectContaining({ reply_id: "r2", text: "reply text" })],
          }),
        ],
      }),
    );

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "0",
        items: [
          {
            reply_id: "r3",
            user_id: "ou_reply_2",
            content: {
              elements: [
                {
                  type: "text_run",
                  text_run: { content: "reply from api" },
                },
              ],
            },
          },
        ],
      },
    });
    const repliesResult = await tool.execute("call-2", {
      action: "list_comment_replies",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(repliesResult.details).toEqual(
      expect.objectContaining({
        replies: [expect.objectContaining({ reply_id: "r3", text: "reply from api" })],
      }),
    );

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { comment_id: "c2" },
    });
    const addCommentResult = await tool.execute("call-3", {
      action: "add_comment",
      file_token: "doc_1",
      file_type: "docx",
      block_id: "blk_1",
      content: "please update this section",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
        data: {
          file_type: "docx",
          reply_elements: [{ type: "text", text: "please update this section" }],
          anchor: { block_id: "blk_1" },
        },
      }),
    );
    expect(addCommentResult.details).toEqual(
      expect.objectContaining({ success: true, comment_id: "c2" }),
    );

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { reply_id: "r4" },
      });
    const replyCommentResult = await tool.execute("call-4", {
      action: "reply_comment",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
      content: "handled",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
        data: {
          comment_ids: ["c1"],
        },
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
        params: { file_type: "docx" },
        data: {
          content: {
            elements: [
              {
                type: "text_run",
                text_run: {
                  text: "handled",
                },
              },
            ],
          },
        },
      }),
    );
    expect(replyCommentResult.details).toEqual(
      expect.objectContaining({ success: true, reply_id: "r4" }),
    );
  });

  it("defaults add_comment file_type to docx when omitted", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { comment_id: "c-default-docx" },
    });

    const result = await tool.execute("call-default-docx", {
      action: "add_comment",
      file_token: "doc_1",
      content: "defaulted file type",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
        data: {
          file_type: "docx",
          reply_elements: [{ type: "text", text: "defaulted file type" }],
        },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("add_comment missing file_type; defaulting to docx"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({ success: true, comment_id: "c-default-docx" }),
    );
  });

  it("defaults list_comments file_type to docx when omitted", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { has_more: false, items: [] },
    });

    await tool.execute("call-list-default-docx", {
      action: "list_comments",
      file_token: "doc_1",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("list_comments missing file_type; defaulting to docx"),
    );
  });

  it("defaults list_comment_replies file_type to docx when omitted", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { has_more: false, items: [] },
    });

    await tool.execute("call-replies-default-docx", {
      action: "list_comment_replies",
      file_token: "doc_1",
      comment_id: "c1",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("list_comment_replies missing file_type; defaulting to docx"),
    );
  });

  it("surfaces reply_comment HTTP errors when the single supported body fails", async () => {
    const registerTool = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockRejectedValueOnce({
        message: "Request failed with status code 400",
        code: "ERR_BAD_REQUEST",
        config: {
          method: "post",
          url: "https://open.feishu.cn/open-apis/drive/v1/files/doc_1/comments/c1/replies",
          params: { file_type: "docx" },
        },
        response: {
          status: 400,
          data: {
            code: 99992402,
            msg: "field validation failed",
            log_id: "log_legacy_400",
          },
        },
      });

    const replyCommentResult = await tool.execute("call-throw", {
      action: "reply_comment",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
      content: "inserted successfully",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
        data: {
          comment_ids: ["c1"],
        },
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
        params: { file_type: "docx" },
        data: {
          content: {
            elements: [
              {
                type: "text_run",
                text_run: {
                  text: "inserted successfully",
                },
              },
            ],
          },
        },
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("replyComment threw"));
    expect(replyCommentResult.details).toEqual(
      expect.objectContaining({ error: "Request failed with status code 400" }),
    );
  });

  it("does not wait for ambient typing cleanup before reply_comment sends visible output", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({
      agentAccountId: undefined,
      deliveryContext: {
        channel: "feishu",
        to: "comment:docx:doc_1:c1",
        threadId: "reply_ambient_1",
      },
    });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { reply_id: "r6" },
      });

    let resolveCleanup: ((value: boolean) => void) | undefined;
    cleanupAmbientCommentTypingReactionMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCleanup = resolve;
        }),
    );

    const replyCommentPromise = tool.execute("call-ambient", {
      action: "reply_comment",
      content: "ambient success",
    });
    const status = await Promise.race([
      replyCommentPromise.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(status).toBe("done");
    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
        data: {
          comment_ids: ["c1"],
        },
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
        params: { file_type: "docx" },
        data: {
          content: {
            elements: [
              {
                type: "text_run",
                text_run: {
                  text: "ambient success",
                },
              },
            ],
          },
        },
      }),
    );
    expect(cleanupAmbientCommentTypingReactionMock).toHaveBeenCalledWith({
      client: expect.anything(),
      deliveryContext: {
        channel: "feishu",
        to: "comment:docx:doc_1:c1",
        threadId: "reply_ambient_1",
      },
    });
    const replyCommentResult = await replyCommentPromise;
    expect(replyCommentResult.details).toEqual(
      expect.objectContaining({ success: true, reply_id: "r6" }),
    );

    resolveCleanup?.(false);
  });

  it("does not wait for ambient typing cleanup before add_comment sends visible output", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({
      agentAccountId: undefined,
      deliveryContext: {
        channel: "feishu",
        to: "comment:docx:doc_1:c1",
        threadId: "reply_ambient_1",
      },
    });

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { comment_id: "c_add" },
    });

    let resolveCleanup: ((value: boolean) => void) | undefined;
    cleanupAmbientCommentTypingReactionMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCleanup = resolve;
        }),
    );

    const addCommentPromise = tool.execute("call-add-ambient", {
      action: "add_comment",
      content: "ambient top-level comment",
    });
    const status = await Promise.race([
      addCommentPromise.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(status).toBe("done");
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
        data: {
          file_type: "docx",
          reply_elements: [{ type: "text", text: "ambient top-level comment" }],
        },
      }),
    );
    expect(cleanupAmbientCommentTypingReactionMock).toHaveBeenCalledWith({
      client: expect.anything(),
      deliveryContext: {
        channel: "feishu",
        to: "comment:docx:doc_1:c1",
        threadId: "reply_ambient_1",
      },
    });
    const addCommentResult = await addCommentPromise;
    expect(addCommentResult.details).toEqual(
      expect.objectContaining({ success: true, comment_id: "c_add" }),
    );

    resolveCleanup?.(false);
  });

  it("does not inherit non-doc ambient file types for add_comment", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({
      agentAccountId: undefined,
      deliveryContext: {
        channel: "feishu",
        to: "comment:sheet:sheet_1:c1",
      },
    });

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { comment_id: "c-add-docx" },
    });

    const result = await tool.execute("call-add-ignore-sheet-ambient", {
      action: "add_comment",
      file_token: "doc_1",
      content: "default add comment",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
        data: {
          file_type: "docx",
          reply_elements: [{ type: "text", text: "default add comment" }],
        },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("add_comment missing file_type; defaulting to docx"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({ success: true, comment_id: "c-add-docx" }),
    );
  });

  it("defaults reply_comment file_type to docx when omitted", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { reply_id: "r-default-docx" },
      });

    const result = await tool.execute("call-reply-default-docx", {
      action: "reply_comment",
      file_token: "doc_1",
      comment_id: "c1",
      content: "default reply docx",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
        data: { comment_ids: ["c1"] },
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
        params: { file_type: "docx" },
        data: {
          content: {
            elements: [
              {
                type: "text_run",
                text_run: {
                  text: "default reply docx",
                },
              },
            ],
          },
        },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("reply_comment missing file_type; defaulting to docx"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({ success: true, reply_id: "r-default-docx" }),
    );
  });

  it("routes whole-document reply_comment requests through add_comment compatibility", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: true }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { comment_id: "c2" },
      });

    const result = await tool.execute("call-whole", {
      action: "reply_comment",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
      content: "whole comment follow-up",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
        data: {
          comment_ids: ["c1"],
        },
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
        data: {
          file_type: "docx",
          reply_elements: [{ type: "text", text: "whole comment follow-up" }],
        },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("whole-comment compatibility path"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        success: true,
        comment_id: "c2",
        delivery_mode: "add_comment",
      }),
    );
  });

  it("continues with reply_comment when comment metadata preflight fails", async () => {
    const registerTool = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockRejectedValueOnce(new Error("preflight unavailable")).mockResolvedValueOnce({
      code: 0,
      data: { reply_id: "r-preflight-fallback" },
    });

    const result = await tool.execute("call-preflight-fallback", {
      action: "reply_comment",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
      content: "preflight fallback reply",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
        data: {
          comment_ids: ["c1"],
        },
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
        params: { file_type: "docx" },
        data: {
          content: {
            elements: [
              {
                type: "text_run",
                text_run: {
                  text: "preflight fallback reply",
                },
              },
            ],
          },
        },
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("comment metadata preflight failed"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        success: true,
        reply_id: "r-preflight-fallback",
        delivery_mode: "reply_comment",
      }),
    );
  });

  it("continues with reply_comment when batch_query returns no exact comment match", async () => {
    const registerTool = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "different_comment", is_whole: true }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { reply_id: "r-no-exact-match" },
      });

    const result = await tool.execute("call-preflight-no-exact-match", {
      action: "reply_comment",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
      content: "fallback on exact match miss",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
        data: {
          comment_ids: ["c1"],
        },
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
        params: { file_type: "docx" },
        data: {
          content: {
            elements: [
              {
                type: "text_run",
                text_run: {
                  text: "fallback on exact match miss",
                },
              },
            ],
          },
        },
      }),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("whole-comment compatibility path"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        success: true,
        reply_id: "r-no-exact-match",
        delivery_mode: "reply_comment",
      }),
    );
  });

  it("falls back to add_comment when reply_comment returns compatibility code 1069302 even without is_whole metadata", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockRejectedValueOnce({
        message: "Request failed with status code 400",
        code: "ERR_BAD_REQUEST",
        config: {
          method: "post",
          url: "https://open.feishu.cn/open-apis/drive/v1/files/doc_1/comments/c1/replies",
          params: { file_type: "docx" },
        },
        response: {
          status: 400,
          data: {
            code: 1069302,
            msg: "param error",
            log_id: "log_reply_forbidden",
          },
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { comment_id: "c3" },
      });

    const result = await tool.execute("call-reply-forbidden", {
      action: "reply_comment",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
      content: "compat follow-up",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
        data: {
          file_type: "docx",
          reply_elements: [{ type: "text", text: "compat follow-up" }],
        },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("reply-not-allowed compatibility path"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        success: true,
        comment_id: "c3",
        delivery_mode: "add_comment",
      }),
    );
  });

  it("clamps comment list page sizes to the Feishu API maximum", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockResolvedValueOnce({ code: 0, data: { has_more: false, items: [] } });
    await tool.execute("call-list", {
      action: "list_comments",
      file_token: "doc_1",
      file_type: "docx",
      page_size: 200,
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments?file_type=docx&page_size=100&user_id_type=open_id",
      }),
    );

    requestMock.mockResolvedValueOnce({ code: 0, data: { has_more: false, items: [] } });
    await tool.execute("call-replies", {
      action: "list_comment_replies",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
      page_size: 200,
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies?file_type=docx&page_size=100&user_id_type=open_id",
      }),
    );
  });

  it("rejects block-scoped comments for non-docx files", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });
    const result = await tool.execute("call-5", {
      action: "add_comment",
      file_token: "doc_1",
      file_type: "doc",
      block_id: "blk_1",
      content: "invalid",
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        error: "block_id is only supported for docx comments",
      }),
    );
  });
});
