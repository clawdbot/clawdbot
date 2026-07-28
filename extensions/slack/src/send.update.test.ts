// Slack tests cover updateMessageSlack chat.update edit-limit behavior.
import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSlackWriteClientMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    resolveSlackAccount: () => ({
      accountId: "default",
      botToken: "xoxb-test",
      botTokenSource: "config",
      config: {},
    }),
  };
});

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return { ...actual, getSlackWriteClient: getSlackWriteClientMock };
});

const { updateMessageSlack } = await import("./send.js");

function createUpdateClient() {
  return {
    chat: {
      update: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as WebClient & { chat: { update: ReturnType<typeof vi.fn> } };
}

// chat.update rejects text longer than 4,000 characters with msg_too_long (see limits.ts);
// chat.postMessage tolerates up to 8,000. An edit must use the smaller 4,000 edit limit.
const SLACK_EDIT_TEXT_LIMIT = 4_000;
const SLACK_TEST_CFG = {
  channels: { slack: { botToken: "xoxb-test" } },
} as unknown as OpenClawConfig;
const statusBlocks: (Block | KnownBlock)[] = [
  { type: "section", text: { type: "mrkdwn", text: "status" } },
];

describe("updateMessageSlack", () => {
  beforeEach(() => {
    getSlackWriteClientMock.mockReset();
  });

  it("caps chat.update text at the 4000-char edit limit, not the 8000 send limit", async () => {
    const client = createUpdateClient();
    getSlackWriteClientMock.mockReturnValue(client);
    // Length between the 4,000 edit limit and the 8,000 send limit: Slack rejects this edit with
    // msg_too_long unless updateMessageSlack truncates to the edit limit first.
    const longText = "a".repeat(6_000);

    await updateMessageSlack({
      cfg: SLACK_TEST_CFG,
      channelId: "C123",
      messageTs: "171234.567",
      text: longText,
      blocks: statusBlocks,
    });

    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const [payload] = client.chat.update.mock.calls[0] ?? [];
    const sentText = (payload as { text?: string }).text ?? "";
    expect(sentText.length).toBeLessThanOrEqual(SLACK_EDIT_TEXT_LIMIT);
  });
});
