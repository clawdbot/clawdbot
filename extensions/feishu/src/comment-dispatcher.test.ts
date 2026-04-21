import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuRuntimeAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const createReplyPrefixContextMock = vi.hoisted(() => vi.fn());
const createCommentTypingReactionLifecycleMock = vi.hoisted(() => vi.fn());
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: resolveFeishuRuntimeAccountMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./comment-dispatcher-runtime-api.js", () => ({
  createReplyPrefixContext: createReplyPrefixContextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  createCommentTypingReactionLifecycle: createCommentTypingReactionLifecycleMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: getFeishuRuntimeMock,
}));

import { createFeishuCommentReplyDispatcher } from "./comment-dispatcher.js";

describe("createFeishuCommentReplyDispatcher", () => {
  function createTestCommentReplyDispatcher() {
    createFeishuCommentReplyDispatcher({
      cfg: {} as never,
      agentId: "main",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      accountId: "main",
      fileToken: "doc_token_1",
      fileType: "docx",
      commentId: "comment_1",
      replyId: "reply_1",
      isWholeComment: false,
    });
  }

  function latestReplyDispatcherOptions() {
    const options = createReplyDispatcherWithTypingMock.mock.calls.at(-1)?.[0];
    expect(options).toBeDefined();
    if (!options) {
      throw new Error("expected reply dispatcher options");
    }
    return options as {
      deliver: (payload: { text: string }, phase: { kind: string }) => Promise<void> | void;
      onCleanup?: () => Promise<void> | void;
      onReplyStart?: () => Promise<void> | void;
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuRuntimeAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {},
    });
    createFeishuClientMock.mockReturnValue({});
    createReplyPrefixContextMock.mockReturnValue({
      responsePrefix: undefined,
      responsePrefixContextProvider: undefined,
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "reply_1",
    });
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup: vi.fn(async () => {}),
    });
    createReplyDispatcherWithTypingMock.mockImplementation(() => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
    }));
    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          chunkTextWithMode: vi.fn((text: string) => [text]),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  it("sends final comment text without waiting for typing cleanup", async () => {
    let resolveCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup,
    });

    createTestCommentReplyDispatcher();

    const options = latestReplyDispatcherOptions();
    const deliverPromise = Promise.resolve(
      options.deliver({ text: "hello world" }, { kind: "final" }),
    );
    const status = await Promise.race([
      deliverPromise.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(status).toBe("done");
    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        file_token: "doc_token_1",
        file_type: "docx",
        comment_id: "comment_1",
        content: "hello world",
        is_whole_comment: false,
      }),
    );
    expect(cleanup).not.toHaveBeenCalled();

    void options.onCleanup?.();
    expect(cleanup).toHaveBeenCalledTimes(1);

    resolveCleanup?.();
    await deliverPromise;
  });

  it("starts the typing reaction from dispatcher onReplyStart", async () => {
    const start = vi.fn(async () => {});
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start,
      cleanup: vi.fn(async () => {}),
    });

    createTestCommentReplyDispatcher();

    const options = latestReplyDispatcherOptions();
    await options.onReplyStart?.();

    expect(start).toHaveBeenCalledTimes(1);
  });
});
