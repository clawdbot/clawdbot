// Mattermost tests cover monitor plugin behavior.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  buildMattermostButtonInteractionMessageSid,
  buildMattermostModelPickerSelectMessageSid,
  canFinalizeMattermostPreviewInPlace,
  formatMattermostFinalDeliveryOutcomeLog,
  resolveMattermostInteractionReplyRootId,
  resolveMattermostPendingHistoryKey,
  resolveMattermostReactionChannelId,
  resolveMattermostReplyRootId,
  resolveMattermostThreadSessionContext,
  shouldSuppressMattermostDefaultToolProgressMessages,
  shouldUpdateMattermostDraftToolProgress,
} from "./monitor-context.js";
import { buildMattermostInboundMediaPayload } from "./monitor-resources.js";

function resolveMattermostEffectiveReplyToId(params: {
  kind: "direct" | "group" | "channel";
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
}): string | undefined {
  return resolveMattermostThreadSessionContext({
    baseSessionKey: "agent:main:mattermost:test",
    ...params,
  }).effectiveReplyToId;
}

describe("buildMattermostInboundMediaPayload", () => {
  it("keeps a failed attachment kind aligned with a successful path", async () => {
    await expect(
      buildMattermostInboundMediaPayload([
        { path: "/tmp/image.png", contentType: "image/png", kind: "image" },
        { kind: "audio" },
      ]),
    ).resolves.toEqual({
      MediaPath: "/tmp/image.png",
      MediaUrl: "/tmp/image.png",
      MediaType: "image/png",
      MediaPaths: ["/tmp/image.png", ""],
      MediaUrls: ["/tmp/image.png", ""],
      MediaTypes: ["image/png", "audio"],
      MediaTranscribedIndexes: undefined,
      media: [
        {
          path: "/tmp/image.png",
          url: undefined,
          contentType: "image/png",
          kind: "image",
          transcribed: false,
          messageId: undefined,
        },
        {
          path: undefined,
          url: undefined,
          contentType: undefined,
          kind: "audio",
          transcribed: false,
          messageId: undefined,
        },
      ],
    });
  });

  it("keeps total failures as type-only media facts", async () => {
    await expect(
      buildMattermostInboundMediaPayload([
        { kind: "video" },
        { contentType: "application/pdf", kind: "document" },
      ]),
    ).resolves.toEqual({
      MediaPath: undefined,
      MediaUrl: undefined,
      MediaType: "video",
      MediaPaths: undefined,
      MediaUrls: undefined,
      MediaTypes: ["video", "application/pdf"],
      MediaTranscribedIndexes: undefined,
      media: [
        {
          path: undefined,
          url: undefined,
          contentType: undefined,
          kind: "video",
          transcribed: false,
          messageId: undefined,
        },
        {
          path: undefined,
          url: undefined,
          contentType: "application/pdf",
          kind: "document",
          transcribed: false,
          messageId: undefined,
        },
      ],
    });
  });
});

describe("resolveMattermostReplyRootId with block streaming payloads", () => {
  it("uses threadRootId for block-streamed payloads with replyToId", () => {
    // When block streaming sends a payload with replyToId from the threading
    // mode, the deliver callback should still use the existing threadRootId.
    expect(
      resolveMattermostReplyRootId({
        kind: "channel",
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
        kind: "channel",
        replyToId: "inbound-post-for-threading",
      }),
    ).toBe("inbound-post-for-threading");
  });
});

describe("resolveMattermostReplyRootId", () => {
  it("uses replyToId for top-level replies", () => {
    expect(
      resolveMattermostReplyRootId({
        kind: "channel",
        replyToId: "inbound-post-123",
      }),
    ).toBe("inbound-post-123");
  });

  it("keeps the thread root when replying inside an existing thread", () => {
    expect(
      resolveMattermostReplyRootId({
        kind: "channel",
        threadRootId: "thread-root-456",
        replyToId: "child-post-789",
      }),
    ).toBe("thread-root-456");
  });

  it("falls back to undefined when neither reply target is available", () => {
    expect(resolveMattermostReplyRootId({ kind: "channel" })).toBeUndefined();
  });

  it("threads direct-message replies once a DM thread root exists", () => {
    expect(
      resolveMattermostReplyRootId({
        kind: "direct",
        threadRootId: "dm-root-456",
        replyToId: "dm-post-123",
      }),
    ).toBe("dm-root-456");
  });

  it("keeps flat direct-message replies top-level when there is no DM thread root", () => {
    // A flat DM has no effective thread root, so a payload reply target stays flat.
    expect(
      resolveMattermostReplyRootId({
        kind: "direct",
        replyToId: "dm-post-123",
      }),
    ).toBeUndefined();
  });

  it("keeps group replies on the existing Mattermost thread root", () => {
    expect(
      resolveMattermostReplyRootId({
        kind: "group",
        threadRootId: "group-root-456",
        replyToId: "group-child-789",
      }),
    ).toBe("group-root-456");
  });
});

describe("resolveMattermostInteractionReplyRootId", () => {
  const interactionMessageSid = buildMattermostButtonInteractionMessageSid({
    postId: "source-post-123",
    actionId: "approve",
  });

  it("keeps the established synthetic event identity", () => {
    expect(interactionMessageSid).toBe("interaction:source-post-123:approve");
  });

  it("maps reply-to-current from the synthetic interaction id to the provider post", () => {
    expect(
      resolveMattermostInteractionReplyRootId({
        kind: "channel",
        replyToId: interactionMessageSid,
        interactionMessageSid,
        sourcePostId: "source-post-123",
      }),
    ).toBe("source-post-123");
  });

  it("preserves an explicit provider reply target", () => {
    expect(
      resolveMattermostInteractionReplyRootId({
        kind: "channel",
        replyToId: "other-provider-post",
        interactionMessageSid,
        sourcePostId: "source-post-123",
      }),
    ).toBe("other-provider-post");
  });

  it("keeps the existing provider thread root authoritative", () => {
    expect(
      resolveMattermostInteractionReplyRootId({
        kind: "channel",
        threadRootId: "thread-root-456",
        replyToId: interactionMessageSid,
        interactionMessageSid,
        sourcePostId: "source-post-123",
      }),
    ).toBe("thread-root-456");
  });

  it("keeps flat direct-message interactions unthreaded", () => {
    expect(
      resolveMattermostInteractionReplyRootId({
        kind: "direct",
        replyToId: interactionMessageSid,
        interactionMessageSid,
        sourcePostId: "source-post-123",
      }),
    ).toBeUndefined();
  });
});

describe("canFinalizeMattermostPreviewInPlace", () => {
  it("allows in-place finalization when the final reply target matches the preview thread", () => {
    expect(
      canFinalizeMattermostPreviewInPlace({
        kind: "channel",
        previewRootId: "thread-root-456",
        threadRootId: "thread-root-456",
        replyToId: "child-post-789",
      }),
    ).toBe(true);
  });

  it("prevents in-place finalization when a top-level preview would become a threaded reply", () => {
    expect(
      canFinalizeMattermostPreviewInPlace({
        kind: "channel",
        replyToId: "child-post-789",
      }),
    ).toBe(false);
  });

  it("uses direct-message root suppression when checking in-place finalization", () => {
    expect(
      canFinalizeMattermostPreviewInPlace({
        kind: "direct",
        replyToId: "dm-post-123",
      }),
    ).toBe(true);
  });
});

describe("shouldUpdateMattermostDraftToolProgress", () => {
  type MattermostConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["mattermost"]>;

  function resolveToolProgressEnabled(mattermostConfig: MattermostConfig) {
    const account = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: mattermostConfig,
        },
      },
      accountId: "default",
    });
    return shouldUpdateMattermostDraftToolProgress(account);
  }

  it("shows tool status draft lines by default", () => {
    expect(resolveToolProgressEnabled({ enabled: true })).toBe(true);
  });

  it("honors disabled progress-mode tool status lines", () => {
    expect(
      resolveToolProgressEnabled({
        streaming: {
          mode: "progress",
          progress: {
            toolProgress: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("keeps tool status draft lines disabled when draft streaming is off", () => {
    expect(
      resolveToolProgressEnabled({
        streaming: {
          mode: "off",
          progress: {
            toolProgress: true,
          },
        },
      }),
    ).toBe(false);
  });
});

describe("shouldSuppressMattermostDefaultToolProgressMessages", () => {
  type MattermostConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["mattermost"]>;

  function resolveSuppressDefaultProgress(mattermostConfig: MattermostConfig) {
    const account = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: mattermostConfig,
        },
      },
      accountId: "default",
    });
    return shouldSuppressMattermostDefaultToolProgressMessages(account);
  }

  it("suppresses standalone progress messages while draft previews are active", () => {
    expect(resolveSuppressDefaultProgress({ enabled: true })).toBe(true);
  });

  it("keeps standalone progress messages available when draft streaming is off", () => {
    expect(
      resolveSuppressDefaultProgress({
        streaming: {
          mode: "off",
        },
      }),
    ).toBe(false);
  });
});

describe("formatMattermostFinalDeliveryOutcomeLog", () => {
  it("logs delivered only for visible text and media outcomes", () => {
    expect(
      formatMattermostFinalDeliveryOutcomeLog({
        outcome: "text",
        payload: { text: "hello" } as never,
        to: "channel:town-square",
        accountId: "default",
        agentId: "agent-1",
      }),
    ).toBe("delivered reply to channel:town-square");

    expect(
      formatMattermostFinalDeliveryOutcomeLog({
        outcome: "media",
        payload: { mediaUrl: "https://example.com/a.png" } as never,
        to: "channel:town-square",
        accountId: "default",
        agentId: "agent-1",
      }),
    ).toBe("delivered reply to channel:town-square");
  });

  it("does not log delivered for empty no-send outcomes without diagnostic violations", () => {
    expect(
      formatMattermostFinalDeliveryOutcomeLog({
        outcome: "empty",
        payload: { text: "  \n\t " } as never,
        to: "channel:town-square",
        accountId: "default",
        agentId: "agent-1",
      }),
    ).toBeUndefined();
  });

  it("logs a diagnostic for substantive empty outcomes", () => {
    expect(
      formatMattermostFinalDeliveryOutcomeLog({
        outcome: "empty",
        payload: { text: "work result" } as never,
        to: "channel:town-square",
        accountId: "default",
        agentId: "agent-1",
      }),
    ).toBe(
      "mattermost no-visible-reply: no-visible-reply-after-final-delivery" +
        " to=channel:town-square" +
        " accountId=default" +
        " agentId=agent-1" +
        " outcome=empty" +
        " finalTextLength=11" +
        " mediaUrlCount=0",
    );
  });

  it("does not log reasoning-suppressed outcomes", () => {
    expect(
      formatMattermostFinalDeliveryOutcomeLog({
        outcome: "reasoning_skipped",
        payload: { text: "Reasoning: hidden" } as never,
        to: "channel:town-square",
        accountId: "default",
        agentId: "agent-1",
      }),
    ).toBeUndefined();
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

  it("keeps an existing thread root when replyToMode is off", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "channel",
        postId: "post-123",
        replyToMode: "off",
        threadRootId: "thread-root-456",
      }),
    ).toBe("thread-root-456");
  });

  it("does not start a new thread for top-level messages when replyToMode is off", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "channel",
        postId: "post-123",
        replyToMode: "off",
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

  it("starts a direct-message thread under the post when its effective mode is all", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "direct",
        postId: "post-123",
        replyToMode: "all",
      }),
    ).toBe("post-123");
  });

  it("keeps direct messages flat when their effective mode is off", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "direct",
        postId: "post-123",
        replyToMode: "off",
        threadRootId: "dm-root-456",
      }),
    ).toBeUndefined();
  });

  it("uses an existing direct-message thread root when threading is enabled", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "direct",
        postId: "post-123",
        replyToMode: "all",
        threadRootId: "dm-root-456",
      }),
    ).toBe("dm-root-456");
  });

  it("starts a new direct-message thread under the post when threading is enabled", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "direct",
        postId: "post-123",
        replyToMode: "first",
      }),
    ).toBe("post-123");
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

  it("keeps DM threads as fresh independent sessions", () => {
    const ctx = resolveMattermostThreadSessionContext({
      baseSessionKey: "agent:main:mattermost:direct:user-1",
      kind: "direct",
      postId: "post-123",
      replyToMode: "first",
    });
    expect(ctx.effectiveReplyToId).toBe("post-123");
    expect(ctx.sessionKey).toBe("agent:main:mattermost:direct:user-1:thread:post-123");
    // No parent-session inheritance: each DM topic is its own session.
    expect(ctx.parentSessionKey).toBeUndefined();
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

  it("keeps threaded messages in their Mattermost thread when replyToMode is off", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:chan-1",
        kind: "group",
        postId: "post-123",
        replyToMode: "off",
        threadRootId: "root-456",
      }),
    ).toEqual({
      effectiveReplyToId: "root-456",
      sessionKey: "agent:main:mattermost:default:chan-1:thread:root-456",
      parentSessionKey: "agent:main:mattermost:default:chan-1",
    });
  });

  it("keeps top-level messages on the base session when replyToMode is off", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:chan-1",
        kind: "group",
        postId: "post-123",
        replyToMode: "off",
      }),
    ).toEqual({
      effectiveReplyToId: undefined,
      sessionKey: "agent:main:mattermost:default:chan-1",
      parentSessionKey: undefined,
    });
  });

  it("keeps direct-message sessions linear when their effective mode is off", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:user-1",
        kind: "direct",
        postId: "post-123",
        replyToMode: "off",
        threadRootId: "dm-root-456",
      }),
    ).toEqual({
      effectiveReplyToId: undefined,
      sessionKey: "agent:main:mattermost:default:user-1",
      parentSessionKey: undefined,
    });
  });
});

describe("resolveMattermostPendingHistoryKey", () => {
  it("does not retain pending history buckets for thread-scoped direct messages", () => {
    expect(
      resolveMattermostPendingHistoryKey({
        kind: "direct",
        sessionKey: "agent:main:mattermost:direct:user-1:thread:post-123",
      }),
    ).toBeNull();
  });

  it("keeps pending room history scoped to the active session", () => {
    expect(
      resolveMattermostPendingHistoryKey({
        kind: "channel",
        sessionKey: "agent:main:mattermost:channel:chan-1:thread:post-123",
      }),
    ).toBe("agent:main:mattermost:channel:chan-1:thread:post-123");
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
