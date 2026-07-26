// Mattermost tests cover monitor plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { resolveMattermostAccount } from "./accounts.js";
import * as clientModule from "./client.js";
import type { MattermostClient } from "./client.js";
import {
  buildMattermostModelPickerSelectMessageSid,
  canFinalizeMattermostPreviewInPlace,
  formatMattermostFinalDeliveryOutcomeLog,
  resolveMattermostPendingHistoryKey,
  resolveMattermostReactionChannelId,
  resolveMattermostReplyRootId,
  resolveMattermostThreadSessionContext,
  shouldSuppressMattermostDefaultToolProgressMessages,
  shouldUpdateMattermostDraftToolProgress,
} from "./monitor-context.js";
import { deliverMattermostReplyWithDraftPreview } from "./monitor-draft-delivery.js";
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

const updateMattermostPostSpy = vi.spyOn(clientModule, "updateMattermostPost");

function createMattermostClientMock(): MattermostClient {
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: vi.fn(async () => ({})) as MattermostClient["request"],
    fetchImpl: vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as MattermostClient["fetchImpl"],
  };
}

function createDraftStreamMock(postId: string | undefined = "preview-post-1") {
  return {
    flush: vi.fn(async () => {}),
    postId: vi.fn(() => postId),
    clear: vi.fn(async () => {}),
    discardPending: vi.fn(async () => {}),
    seal: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMattermostPostSpy.mockResolvedValue({ id: "patched" } as never);
});

describe("buildMattermostInboundMediaPayload", () => {
  it("keeps a failed attachment kind aligned with a successful path", () => {
    expect(
      buildMattermostInboundMediaPayload([
        { path: "/tmp/image.png", contentType: "image/png", kind: "image" },
        { kind: "audio" },
      ]),
    ).toEqual({
      MediaPath: "/tmp/image.png",
      MediaUrl: "/tmp/image.png",
      MediaType: "image/png",
      MediaPaths: ["/tmp/image.png", ""],
      MediaUrls: ["/tmp/image.png", ""],
      MediaTypes: ["image/png", "audio"],
      MediaTranscribedIndexes: undefined,
    });
  });

  it("keeps total failures as type-only media facts", () => {
    expect(
      buildMattermostInboundMediaPayload([
        { kind: "video" },
        { contentType: "application/pdf", kind: "document" },
      ]),
    ).toEqual({
      MediaPath: undefined,
      MediaUrl: undefined,
      MediaType: "video",
      MediaPaths: undefined,
      MediaUrls: undefined,
      MediaTypes: ["video", "application/pdf"],
      MediaTranscribedIndexes: undefined,
    });
  });
});

function mockCall(mock: { mock: { calls: unknown[][] } }, index: number, label: string): unknown[] {
  const resolvedIndex = index < 0 ? mock.mock.calls.length + index : index;
  const call = mock.mock.calls[resolvedIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${index}`);
  }
  return call;
}

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
      allowUnresolvedSecretRef: true,
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
      allowUnresolvedSecretRef: true,
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

describe("deliverMattermostReplyWithDraftPreview", () => {
  it("suppresses reasoning-prefixed finals before preview finalization", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {});
    const recordThreadParticipation = vi.fn();

    await deliverMattermostReplyWithDraftPreview({
      payload: { text: "  \n > Reasoning:\n> _hidden_" } as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => text?.trim(),
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      recordThreadParticipation,
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).not.toHaveBeenCalled();
    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(updateMattermostPostSpy).not.toHaveBeenCalled();
    // No visible reply was sent, so the thread must not be marked as participated.
    expect(recordThreadParticipation).not.toHaveBeenCalled();
  });

  it("records thread participation when a same-thread final finalizes the preview in place", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {});
    const recordThreadParticipation = vi.fn();

    await deliverMattermostReplyWithDraftPreview({
      payload: { text: "All good" } as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => text?.trim(),
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      recordThreadParticipation,
      deliverPayload: deliverFinal,
    });

    // Default streaming finalizes by editing the preview post, bypassing deliverPayload —
    // participation must still be recorded (regression: PR #95552 review P1).
    expect(updateMattermostPostSpy).toHaveBeenCalledWith(expect.anything(), "preview-post-1", {
      message: "All good",
    });
    expect(deliverFinal).not.toHaveBeenCalled();
    expect(recordThreadParticipation).toHaveBeenCalledTimes(1);
  });

  it("deletes the preview after a successful normal final send", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {});

    await deliverMattermostReplyWithDraftPreview({
      payload: { text: "All good", replyToId: "reply-1" } as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      resolvePreviewFinalText: (text) => text?.trim(),
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledTimes(1);
    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(updateMattermostPostSpy).not.toHaveBeenCalled();
  });

  it("deletes the preview after a successful non-finalizable media final", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {});

    await deliverMattermostReplyWithDraftPreview({
      payload: {
        text: "Photo",
        replyToId: "reply-1",
        mediaUrl: "https://example.com/a.png",
      } as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => text?.trim(),
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledTimes(1);
    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview and sends media-only for TTS supplement finals", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {});

    await deliverMattermostReplyWithDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => text?.trim(),
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
    });

    expect(updateMattermostPostSpy).toHaveBeenCalledWith(expect.anything(), "preview-post-1", {
      message: "Spoken answer",
    });
    expect(draftStream.discardPending).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(deliverFinal).toHaveBeenCalledWith({
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: { spokenText: "Spoken answer" },
    });
  });

  it("falls back with visible text when TTS supplement preview finalization fails", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {});
    updateMattermostPostSpy.mockRejectedValueOnce(new Error("edit failed"));

    await deliverMattermostReplyWithDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => text?.trim(),
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
    });

    expect(updateMattermostPostSpy).toHaveBeenCalledTimes(1);
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverFinal).toHaveBeenCalledWith({
      text: "Spoken answer",
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: { spokenText: "Spoken answer" },
    });
  });

  it("keeps already-delivered TTS supplement fallback audio-only", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {});
    updateMattermostPostSpy.mockRejectedValueOnce(new Error("edit failed"));

    await deliverMattermostReplyWithDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: {
          spokenText: "Spoken answer",
          visibleTextAlreadyDelivered: true,
        },
      } as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => text?.trim(),
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledWith({
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: {
        spokenText: "Spoken answer",
        visibleTextAlreadyDelivered: true,
      },
    });
  });

  it("does not flush error finals before normal delivery", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {});

    await deliverMattermostReplyWithDraftPreview({
      payload: { text: "Error", isError: true } as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => text?.trim(),
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
    });

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(deliverFinal).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("finalizes the preview in place when the final targets the same thread", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {});
    const client = createMattermostClientMock();

    await deliverMattermostReplyWithDraftPreview({
      payload: { text: "Final answer", replyToId: "child-post-789" } as never,
      info: { kind: "final" },
      kind: "channel",
      client,
      draftStream,
      effectiveReplyToId: "thread-root-456",
      resolvePreviewFinalText: (text) => text?.trim(),
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
    });

    expect(updateMattermostPostSpy).toHaveBeenCalledTimes(1);
    const [updateClient, updatePostId, updateParams] = mockCall(
      updateMattermostPostSpy,
      0,
      "updateMattermostPost",
    );
    expect(updateClient).toBe(client);
    expect(updatePostId).toBe("preview-post-1");
    expect(updateParams).toStrictEqual({ message: "Final answer" });
    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(draftStream.seal).toHaveBeenCalledTimes(1);
    expect(draftStream.seal.mock.invocationCallOrder[0]).toBeLessThan(
      updateMattermostPostSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(deliverFinal).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("keeps the existing preview unchanged when final delivery fails", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {
      throw new Error("send failed");
    });

    await expect(
      deliverMattermostReplyWithDraftPreview({
        payload: { text: "Broken", replyToId: "reply-1" } as never,
        info: { kind: "final" },
        kind: "channel",
        client: createMattermostClientMock(),
        draftStream,
        resolvePreviewFinalText: (text) => text?.trim(),
        previewState: { finalizedViaPreviewPost: false },
        logVerboseMessage: vi.fn(),
        deliverPayload: deliverFinal,
      }),
    ).rejects.toThrow("send failed");

    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(updateMattermostPostSpy).not.toHaveBeenCalled();
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
