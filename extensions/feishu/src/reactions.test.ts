// Feishu tests cover reactions plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const listMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: () => ({
    accountId: "default",
    configured: true,
    appId: "cli_main",
    appSecret: "secret",
    domain: "feishu",
  }),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: () => ({
    im: {
      messageReaction: {
        list: listMock,
      },
    },
  }),
}));

import { listReactionsFeishu } from "./reactions.js";

describe("listReactionsFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockReset();
  });

  it("reads the SDK's nested operator ownership fields", async () => {
    listMock.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            reaction_id: "r-app",
            reaction_type: { emoji_type: "THUMBSUP" },
            operator: { operator_type: "app", operator_id: "cli_main" },
          },
          {
            reaction_id: "r-user",
            reaction_type: { emoji_type: "HEART" },
            operator: { operator_type: "user", operator_id: "ou_user" },
          },
        ],
      },
    });

    await expect(
      listReactionsFeishu({
        cfg: {} as ClawdbotConfig,
        messageId: "om_message",
      }),
    ).resolves.toEqual([
      {
        reactionId: "r-app",
        emojiType: "THUMBSUP",
        operatorType: "app",
        operatorId: "cli_main",
      },
      {
        reactionId: "r-user",
        emojiType: "HEART",
        operatorType: "user",
        operatorId: "ou_user",
      },
    ]);
  });

  it("fails closed for missing or unrecognized operator metadata", async () => {
    listMock.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            reaction_id: "r-missing",
            reaction_type: { emoji_type: "THUMBSUP" },
          },
          {
            reaction_id: "r-unknown",
            reaction_type: { emoji_type: "HEART" },
            operator: { operator_type: "tenant", operator_id: "tenant-1" },
          },
        ],
      },
    });

    const reactions = await listReactionsFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_message",
    });

    expect(reactions).toEqual([
      {
        reactionId: "r-missing",
        emojiType: "THUMBSUP",
        operatorType: "unknown",
        operatorId: "",
      },
      {
        reactionId: "r-unknown",
        emojiType: "HEART",
        operatorType: "unknown",
        operatorId: "tenant-1",
      },
    ]);
  });

  it("drains every reaction page while retaining the requested emoji filter", async () => {
    listMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            {
              reaction_id: "r-first",
              reaction_type: { emoji_type: "HEART" },
              operator: { operator_type: "user", operator_id: "ou_user" },
            },
          ],
          has_more: true,
          page_token: "page-2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            {
              reaction_id: "r-bot",
              reaction_type: { emoji_type: "HEART" },
              operator: { operator_type: "app", operator_id: "cli_main" },
            },
          ],
          has_more: false,
        },
      });

    const reactions = await listReactionsFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_message",
      emojiType: "HEART",
    });

    expect(reactions.map((reaction) => reaction.reactionId)).toEqual(["r-first", "r-bot"]);
    expect(listMock).toHaveBeenNthCalledWith(1, {
      path: { message_id: "om_message" },
      params: { reaction_type: "HEART" },
    });
    expect(listMock).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om_message" },
      params: { reaction_type: "HEART", page_token: "page-2" },
    });
  });

  it("rejects a continuation response without its required page token", async () => {
    listMock.mockResolvedValue({
      code: 0,
      data: { items: [], has_more: true },
    });

    await expect(
      listReactionsFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_message" }),
    ).rejects.toThrow(/page token/i);
    expect(listMock).toHaveBeenCalledOnce();
  });

  it("rejects repeated reaction page tokens", async () => {
    listMock.mockResolvedValue({
      code: 0,
      data: { items: [], has_more: true, page_token: "same-page" },
    });

    await expect(
      listReactionsFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_message" }),
    ).rejects.toThrow(/repeated page token/i);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("propagates API failures from continuation pages", async () => {
    listMock
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [], has_more: true, page_token: "page-2" },
      })
      .mockResolvedValueOnce({ code: 9999, msg: "continuation unavailable" });

    await expect(
      listReactionsFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_message" }),
    ).rejects.toThrow("Feishu list reactions failed: continuation unavailable");
  });

  it("drains valid reaction lists beyond 100 pages", async () => {
    let nextPage = 0;
    listMock.mockImplementation(async () => {
      nextPage += 1;
      const hasMore = nextPage < 101;
      return {
        code: 0,
        data: {
          items: hasMore
            ? []
            : [
                {
                  reaction_id: "r-last-page",
                  reaction_type: { emoji_type: "HEART" },
                  operator: { operator_type: "app", operator_id: "cli_main" },
                },
              ],
          has_more: hasMore,
          page_token: hasMore ? `page-${nextPage}` : undefined,
        },
      };
    });

    await expect(
      listReactionsFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_message" }),
    ).resolves.toEqual([
      {
        reactionId: "r-last-page",
        emojiType: "HEART",
        operatorType: "app",
        operatorId: "cli_main",
      },
    ]);
    expect(listMock).toHaveBeenCalledTimes(101);
  });
});
