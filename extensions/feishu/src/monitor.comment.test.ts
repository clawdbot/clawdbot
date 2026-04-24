import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import * as dedup from "./dedup.js";
import { monitorSingleAccount } from "./monitor.account.js";
import {
  resolveDriveCommentEventTurn,
  type FeishuDriveCommentNoticeEvent,
} from "./monitor.comment.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const handleFeishuCommentEventMock = vi.hoisted(() => vi.fn(async () => {}));
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime: ReturnType<typeof createNonExitingRuntimeEnv> | null = null;
const TEST_DOC_TOKEN = "ZsJfdxrBFo0RwuxteOLc1Ekvneb";
const TEST_WIKI_TOKEN = "OtYpd5pKOoMeQzxrzkocv9KIn4H";

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./comment-handler.js", () => ({
  handleFeishuCommentEvent: handleFeishuCommentEventMock,
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

function buildMonitorConfig(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
      },
    },
  } as ClawdbotConfig;
}

function buildMonitorAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createFeishuMonitorRuntime(params?: {
  createInboundDebouncer?: PluginRuntime["channel"]["debounce"]["createInboundDebouncer"];
  resolveInboundDebounceMs?: PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"];
  hasControlCommand?: PluginRuntime["channel"]["text"]["hasControlCommand"];
}): PluginRuntime {
  return {
    channel: {
      debounce: {
        createInboundDebouncer: params?.createInboundDebouncer ?? createInboundDebouncer,
        resolveInboundDebounceMs: params?.resolveInboundDebounceMs ?? resolveInboundDebounceMs,
      },
      text: {
        hasControlCommand: params?.hasControlCommand ?? hasControlCommand,
      },
    },
  } as unknown as PluginRuntime;
}

function makeDriveCommentEvent(
  overrides: Partial<FeishuDriveCommentNoticeEvent> = {},
): FeishuDriveCommentNoticeEvent {
  return {
    comment_id: "7623358762119646411",
    event_id: "10d9d60b990db39f96a4c2fd357fb877",
    is_mentioned: true,
    notice_meta: {
      file_token: TEST_DOC_TOKEN,
      file_type: "docx",
      from_user_id: {
        open_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
      },
      notice_type: "add_comment",
      to_user_id: {
        open_id: "ou_bot",
      },
    },
    reply_id: "7623358762136374451",
    timestamp: "1774951528000",
    type: "drive.notice.comment_add_v1",
    ...overrides,
  };
}

function makeOpenApiClient(params: {
  documentTitle?: string;
  documentUrl?: string;
  isWholeComment?: boolean;
  batchCommentId?: string;
  quoteText?: string;
  rootReplyText?: string;
  targetReplyText?: string;
  includeTargetReplyInBatch?: boolean;
  repliesSequence?: Array<Array<{ reply_id: string; text: string }>>;
}) {
  const remainingReplyBatches = [...(params.repliesSequence ?? [])];
  return {
    request: vi.fn(async (request: { method: "GET" | "POST"; url: string; data: unknown }) => {
      if (request.url === "/open-apis/drive/v1/metas/batch_query") {
        return {
          code: 0,
          data: {
            metas: [
              {
                doc_token: TEST_DOC_TOKEN,
                title: params.documentTitle ?? "Comment event handling request",
                url: params.documentUrl ?? `https://www.larksuite.com/docx/${TEST_DOC_TOKEN}`,
              },
            ],
          },
        };
      }
      if (request.url.includes("/comments/batch_query")) {
        return {
          code: 0,
          data: {
            items: [
              {
                comment_id: params.batchCommentId ?? "7623358762119646411",
                is_whole: params.isWholeComment,
                quote: params.quoteText ?? "im.message.receive_v1 message trigger implementation",
                reply_list: {
                  replies: [
                    {
                      reply_id: "7623358762136374451",
                      content: {
                        elements: [
                          {
                            type: "text_run",
                            text_run: {
                              content:
                                params.rootReplyText ??
                                "Also send it to the agent after receiving the comment event",
                            },
                          },
                        ],
                      },
                    },
                    ...(params.includeTargetReplyInBatch
                      ? [
                          {
                            reply_id: "7623359125036043462",
                            content: {
                              elements: [
                                {
                                  type: "text_run",
                                  text_run: {
                                    content:
                                      params.targetReplyText ?? "Please follow up on this comment",
                                  },
                                },
                              ],
                            },
                          },
                        ]
                      : []),
                  ],
                },
              },
            ],
          },
        };
      }
      if (request.url.includes("/replies")) {
        const replyBatch = remainingReplyBatches.shift();
        const items = replyBatch?.map((reply) => ({
          reply_id: reply.reply_id,
          content: {
            elements: [
              {
                type: "text_run",
                text_run: {
                  content: reply.text,
                },
              },
            ],
          },
        })) ?? [
          {
            reply_id: "7623358762136374451",
            content: {
              elements: [
                {
                  type: "text_run",
                  text_run: {
                    content:
                      params.rootReplyText ??
                      "Also send it to the agent after receiving the comment event",
                  },
                },
              ],
            },
          },
          {
            reply_id: "7623359125036043462",
            content: {
              elements: [
                {
                  type: "text_run",
                  text_run: {
                    content: params.targetReplyText ?? "Please follow up on this comment",
                  },
                },
              ],
            },
          },
        ];
        return {
          code: 0,
          data: {
            has_more: false,
            items,
          },
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    }),
  };
}

async function setupCommentMonitorHandler(): Promise<(data: unknown) => Promise<void>> {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({ register });
  lastRuntime = createNonExitingRuntimeEnv();

  await monitorSingleAccount({
    cfg: buildMonitorConfig(),
    account: buildMonitorAccount(),
    runtime: lastRuntime as RuntimeEnv,
    botOpenIdSource: {
      kind: "prefetched",
      botOpenId: "ou_bot",
    },
  });

  const handler = handlers["drive.notice.comment_add_v1"];
  if (!handler) {
    throw new Error("missing drive.notice.comment_add_v1 handler");
  }
  return handler;
}

describe("resolveDriveCommentEventTurn", () => {
  it("builds a real comment-turn prompt for add_comment notices", async () => {
    const client = makeOpenApiClient({ includeTargetReplyInBatch: true });

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent(),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn).not.toBeNull();
    expect(turn?.senderId).toBe("ou_509d4d7ace4a9addec2312676ffcba9b");
    expect(turn?.messageId).toBe("drive-comment:10d9d60b990db39f96a4c2fd357fb877");
    expect(turn?.fileType).toBe("docx");
    expect(turn?.fileToken).toBe(TEST_DOC_TOKEN);
    expect(turn?.prompt).toContain('The user added a comment in "Comment event handling request".');
    expect(turn?.prompt).toContain(
      'Current user comment text: "Also send it to the agent after receiving the comment event"',
    );
    expect(turn?.prompt).toContain("Current comment card timeline (primary context");
    expect(turn?.prompt).toContain("This is a Feishu document comment thread.");
    expect(turn?.prompt).toContain("It is not a Feishu IM chat.");
    expect(turn?.prompt).toContain("Use plain text only.");
    expect(turn?.prompt).toContain("Do not show reasoning.");
    expect(turn?.prompt).toContain("Do not describe your plan.");
    expect(turn?.prompt).toContain("Output only the final user-facing reply.");
    expect(turn?.prompt).toContain("comment_id: 7623358762119646411");
    expect(turn?.prompt).toContain("reply_id: 7623358762136374451");
    expect(turn?.prompt).toContain(
      "Your final text reply will be posted to the current comment thread automatically.",
    );
  });

  it("parses bot mentions plus current and referenced document links from comment content", async () => {
    const wikiGetNode = vi.fn(async () => ({
      code: 0,
      data: {
        node: {
          obj_type: "docx",
          obj_token: "doc_ref_1",
        },
      },
    }));
    const client = {
      request: vi.fn(async (request: { method: "GET" | "POST"; url: string; data: unknown }) => {
        if (request.url === "/open-apis/drive/v1/metas/batch_query") {
          return {
            code: 0,
            data: {
              metas: [
                {
                  doc_token: TEST_DOC_TOKEN,
                  title: "Comment event handling request",
                  url: `https://www.larksuite.com/docx/${TEST_DOC_TOKEN}`,
                },
              ],
            },
          };
        }
        if (request.url.includes("/comments/batch_query")) {
          return {
            code: 0,
            data: {
              items: [
                {
                  comment_id: "7623358762119646411",
                  is_whole: false,
                  reply_list: {
                    replies: [
                      {
                        reply_id: "7623358762136374451",
                        user_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
                        content: {
                          elements: [
                            { type: "text_run", text_run: { text: "请 " } },
                            { type: "person", person: { user_id: "ou_bot" } },
                            { type: "text_run", text_run: { text: " 总结下 " } },
                            {
                              type: "docs_link",
                              docs_link: {
                                url: `https://www.larksuite.com/docx/${TEST_DOC_TOKEN}`,
                              },
                            },
                            { type: "text_run", text_run: { text: " 和 " } },
                            {
                              type: "docs_link",
                              docs_link: {
                                url: `https://www.larksuite.com/wiki/${TEST_WIKI_TOKEN}`,
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          };
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      }),
      wiki: {
        space: {
          getNode: wikiGetNode,
        },
      },
    };

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent(),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn?.targetReplyText).toBe(
      `请 总结下 https://www.larksuite.com/docx/${TEST_DOC_TOKEN} 和 https://www.larksuite.com/wiki/${TEST_WIKI_TOKEN}`,
    );
    expect(turn?.prompt).toContain("Bot routing mention detected in the current user comment.");
    expect(turn?.prompt).toContain("Referenced documents from current user comment:");
    expect(turn?.prompt).toContain(
      `raw_url=https://www.larksuite.com/docx/${TEST_DOC_TOKEN} url_kind=docx`,
    );
    expect(turn?.prompt).toContain("same_as_current_document=yes");
    expect(turn?.prompt).toContain(
      `raw_url=https://www.larksuite.com/wiki/${TEST_WIKI_TOKEN} url_kind=wiki ` +
        `wiki_node_token=${TEST_WIKI_TOKEN} resolved_type=docx ` +
        "resolved_token=doc_ref_1 same_as_current_document=no",
    );
    expect(wikiGetNode).toHaveBeenCalledWith({
      params: {
        token: TEST_WIKI_TOKEN,
      },
    });
  });

  it("preserves whole-document comment metadata for downstream delivery mode selection", async () => {
    const client = makeOpenApiClient({
      includeTargetReplyInBatch: true,
      isWholeComment: true,
    });

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent(),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn?.isWholeComment).toBe(true);
    expect(turn?.prompt).toContain("This is a whole-document comment.");
    expect(turn?.prompt).toContain("Whole-document comments do not support direct replies.");
  });

  it("builds a whole-comment timeline and highlights the nearest bot-authored follow-up", async () => {
    const client = {
      request: vi.fn(async (request: { method: "GET" | "POST"; url: string; data: unknown }) => {
        if (request.url === "/open-apis/drive/v1/metas/batch_query") {
          return {
            code: 0,
            data: {
              metas: [
                {
                  doc_token: TEST_DOC_TOKEN,
                  title: "Comment event handling request",
                  url: `https://www.larksuite.com/docx/${TEST_DOC_TOKEN}`,
                },
              ],
            },
          };
        }
        if (request.url.includes("/comments/batch_query")) {
          return {
            code: 0,
            data: {
              items: [
                {
                  comment_id: "7623358762119646411",
                  is_whole: true,
                  reply_list: {
                    replies: [
                      {
                        reply_id: "7623358762136374451",
                        user_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
                        create_time: 1775531531,
                        content: {
                          elements: [
                            {
                              type: "text_run",
                              text_run: {
                                text: "请帮我总结这个文档",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          };
        }
        if (request.url.includes("/comments?file_type=docx&is_whole=true")) {
          return {
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  comment_id: "7623358762119646411",
                  create_time: 1775531531,
                  user_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
                  is_whole: true,
                  reply_list: {
                    replies: [
                      {
                        reply_id: "reply_a",
                        user_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
                        create_time: 1775531531,
                        content: {
                          elements: [
                            {
                              type: "text_run",
                              text_run: {
                                text: "请帮我总结这个文档",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  comment_id: "comment_bot_followup",
                  create_time: 1775531540,
                  user_id: "ou_bot",
                  is_whole: true,
                  reply_list: {
                    replies: [
                      {
                        reply_id: "reply_b",
                        user_id: "ou_bot",
                        create_time: 1775531540,
                        content: {
                          elements: [
                            {
                              type: "text_run",
                              text_run: {
                                text: "这是刚才的总结结果",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  comment_id: "comment_other_user",
                  create_time: 1775531550,
                  user_id: "ou_other",
                  is_whole: true,
                  reply_list: {
                    replies: [
                      {
                        reply_id: "reply_c",
                        user_id: "ou_other",
                        create_time: 1775531550,
                        content: {
                          elements: [
                            {
                              type: "text_run",
                              text_run: {
                                text: "另一个 whole comment",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          };
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      }),
      wiki: {
        space: {
          getNode: vi.fn(async () => ({ code: 0, data: { node: {} } })),
        },
      },
    };

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent(),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn?.isWholeComment).toBe(true);
    expect(turn?.prompt).toContain(
      "Whole-document comment timeline (primary context for whole-comment follow-ups):",
    );
    expect(turn?.prompt).toContain("comment_id=7623358762119646411");
    expect(turn?.prompt).toContain("comment_id=comment_bot_followup");
    expect(turn?.prompt).toContain(
      'Nearest bot-authored whole-comment after the current comment: comment_id=comment_bot_followup text="这是刚才的总结结果"',
    );
    expect(turn?.prompt).toContain("Document-level session history is auxiliary background only.");
  });

  it("treats replies with missing user_id as user-authored even when bot id hints are missing", async () => {
    const client = {
      request: vi.fn(async (request: { method: "GET" | "POST"; url: string; data: unknown }) => {
        if (request.url === "/open-apis/drive/v1/metas/batch_query") {
          return {
            code: 0,
            data: {
              metas: [
                {
                  doc_token: TEST_DOC_TOKEN,
                  title: "Comment event handling request",
                  url: `https://www.larksuite.com/docx/${TEST_DOC_TOKEN}`,
                },
              ],
            },
          };
        }
        if (request.url.includes("/comments/batch_query")) {
          return {
            code: 0,
            data: {
              items: [
                {
                  comment_id: "7623358762119646411",
                  is_whole: true,
                  reply_list: {
                    replies: [
                      {
                        reply_id: "reply_missing_user",
                        create_time: 1775531531,
                        content: {
                          elements: [
                            {
                              type: "text_run",
                              text_run: {
                                text: "reply without user id",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          };
        }
        if (request.url.includes("/comments?file_type=docx&is_whole=true")) {
          return {
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  comment_id: "7623358762119646411",
                  create_time: 1775531531,
                  is_whole: true,
                  reply_list: {
                    replies: [
                      {
                        reply_id: "reply_missing_user",
                        create_time: 1775531531,
                        content: {
                          elements: [
                            {
                              type: "text_run",
                              text_run: {
                                text: "reply without user id",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          };
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      }),
      wiki: {
        space: {
          getNode: vi.fn(async () => ({ code: 0, data: { node: {} } })),
        },
      },
    };

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        reply_id: "reply_missing_user",
      }),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn?.prompt).toContain(
      "comment_id=7623358762119646411 author=user user_id=UNKNOWN current_comment=yes",
    );
    expect(turn?.prompt).not.toContain(
      "author=assistant user_id=UNKNOWN reply_id=reply_missing_user",
    );
  });

  it("does not trust whole-comment metadata from a mismatched batch_query item", async () => {
    const client = makeOpenApiClient({
      includeTargetReplyInBatch: true,
      isWholeComment: true,
      batchCommentId: "different_comment_id",
    });

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent(),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn?.isWholeComment).toBeUndefined();
    expect(turn?.prompt).not.toContain("This is a whole-document comment.");
  });

  it("preserves sender user_id for downstream allowlist checks", async () => {
    const client = makeOpenApiClient({ includeTargetReplyInBatch: true });

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          from_user_id: {
            open_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
            user_id: "on_comment_user_1",
          },
        },
      }),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn?.senderId).toBe("ou_509d4d7ace4a9addec2312676ffcba9b");
    expect(turn?.senderUserId).toBe("on_comment_user_1");
  });

  it("falls back to the replies API to resolve add_reply text", async () => {
    const client = makeOpenApiClient({
      includeTargetReplyInBatch: false,
      targetReplyText: "Please follow up on this comment",
    });

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          notice_type: "add_reply",
        },
        reply_id: "7623359125036043462",
      }),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn?.prompt).toContain('The user added a reply in "Comment event handling request".');
    expect(turn?.prompt).toContain('Current user comment text: "Please follow up on this comment"');
    expect(turn?.prompt).toContain(
      'Original comment text: "Also send it to the agent after receiving the comment event"',
    );
    expect(turn?.prompt).toContain(`file_token: ${TEST_DOC_TOKEN}`);
    expect(turn?.prompt).toContain("Event type: add_reply");
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: expect.stringContaining(
          `/comments/7623358762119646411/replies?file_type=docx&page_size=100&user_id_type=open_id`,
        ),
      }),
    );
  });

  it("retries comment reply lookup when the requested reply is not immediately visible", async () => {
    const waitMs = vi.fn(async () => {});
    const client = makeOpenApiClient({
      includeTargetReplyInBatch: false,
      repliesSequence: [
        [
          {
            reply_id: "7623358762136374451",
            text: "Also send it to the agent after receiving the comment event",
          },
          { reply_id: "7623358762999999999", text: "Earlier assistant summary" },
        ],
        [
          {
            reply_id: "7623358762136374451",
            text: "Also send it to the agent after receiving the comment event",
          },
          { reply_id: "7623358762999999999", text: "Earlier assistant summary" },
        ],
        [
          {
            reply_id: "7623358762136374451",
            text: "Also send it to the agent after receiving the comment event",
          },
          { reply_id: "7623359125999999999", text: "Insert a sentence below this paragraph" },
        ],
      ],
    });

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          notice_type: "add_reply",
        },
        reply_id: "7623359125999999999",
      }),
      botOpenId: "ou_bot",
      createClient: () => client as never,
      waitMs,
    });

    expect(turn?.targetReplyText).toBe("Insert a sentence below this paragraph");
    expect(turn?.prompt).toContain("Insert a sentence below this paragraph");
    expect(waitMs).toHaveBeenCalledTimes(2);
    expect(waitMs).toHaveBeenNthCalledWith(1, 1000);
    expect(waitMs).toHaveBeenNthCalledWith(2, 1000);
    expect(
      client.request.mock.calls.filter(
        ([request]: [{ method: string; url: string }]) =>
          request.method === "GET" && request.url.includes("/replies"),
      ),
    ).toHaveLength(3);
  });

  it("ignores self-authored comment notices", async () => {
    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          from_user_id: { open_id: "ou_bot" },
        },
      }),
      botOpenId: "ou_bot",
      createClient: () => makeOpenApiClient({}) as never,
    });

    expect(turn).toBeNull();
  });

  it("skips comment notices when bot open_id is unavailable", async () => {
    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent(),
      botOpenId: undefined,
      createClient: () => makeOpenApiClient({}) as never,
    });

    expect(turn).toBeNull();
  });
});

describe("drive.notice.comment_add_v1 monitor handler", () => {
  beforeEach(() => {
    handlers = {};
    lastRuntime = null;
    handleFeishuCommentEventMock.mockClear();
    createEventDispatcherMock.mockReset();
    createFeishuClientMock.mockReset().mockReturnValue(makeOpenApiClient({}) as never);
    createFeishuThreadBindingManagerMock.mockReset().mockImplementation(() => ({
      stop: vi.fn(),
    }));
    vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockResolvedValue("claimed");
    vi.spyOn(dedup, "tryBeginFeishuMessageProcessing").mockReturnValue(true);
    vi.spyOn(dedup, "recordProcessedFeishuMessage").mockResolvedValue(true);
    vi.spyOn(dedup, "releaseFeishuMessageProcessing").mockImplementation(() => {});
    vi.spyOn(dedup, "hasProcessedFeishuMessage").mockResolvedValue(false);
    setFeishuRuntime(createFeishuMonitorRuntime());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches comment notices through handleFeishuCommentEvent", async () => {
    const onComment = await setupCommentMonitorHandler();

    await onComment(makeDriveCommentEvent());

    expect(handleFeishuCommentEventMock).toHaveBeenCalledTimes(1);
    expect(handleFeishuCommentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        botOpenId: "ou_bot",
        event: expect.objectContaining({
          event_id: "10d9d60b990db39f96a4c2fd357fb877",
          comment_id: "7623358762119646411",
        }),
      }),
    );
  });

  it("serializes same-document comment notices before invoking handleFeishuCommentEvent", async () => {
    const onComment = await setupCommentMonitorHandler();
    let resolveFirst: (() => void) | undefined;
    handleFeishuCommentEventMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => {});

    await onComment(
      makeDriveCommentEvent({
        event_id: "evt_1",
        reply_id: "reply_1",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await onComment(
      makeDriveCommentEvent({
        event_id: "evt_2",
        reply_id: "reply_2",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleFeishuCommentEventMock).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleFeishuCommentEventMock).toHaveBeenCalledTimes(2);
    const firstCallArgs = handleFeishuCommentEventMock.mock.calls.at(0) as
      | [{ event?: { event_id?: string } }]
      | undefined;
    const secondCallArgs = handleFeishuCommentEventMock.mock.calls.at(1) as
      | [{ event?: { event_id?: string } }]
      | undefined;
    const firstCall = firstCallArgs?.[0];
    const secondCall = secondCallArgs?.[0];
    expect(firstCall?.event?.event_id).toBe("evt_1");
    expect(secondCall?.event?.event_id).toBe("evt_2");
  });

  it("drops duplicate comment events before dispatch", async () => {
    vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockResolvedValue("duplicate");
    const onComment = await setupCommentMonitorHandler();

    await onComment(makeDriveCommentEvent());

    expect(handleFeishuCommentEventMock).not.toHaveBeenCalled();
  });

  it("records generic comment-handler failures so replay stays closed", async () => {
    const onComment = await setupCommentMonitorHandler();
    handleFeishuCommentEventMock.mockRejectedValueOnce(new Error("post-send failure"));

    await onComment(makeDriveCommentEvent());

    await vi.waitFor(() => {
      expect(dedup.recordProcessedFeishuMessage).toHaveBeenCalledWith(
        "drive-comment:10d9d60b990db39f96a4c2fd357fb877",
        "default",
        expect.any(Function),
      );
      expect(dedup.releaseFeishuMessageProcessing).toHaveBeenCalledWith(
        "drive-comment:10d9d60b990db39f96a4c2fd357fb877",
        "default",
      );
      expect(lastRuntime?.error).toHaveBeenCalledWith(
        expect.stringContaining("error handling drive comment notice: Error: post-send failure"),
      );
    });
  });

  it("releases comment replay without recording when failure is explicitly retryable", async () => {
    const onComment = await setupCommentMonitorHandler();
    handleFeishuCommentEventMock.mockRejectedValueOnce(
      Object.assign(new Error("retry me"), {
        name: "FeishuRetryableSyntheticEventError",
      }),
    );

    await onComment(makeDriveCommentEvent());

    await vi.waitFor(() => {
      expect(dedup.recordProcessedFeishuMessage).not.toHaveBeenCalled();
      expect(dedup.releaseFeishuMessageProcessing).toHaveBeenCalledWith(
        "drive-comment:10d9d60b990db39f96a4c2fd357fb877",
        "default",
      );
      expect(lastRuntime?.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "error handling drive comment notice: FeishuRetryableSyntheticEventError: retry me",
        ),
      );
    });
  });
});
