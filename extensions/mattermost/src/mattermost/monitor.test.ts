import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  buildMattermostModelPickerSelectMessageSid,
  evaluateMattermostMentionGate,
  MattermostRetryableInboundError,
  processMattermostReplayGuardedPost,
  resolveMattermostReactionChannelId,
  resolveMattermostEffectiveReplyToId,
  resolveMattermostReplyRootId,
  resolveMattermostThreadSessionContext,
  type MattermostMentionGateInput,
  type MattermostRequireMentionResolverInput,
} from "./monitor.js";

function resolveRequireMentionForTest(params: MattermostRequireMentionResolverInput): boolean {
  const root = params.cfg.channels?.mattermost;
  const accountGroups = (
    root?.accounts?.[params.accountId] as
      | { groups?: Record<string, { requireMention?: boolean }> }
      | undefined
  )?.groups;
  const groups = accountGroups ?? root?.groups;
  const typedGroups = groups as Record<string, { requireMention?: boolean }> | undefined;
  const groupConfig = params.groupId ? typedGroups?.[params.groupId] : undefined;
  const defaultGroupConfig = typedGroups?.["*"];
  const configMention =
    typeof groupConfig?.requireMention === "boolean"
      ? groupConfig.requireMention
      : typeof defaultGroupConfig?.requireMention === "boolean"
        ? defaultGroupConfig.requireMention
        : undefined;
  if (typeof configMention === "boolean") {
    return configMention;
  }
  if (typeof params.requireMentionOverride === "boolean") {
    return params.requireMentionOverride;
  }
  return true;
}

function evaluateMentionGateForMessage(params: { cfg: OpenClawConfig; threadRootId?: string }) {
  const account = resolveMattermostAccount({ cfg: params.cfg, accountId: "default" });
  const resolver = vi.fn(resolveRequireMentionForTest);
  const input: MattermostMentionGateInput = {
    kind: "channel",
    cfg: params.cfg,
    accountId: account.accountId,
    channelId: "chan-1",
    threadRootId: params.threadRootId,
    requireMentionOverride: account.requireMention,
    resolveRequireMention: resolver,
    wasMentioned: false,
    isControlCommand: false,
    commandAuthorized: false,
    oncharEnabled: false,
    oncharTriggered: false,
    canDetectMention: true,
  };
  const decision = evaluateMattermostMentionGate(input);
  return { account, resolver, decision };
}

describe("mattermost mention gating", () => {
  it("accepts unmentioned root channel posts in onmessage mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          groupPolicy: "open",
        },
      },
    };
    const { resolver, decision } = evaluateMentionGateForMessage({ cfg });
    expect(decision.dropReason).toBeNull();
    expect(decision.shouldRequireMention).toBe(false);
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        groupId: "chan-1",
        requireMentionOverride: false,
      }),
    );
  });

  it("accepts unmentioned thread replies in onmessage mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          groupPolicy: "open",
        },
      },
    };
    const { resolver, decision } = evaluateMentionGateForMessage({
      cfg,
      threadRootId: "thread-root-1",
    });
    expect(decision.dropReason).toBeNull();
    expect(decision.shouldRequireMention).toBe(false);
    const resolverCall = resolver.mock.calls.at(-1)?.[0];
    expect(resolverCall?.groupId).toBe("chan-1");
    expect(resolverCall?.groupId).not.toBe("thread-root-1");
  });

  it("rejects unmentioned channel posts in oncall mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "oncall",
          groupPolicy: "open",
        },
      },
    };
    const { decision, account } = evaluateMentionGateForMessage({ cfg });
    expect(account.requireMention).toBe(true);
    expect(decision.shouldRequireMention).toBe(true);
    expect(decision.dropReason).toBe("missing-mention");
  });
});

describe("resolveMattermostReplyRootId with block streaming payloads", () => {
  it("uses threadRootId for block-streamed payloads with replyToId", () => {
    // When block streaming sends a payload with replyToId from the threading
    // mode, the deliver callback should still use the existing threadRootId.
    expect(
      resolveMattermostReplyRootId({
        threadRootId: "thread-root-1",
        replyToId: "streamed-reply-id",
      }),
    ).toBe("thread-root-1");
  });

  it("falls back to payload replyToId when no threadRootId in block streaming", () => {
    // Top-level channel message: no threadRootId, payload carries the
    // inbound post id as replyToId from the "all" threading mode.
    expect(
      resolveMattermostReplyRootId({
        replyToId: "inbound-post-for-threading",
      }),
    ).toBe("inbound-post-for-threading");
  });
});

describe("resolveMattermostReplyRootId", () => {
  it("uses replyToId for top-level replies", () => {
    expect(
      resolveMattermostReplyRootId({
        replyToId: "inbound-post-123",
      }),
    ).toBe("inbound-post-123");
  });

  it("keeps the thread root when replying inside an existing thread", () => {
    expect(
      resolveMattermostReplyRootId({
        threadRootId: "thread-root-456",
        replyToId: "child-post-789",
      }),
    ).toBe("thread-root-456");
  });

  it("falls back to undefined when neither reply target is available", () => {
    expect(resolveMattermostReplyRootId({})).toBeUndefined();
  });
});

describe("resolveMattermostEffectiveReplyToId", () => {
  it("keeps an existing thread root", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "channel",
        postId: "post-123",
        replyToMode: "all",
        threadRootId: "thread-root-456",
      }),
    ).toBe("thread-root-456");
  });

  it("suppresses existing thread roots when replyToMode is off", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "channel",
        postId: "post-123",
        replyToMode: "off",
        threadRootId: "thread-root-456",
      }),
    ).toBeUndefined();
  });

  it("starts a thread for top-level channel messages when replyToMode is all", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "channel",
        postId: "post-123",
        replyToMode: "all",
      }),
    ).toBe("post-123");
  });

  it("starts a thread for top-level group messages when replyToMode is first", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "group",
        postId: "post-123",
        replyToMode: "first",
      }),
    ).toBe("post-123");
  });

  it("keeps direct messages non-threaded", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "direct",
        postId: "post-123",
        replyToMode: "all",
      }),
    ).toBeUndefined();
  });
});

describe("resolveMattermostThreadSessionContext", () => {
  it("forks channel sessions by top-level post when replyToMode is all", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:chan-1",
        kind: "channel",
        postId: "post-123",
        replyToMode: "all",
      }),
    ).toEqual({
      effectiveReplyToId: "post-123",
      sessionKey: "agent:main:mattermost:default:chan-1:thread:post-123",
      parentSessionKey: "agent:main:mattermost:default:chan-1",
    });
  });

  it("keeps existing thread roots for threaded follow-ups", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:chan-1",
        kind: "group",
        postId: "post-123",
        replyToMode: "first",
        threadRootId: "root-456",
      }),
    ).toEqual({
      effectiveReplyToId: "root-456",
      sessionKey: "agent:main:mattermost:default:chan-1:thread:root-456",
      parentSessionKey: "agent:main:mattermost:default:chan-1",
    });
  });

  it("keeps threaded messages top-level when replyToMode is off", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:chan-1",
        kind: "group",
        postId: "post-123",
        replyToMode: "off",
        threadRootId: "root-456",
      }),
    ).toEqual({
      effectiveReplyToId: undefined,
      sessionKey: "agent:main:mattermost:default:chan-1",
      parentSessionKey: undefined,
    });
  });

  it("keeps direct-message sessions linear", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:user-1",
        kind: "direct",
        postId: "post-123",
        replyToMode: "all",
      }),
    ).toEqual({
      effectiveReplyToId: undefined,
      sessionKey: "agent:main:mattermost:default:user-1",
      parentSessionKey: undefined,
    });
  });
});

describe("processMattermostReplayGuardedPost", () => {
  it("skips duplicate message batches after a successful commit", async () => {
    const replayGuard = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });
    const handlePost = vi.fn(async () => undefined);

    await expect(
      processMattermostReplayGuardedPost({
        replayGuard,
        accountId: "acct",
        messageIds: ["post-1"],
        handlePost,
      }),
    ).resolves.toBe("processed");
    await expect(
      processMattermostReplayGuardedPost({
        replayGuard,
        accountId: "acct",
        messageIds: ["post-1"],
        handlePost,
      }),
    ).resolves.toBe("duplicate");

    expect(handlePost).toHaveBeenCalledTimes(1);
  });

  it("releases claims for explicit retryable failures", async () => {
    const replayGuard = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });
    let attempts = 0;
    const handlePost = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new MattermostRetryableInboundError("retry me");
      }
    });

    await expect(
      processMattermostReplayGuardedPost({
        replayGuard,
        accountId: "acct",
        messageIds: ["post-2"],
        handlePost,
      }),
    ).rejects.toThrow("retry me");
    await expect(
      processMattermostReplayGuardedPost({
        replayGuard,
        accountId: "acct",
        messageIds: ["post-2"],
        handlePost,
      }),
    ).resolves.toBe("processed");

    expect(handlePost).toHaveBeenCalledTimes(2);
  });

  it("keeps replay committed after a non-retryable failure", async () => {
    const replayGuard = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });
    const visibleSideEffect = vi.fn();
    const handlePost = vi.fn(async () => {
      visibleSideEffect();
      throw new Error("post-send failure");
    });

    await expect(
      processMattermostReplayGuardedPost({
        replayGuard,
        accountId: "acct",
        messageIds: ["post-3"],
        handlePost,
      }),
    ).rejects.toThrow("post-send failure");
    await expect(
      processMattermostReplayGuardedPost({
        replayGuard,
        accountId: "acct",
        messageIds: ["post-3"],
        handlePost,
      }),
    ).resolves.toBe("duplicate");

    expect(handlePost).toHaveBeenCalledTimes(1);
    expect(visibleSideEffect).toHaveBeenCalledTimes(1);
  });
});

describe("buildMattermostModelPickerSelectMessageSid", () => {
  it("stays stable for the same picker selection", () => {
    expect(
      buildMattermostModelPickerSelectMessageSid({
        postId: "post-1",
        provider: "OpenAI",
        model: " GPT-5 ",
      }),
    ).toBe("interaction:post-1:select:openai/gpt-5");
    expect(
      buildMattermostModelPickerSelectMessageSid({
        postId: "post-1",
        provider: "openai",
        model: "gpt-5",
      }),
    ).toBe("interaction:post-1:select:openai/gpt-5");
  });

  it("keeps different model selections distinct", () => {
    expect(
      buildMattermostModelPickerSelectMessageSid({
        postId: "post-1",
        provider: "openai",
        model: "gpt-5",
      }),
    ).not.toBe(
      buildMattermostModelPickerSelectMessageSid({
        postId: "post-1",
        provider: "openai",
        model: "gpt-4.1",
      }),
    );
  });
});

describe("resolveMattermostReactionChannelId", () => {
  it("prefers broadcast channel_id when present", () => {
    expect(
      resolveMattermostReactionChannelId({
        broadcast: { channel_id: "chan-broadcast" },
        data: { channel_id: "chan-data" },
      }),
    ).toBe("chan-broadcast");
  });

  it("falls back to data.channel_id when broadcast channel_id is missing", () => {
    expect(
      resolveMattermostReactionChannelId({
        data: { channel_id: "chan-data" },
      }),
    ).toBe("chan-data");
  });

  it("returns undefined when neither payload location includes channel_id", () => {
    expect(resolveMattermostReactionChannelId({})).toBeUndefined();
  });
});
