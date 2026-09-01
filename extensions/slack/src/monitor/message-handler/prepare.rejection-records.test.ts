import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

const store = createSlackSessionStoreFixture("slack-rejection-record-");
beforeAll(() => store.setup());
afterAll(() => store.cleanup());
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const { storePath } = store.makeTmpStorePath();
  const ctx = createInboundSlackTestContext({
    cfg: { session: { store: storePath }, channels: { slack: { enabled: true } } },
  });
  ctx.resolveUserName = async () => ({ name: "Synthetic sender" });
  ctx.resolveChannelName = async () => ({ name: "synthetic-room", type: "channel" });
  const info = vi.spyOn(ctx.logger, "info").mockImplementation(() => undefined);
  const message: SlackMessageEvent = {
    type: "message",
    channel: "D123",
    channel_type: "im",
    user: "U1",
    ts: "1.000",
    text: "private message content must not enter rejection records",
  };
  const prepare = (source: "message" | "app_mention" = "message") =>
    prepareSlackMessage({ ctx, account: createSlackTestAccount(), message, opts: { source } });
  return { ctx, info, message, prepare };
}

describe("Slack preparation rejection records", () => {
  it.each([
    {
      reason: "empty-content",
      change: ({ message }: ReturnType<typeof fixture>) => {
        message.text = "";
      },
    },
    {
      reason: "missing-user",
      change: ({ message }: ReturnType<typeof fixture>) => {
        message.user = undefined;
      },
    },
    {
      reason: "dm-disabled",
      change: ({ ctx }: ReturnType<typeof fixture>) => {
        ctx.dmEnabled = false;
      },
    },
    {
      reason: "dm-unauthorized",
      change: ({ ctx }: ReturnType<typeof fixture>) => {
        ctx.dmPolicy = "allowlist";
        ctx.allowFrom = ["U_ALLOWED"];
      },
    },
    {
      reason: "bot-disabled",
      change: ({ message }: ReturnType<typeof fixture>) => {
        message.bot_id = "B_OTHER";
        message.subtype = "bot_message";
      },
    },
  ])("records only routing facts for $reason", async ({ reason, change }) => {
    const test = fixture();
    change(test);
    expect(await test.prepare()).toBeNull();
    expect(test.info).toHaveBeenCalledExactlyOnceWith(
      {
        provider: "slack",
        accountId: "default",
        teamId: "T1",
        channelId: "D123",
        messageTs: "1.000",
        source: "message",
        reason,
      },
      "Slack inbound event rejected during preparation",
    );
  });

  it("does not report self-message loop prevention as a rejected user attempt", async () => {
    const { message, info, prepare } = fixture();
    message.user = "B1";
    message.bot_id = "B1";
    message.subtype = "bot_message";
    expect(await prepare()).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });

  it("records the unmentioned attempt while its app_mention twin still prepares", async () => {
    const { ctx, message, info, prepare } = fixture();
    message.channel = "C123";
    message.channel_type = "channel";
    ctx.historyLimit = 5;
    expect(await prepare()).toBeNull();
    expect(info).toHaveBeenCalledExactlyOnceWith(
      {
        provider: "slack",
        accountId: "default",
        teamId: "T1",
        channelId: "C123",
        messageTs: "1.000",
        source: "message",
        reason: "missing-mention",
      },
      "Slack inbound event rejected during preparation",
    );
    const prepared = await prepare("app_mention");
    expect(prepared?.ctxPayload.MentionSource).toBe("explicit_bot");
    expect(info).toHaveBeenCalledTimes(1);
  });
});
