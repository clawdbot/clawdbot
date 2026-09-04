// Slack tests cover updateMessageSlack chat.update edit-limit behavior.
import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "./limits.js";
import { countSlackTextUtf8Bytes } from "./truncate.js";

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

// chat.update rejects text above 4,000 UTF-8 bytes with msg_too_long (see limits.ts).
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

  it("caps chat.update text at the 4000-byte edit limit, not the 8000 send limit", async () => {
    const client = createUpdateClient();
    getSlackWriteClientMock.mockReturnValue(client);
    // Length between the edit and send limits: Slack rejects this edit with msg_too_long unless
    // updateMessageSlack truncates it first.
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
    expect(sentText).toHaveLength(3_998);
    expect(countSlackTextUtf8Bytes(sentText)).toBe(SLACK_EDIT_TEXT_MAX_BYTES);
    expect(sentText.endsWith("…")).toBe(true);
  });

  it("backs off multibyte text to Slack's live UTF-8 byte limit", async () => {
    const client = createUpdateClient();
    getSlackWriteClientMock.mockReturnValue(client);

    await updateMessageSlack({
      cfg: SLACK_TEST_CFG,
      channelId: "C123",
      messageTs: "171234.567",
      text: `${"x".repeat(3_999)}…tail`,
      blocks: statusBlocks,
    });

    const [payload] = client.chat.update.mock.calls[0] ?? [];
    const sentText = (payload as { text?: string }).text ?? "";
    expect(sentText).toBe(`${"x".repeat(3_997)}…`);
    expect(countSlackTextUtf8Bytes(sentText)).toBe(SLACK_EDIT_TEXT_MAX_BYTES);
  });

  it("uses a workspace-scoped client for an Enterprise finalization update", async () => {
    const client = createUpdateClient();
    getSlackWriteClientMock.mockReturnValue(client);
    const installationState = registerSlackInstallationState("default", "enterprise");
    try {
      await updateMessageSlack({
        cfg: SLACK_TEST_CFG,
        channelId: "C123",
        teamId: "T123",
        messageTs: "171234.567",
        text: "done",
        blocks: statusBlocks,
      });
      expect(getSlackWriteClientMock).toHaveBeenCalledWith("xoxb-test", { teamId: "T123" });
    } finally {
      installationState.release();
    }
  });
});
