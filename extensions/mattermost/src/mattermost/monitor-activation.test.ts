// Mattermost tests cover shared mention activation wiring.
import { describe, expect, it, vi } from "vitest";
import type { MattermostPost } from "./client.js";
import {
  resolveMattermostInboundMentionDecision,
  resolveMattermostReplyToBot,
} from "./monitor-activation.js";

function resolveThreadDecision(params?: {
  accountId?: string;
  cfg?: Record<string, unknown>;
  wasMentioned?: boolean;
  commandAuthorized?: boolean;
  implicitMentionKinds?: readonly ("bot_thread_participant" | "reply_to_bot")[];
}) {
  return resolveMattermostInboundMentionDecision({
    cfg: (params?.cfg ?? {}) as never,
    accountId: params?.accountId ?? "default",
    kind: "channel",
    requireMention: true,
    canDetectMention: true,
    wasMentioned: params?.wasMentioned ?? false,
    implicitMentionKinds: params?.implicitMentionKinds ?? ["bot_thread_participant"],
    allowTextCommands: true,
    hasControlCommand: params?.commandAuthorized ?? false,
    commandAuthorized: params?.commandAuthorized ?? false,
  });
}

describe("mattermost monitor activation", () => {
  it("keeps participated-thread follow-ups enabled by default", () => {
    expect(resolveThreadDecision()).toMatchObject({
      shouldSkip: false,
      effectiveWasMentioned: true,
      matchedImplicitMentionKinds: ["bot_thread_participant"],
    });
  });

  it("applies account policy before channel policy", () => {
    const cfg = {
      channels: {
        mattermost: {
          implicitMentions: { threadParticipation: true },
          accounts: {
            work: { implicitMentions: { threadParticipation: false } },
          },
        },
      },
    };
    expect(resolveThreadDecision({ cfg })).toMatchObject({ shouldSkip: false });
    expect(resolveThreadDecision({ cfg, accountId: "work" })).toMatchObject({
      shouldSkip: true,
      effectiveWasMentioned: false,
      matchedImplicitMentionKinds: [],
    });
  });

  it("keeps explicit mentions and authorized commands independent from implicit policy", () => {
    const cfg = {
      channels: {
        mattermost: { implicitMentions: { threadParticipation: false } },
      },
    };
    expect(resolveThreadDecision({ cfg, wasMentioned: true })).toMatchObject({
      shouldSkip: false,
      effectiveWasMentioned: true,
    });
    expect(resolveThreadDecision({ cfg, commandAuthorized: true })).toMatchObject({
      shouldSkip: false,
      shouldBypassMention: true,
    });
  });

  it("engages a reply to a bot-authored thread root by default and honors replyToBot=false", () => {
    expect(resolveThreadDecision({ implicitMentionKinds: ["reply_to_bot"] })).toMatchObject({
      shouldSkip: false,
      effectiveWasMentioned: true,
      matchedImplicitMentionKinds: ["reply_to_bot"],
    });

    const cfg = { channels: { mattermost: { implicitMentions: { replyToBot: false } } } };
    expect(resolveThreadDecision({ cfg, implicitMentionKinds: ["reply_to_bot"] })).toMatchObject({
      shouldSkip: true,
      effectiveWasMentioned: false,
      matchedImplicitMentionKinds: [],
    });
  });
});

describe("resolveMattermostReplyToBot", () => {
  const rootPost = (userId: string): MattermostPost => ({ id: "root-1", user_id: userId }) as never;

  it("returns false without a thread root and never fetches", async () => {
    const fetchRootPost = vi.fn();
    expect(
      await resolveMattermostReplyToBot({
        threadRootId: undefined,
        botUserId: "bot-1",
        fetchRootPost,
      }),
    ).toBe(false);
    expect(
      await resolveMattermostReplyToBot({ threadRootId: "  ", botUserId: "bot-1", fetchRootPost }),
    ).toBe(false);
    expect(fetchRootPost).not.toHaveBeenCalled();
  });

  it("detects a thread root authored by the bot", async () => {
    const fetchRootPost = vi.fn(async () => rootPost("bot-1"));
    expect(
      await resolveMattermostReplyToBot({
        threadRootId: "root-1",
        botUserId: "bot-1",
        fetchRootPost,
      }),
    ).toBe(true);
    expect(fetchRootPost).toHaveBeenCalledWith("root-1");
  });

  it("returns false for a root authored by someone else or one that cannot be fetched", async () => {
    expect(
      await resolveMattermostReplyToBot({
        threadRootId: "root-1",
        botUserId: "bot-1",
        fetchRootPost: async () => rootPost("user-9"),
      }),
    ).toBe(false);
    expect(
      await resolveMattermostReplyToBot({
        threadRootId: "root-1",
        botUserId: "bot-1",
        fetchRootPost: async () => null,
      }),
    ).toBe(false);
  });
});
