// Session origin must drop the prior channel's identity when a dmScope:"main" session moves
// across providers, so channel-keyed fields do not reference a now-inactive channel.
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import {
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { deriveLastRoutePatch, deriveSessionMetaPatch } from "./metadata.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

const sessionKey = "agent:user";

type ProjectedSessionEntry = SessionEntry & { origin?: SessionOrigin };

function applyOrigin(
  existing: SessionEntry | undefined,
  ctx: Partial<MsgContext>,
): ProjectedSessionEntry {
  const patch = deriveSessionMetaPatch({
    ctx: ctx as MsgContext,
    sessionKey,
    existing,
  });
  const entry = { ...existing, ...patch } as SessionEntry;
  return { ...entry, origin: sessionDeliveryOrigin(entry) };
}

const slackTurn = {
  Provider: "slack",
  Surface: "slack",
  ChatType: "direct",
  From: "slack:U0001",
  To: "slack:D111SLACK",
  NativeChannelId: "D111SLACK",
  NativeDirectUserId: "U0001",
  AccountId: "slack-team-1",
  MessageThreadId: "1700000000.000100",
} satisfies Partial<MsgContext>;

const telegramTurn = {
  Provider: "telegram",
  Surface: "telegram",
  ChatType: "direct",
  From: "telegram:42",
  To: "telegram:42",
  AccountId: "telegram-bot-1",
} satisfies Partial<MsgContext>;

describe("session origin across a channel switch", () => {
  it("clears stale channel-keyed fields when provider changes and the new turn omits them", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    expect(afterSlack.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterSlack.origin?.threadId).toBe("1700000000.000100");

    const afterTelegram = applyOrigin(afterSlack, telegramTurn);

    // Provider/surface flip to Telegram, and the Slack-only identity must not survive.
    expect(afterTelegram.origin?.provider).toBe("telegram");
    expect(afterTelegram.origin?.surface).toBe("telegram");
    expect(afterTelegram.origin?.accountId).toBe("telegram-bot-1");
    expect(afterTelegram.origin?.nativeChannelId).toBeUndefined();
    expect(afterTelegram.origin?.nativeDirectUserId).toBeUndefined();
    expect(afterTelegram.origin?.threadId).toBeUndefined();
  });

  it("does not re-stamp the prior channel id on subsequent same-channel turns", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const afterTelegram = applyOrigin(afterSlack, telegramTurn);
    const afterTelegramAgain = applyOrigin(afterTelegram, telegramTurn);

    expect(afterTelegramAgain.origin?.provider).toBe("telegram");
    expect(afterTelegramAgain.origin?.nativeChannelId).toBeUndefined();
    expect(afterTelegramAgain.origin?.threadId).toBeUndefined();
  });

  it("clears stale account id when provider changes and the new turn omits it", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const telegramWithoutAccount = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:42",
      To: "telegram:42",
    } satisfies Partial<MsgContext>;

    const afterTelegram = applyOrigin(afterSlack, telegramWithoutAccount);

    expect(afterTelegram.origin?.provider).toBe("telegram");
    expect(afterTelegram.origin?.accountId).toBeUndefined();
  });

  it("adopts the new channel's identity when the new turn supplies it", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const telegramWithChannel = {
      ...telegramTurn,
      NativeChannelId: "C222TG",
      MessageThreadId: 555,
    } satisfies Partial<MsgContext>;

    const afterTelegram = applyOrigin(afterSlack, telegramWithChannel);
    expect(afterTelegram.origin?.nativeChannelId).toBe("C222TG");
    expect(afterTelegram.origin?.threadId).toBe(555);
  });

  it("preserves sparse channel metadata across turns on the same provider", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const slackFollowUp = {
      Provider: "slack",
      Surface: "slack",
      ChatType: "direct",
      From: "slack:U0001",
      To: "slack:D111SLACK",
      AccountId: "slack-team-1",
    } satisfies Partial<MsgContext>;

    const afterFollowUp = applyOrigin(afterSlack, slackFollowUp);
    // Same provider: the established channel id and thread are retained when omitted.
    expect(afterFollowUp.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterFollowUp.origin?.threadId).toBe("1700000000.000100");
  });

  it("clears stale channel-keyed fields when the account changes and the new turn omits them", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const slackOtherAccount = {
      Provider: "slack",
      Surface: "slack",
      ChatType: "direct",
      From: "slack:U0002",
      To: "slack:D222SLACK",
      AccountId: "slack-team-2",
    } satisfies Partial<MsgContext>;

    const afterAccountSwitch = applyOrigin(afterSlack, slackOtherAccount);

    expect(afterAccountSwitch.origin?.provider).toBe("slack");
    expect(afterAccountSwitch.origin?.accountId).toBe("slack-team-2");
    expect(afterAccountSwitch.origin?.nativeChannelId).toBeUndefined();
    expect(afterAccountSwitch.origin?.nativeDirectUserId).toBeUndefined();
    expect(afterAccountSwitch.origin?.threadId).toBeUndefined();
  });

  it("clears a stored route when only the same-account surface identity changes", () => {
    const existing = applyOrigin(undefined, slackTurn);
    const afterSurfaceSwitch = applyOrigin(existing, {
      ...slackTurn,
      Surface: "slack-canvas",
      To: "slack:D222SLACK",
    });

    expect(afterSurfaceSwitch.origin?.surface).toBe("slack-canvas");
    expect(afterSurfaceSwitch.delivery).toMatchObject({
      kind: "external",
      route: { channel: "slack-canvas", target: { to: "slack:D222SLACK" } },
    });
  });

  it("preserves sparse existing channel metadata when optional identity fields are first populated", () => {
    const existing = {
      sessionId: "session-1",
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({
        context: { channel: "slack", to: "slack:D111SLACK" },
        origin: {
          provider: "slack",
          nativeChannelId: "D111SLACK",
          threadId: "1700000000.000100",
        },
      }),
    } satisfies SessionEntry;
    const slackFollowUp = {
      Provider: "slack",
      Surface: "slack",
      ChatType: "direct",
      From: "slack:U0001",
      To: "slack:D111SLACK",
      AccountId: "slack-team-1",
    } satisfies Partial<MsgContext>;

    const afterFollowUp = applyOrigin(existing, slackFollowUp);

    expect(afterFollowUp.origin?.surface).toBe("slack");
    expect(afterFollowUp.origin?.accountId).toBe("slack-team-1");
    expect(afterFollowUp.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterFollowUp.origin?.threadId).toBe("1700000000.000100");
  });

  it("preserves a fresh rich route when the inbound identity switches providers", () => {
    const patch = deriveLastRoutePatch({
      sessionKey,
      existing: applyOrigin(undefined, slackTurn),
      route: {
        channel: "telegram",
        accountId: "telegram-bot-1",
        target: { to: "chat:42", rawTo: "@forty-two", chatType: "group" },
        thread: { id: 456, kind: "topic", source: "turn" },
      },
      ctx: telegramTurn as MsgContext,
    });

    expect(patch.delivery).toMatchObject({
      kind: "external",
      route: {
        channel: "telegram",
        target: { to: "chat:42", rawTo: "@forty-two", chatType: "group" },
        thread: { id: 456, kind: "topic", source: "turn" },
      },
    });
  });
});

// Drive the production inbound-event context builder so the bug premise itself is proven, not
// assumed: a Slack DM turn populates ctx.NativeChannelId (from conversation.nativeChannelId), a
// Telegram DM turn omits it, and the same derivation path runs that real context.
function buildDirectTurn(opts: {
  provider: string;
  from: string;
  to: string;
  accountId: string;
  conversationId: string;
  nativeChannelId?: string;
}): MsgContext {
  return buildChannelInboundEventContext({
    channel: opts.provider,
    provider: opts.provider,
    surface: opts.provider,
    accountId: opts.accountId,
    messageId: "m-1",
    from: opts.from,
    sender: { id: opts.from },
    conversation: {
      kind: "direct",
      id: opts.conversationId,
      ...(opts.nativeChannelId ? { nativeChannelId: opts.nativeChannelId } : {}),
    },
    route: { agentId: "main", accountId: opts.accountId, routeSessionKey: sessionKey },
    reply: { to: opts.to },
    message: { rawBody: "hi" },
  }) as MsgContext;
}

describe("session origin across a channel switch (real inbound-event context builder)", () => {
  const slackCtx = buildDirectTurn({
    provider: "slack",
    from: "slack:U0001",
    to: "slack:D111SLACK",
    accountId: "slack-team-1",
    conversationId: "D111SLACK",
    nativeChannelId: "D111SLACK",
  });
  const telegramCtx = buildDirectTurn({
    provider: "telegram",
    from: "telegram:42",
    to: "telegram:42",
    accountId: "telegram-bot-1",
    conversationId: "42",
  });

  it("confirms the premise: Slack DM context supplies NativeChannelId, Telegram DM context omits it", () => {
    expect(slackCtx.NativeChannelId).toBe("D111SLACK");
    expect(telegramCtx.NativeChannelId).toBeUndefined();
  });

  it("resets the stale Slack channel id after a real-context Slack->Telegram switch", () => {
    const afterSlack = applyOrigin(undefined, slackCtx);
    expect(afterSlack.origin?.nativeChannelId).toBe("D111SLACK");

    const afterTelegram = applyOrigin(afterSlack, telegramCtx);
    expect(afterTelegram.origin?.provider).toBe("telegram");
    expect(afterTelegram.origin?.nativeChannelId).toBeUndefined();
  });
});

describe("session origin across a non-delivery turn", () => {
  const webchatTurn = {
    Provider: "webchat",
    Surface: "webchat",
    OriginatingChannel: "webchat",
    ChatType: "direct",
  } satisfies Partial<MsgContext>;

  it("keeps the bound Slack channel identity across a non-deliver gateway webchat turn", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const afterWebchat = applyOrigin(afterSlack, webchatTurn);

    expect(afterWebchat.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterWebchat.origin?.nativeDirectUserId).toBe("U0001");
    expect(afterWebchat.origin?.accountId).toBe("slack-team-1");
    expect(afterWebchat.origin?.threadId).toBe("1700000000.000100");
  });

  it("keeps the bound channel identity across a heartbeat tick", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const afterHeartbeat = applyOrigin(afterSlack, {
      Provider: "heartbeat",
      Surface: "heartbeat",
      OriginatingChannel: "heartbeat",
      ChatType: "direct",
    } satisfies Partial<MsgContext>);

    expect(afterHeartbeat.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterHeartbeat.origin?.threadId).toBe("1700000000.000100");
  });

  it("keeps the bound channel identity across a cron-event turn that omits the channel", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const afterCron = applyOrigin(afterSlack, {
      Provider: "cron-event",
      ChatType: "direct",
      From: "cron:job_REDACTED",
      To: "cron:job_REDACTED",
    } satisfies Partial<MsgContext>);

    expect(afterCron.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterCron.origin?.nativeDirectUserId).toBe("U0001");
    expect(afterCron.origin?.accountId).toBe("slack-team-1");
    expect(afterCron.origin?.threadId).toBe("1700000000.000100");
  });

  it("keeps the bound channel identity across an exec-event turn that omits the channel", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const afterExec = applyOrigin(afterSlack, {
      Provider: "exec-event",
      ChatType: "direct",
      From: "exec:run_REDACTED",
      To: "exec:run_REDACTED",
    } satisfies Partial<MsgContext>);

    expect(afterExec.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterExec.origin?.threadId).toBe("1700000000.000100");
  });

  it("still adopts a real channel after an intervening non-delivery turn", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const afterWebchat = applyOrigin(afterSlack, webchatTurn);
    const afterTelegram = applyOrigin(afterWebchat, telegramTurn);

    expect(afterTelegram.origin?.provider).toBe("telegram");
    expect(afterTelegram.origin?.nativeChannelId).toBeUndefined();
    expect(afterTelegram.origin?.threadId).toBeUndefined();
  });
});
