import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  cleanupAmbientCommentTypingReaction,
  createCommentTypingReactionLifecycle,
} from "./comment-reaction.js";

const resolveFeishuRuntimeAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: resolveFeishuRuntimeAccountMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

describe("createCommentTypingReactionLifecycle", () => {
  const request = vi.fn();

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuRuntimeAccountMock.mockReturnValue({
      accountId: "default",
      configured: true,
      config: {
        typingIndicator: true,
      },
    });
    createFeishuClientMock.mockReturnValue({
      request,
    });
    request.mockResolvedValue({
      code: 0,
      data: {},
    });
  });

  function createTypingReactionLifecycle(...args: [replyId?: string]) {
    return createCommentTypingReactionLifecycle({
      cfg: {} as ClawdbotConfig,
      fileToken: "doc_token_1",
      fileType: "docx",
      replyId: args.length === 0 ? "reply_1" : args[0],
      runtime: {
        log: vi.fn(),
      } as never,
    });
  }

  const cleanupAmbientReply = () =>
    cleanupAmbientCommentTypingReaction({
      client: { request } as never,
      deliveryContext: {
        channel: "feishu",
        to: "comment:docx:doc_token_1:comment_1",
        threadId: "reply_1",
      },
    });

  it("adds and removes a comment typing reaction using reply_id", async () => {
    const lifecycle = createTypingReactionLifecycle();

    await lifecycle.start();
    await lifecycle.cleanup();

    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v2/files/doc_token_1/comments/reaction?file_type=docx",
        data: {
          action: "add",
          reply_id: "reply_1",
          reaction_type: "Typing",
        },
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v2/files/doc_token_1/comments/reaction?file_type=docx",
        data: {
          action: "delete",
          reply_id: "reply_1",
          reaction_type: "Typing",
        },
      }),
    );
  });

  it("skips requests when reply_id is missing", async () => {
    const lifecycle = createTypingReactionLifecycle(undefined);

    await lifecycle.start();
    await lifecycle.cleanup();

    expect(request).not.toHaveBeenCalled();
  });

  it("shares cleanup state so ambient cleanup and finally cleanup do not delete twice", async () => {
    const lifecycle = createTypingReactionLifecycle();

    await lifecycle.start();
    await cleanupAmbientReply();
    await lifecycle.cleanup();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          action: "delete",
          reply_id: "reply_1",
          reaction_type: "Typing",
        },
      }),
    );
  });

  it("retries delete during later cleanup after an ambient delete failure", async () => {
    request
      .mockResolvedValueOnce({
        code: 0,
        data: {},
      })
      .mockResolvedValueOnce({
        code: 5001,
        msg: "temporary failure",
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {},
      });

    const lifecycle = createTypingReactionLifecycle();

    await lifecycle.start();
    await cleanupAmbientReply();
    await lifecycle.cleanup();

    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          action: "delete",
          reply_id: "reply_1",
          reaction_type: "Typing",
        },
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: {
          action: "delete",
          reply_id: "reply_1",
          reaction_type: "Typing",
        },
      }),
    );
  });
});
