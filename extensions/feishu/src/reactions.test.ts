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
});
