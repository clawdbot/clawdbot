import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSlackTurnDeliveryTracker,
  isSlackStreamingEnabled,
  resetSlackStreamRecipientTeamCacheForTests,
  resolveSlackDisableBlockStreaming,
  resolveSlackStreamRecipientTeamId,
  resolveSlackStreamingThreadHint,
  shouldEnableSlackPreviewStreaming,
  shouldInitializeSlackDraftStream,
} from "./dispatch.js";

afterEach(() => {
  resetSlackStreamRecipientTeamCacheForTests();
});

describe("slack native streaming defaults", () => {
  it("is enabled for partial mode when native streaming is on", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: true })).toBe(true);
  });

  it("is disabled outside partial mode or when native streaming is off", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: false })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "block", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "progress", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "off", nativeStreaming: true })).toBe(false);
  });
});

describe("slack native streaming recipient team", () => {
  it("resolves the recipient team through users.info", async () => {
    const usersInfo = vi.fn(async () => ({
      user: { team_id: "T_LOOKUP" },
    }));

    expect(
      await resolveSlackStreamRecipientTeamId({
        client: {
          users: {
            info: usersInfo,
          },
        } as never,
        token: "xoxb-test",
        userId: "U_REMOTE",
        fallbackTeamId: "T_LOCAL",
      }),
    ).toBe("T_LOOKUP");
    expect(usersInfo).toHaveBeenCalledWith({
      token: "xoxb-test",
      user: "U_REMOTE",
    });
  });

  it("falls back to profile.team when users.info omits user.team_id", async () => {
    expect(
      await resolveSlackStreamRecipientTeamId({
        client: {
          users: {
            info: vi.fn(async () => ({
              user: { profile: { team: "T_PROFILE" } },
            })),
          },
        } as never,
        token: "xoxb-test",
        userId: "U_REMOTE",
        fallbackTeamId: "T_LOCAL",
      }),
    ).toBe("T_PROFILE");
  });

  it("falls back to the monitor team when users.info cannot resolve a team", async () => {
    expect(
      await resolveSlackStreamRecipientTeamId({
        client: {
          users: {
            info: vi.fn(async () => {
              throw new Error("user_not_found");
            }),
          },
        } as never,
        token: "xoxb-test",
        userId: "U_REMOTE",
        fallbackTeamId: "T_LOCAL",
      }),
    ).toBe("T_LOCAL");
  });

  it("falls back to the monitor team when no user id is available", async () => {
    expect(
      await resolveSlackStreamRecipientTeamId({
        client: {
          users: {
            info: vi.fn(),
          },
        } as never,
        token: "xoxb-test",
        fallbackTeamId: "T_LOCAL",
      }),
    ).toBe("T_LOCAL");
  });

  it("caches resolved user teams for repeated stream starts", async () => {
    const usersInfo = vi.fn(async () => ({
      user: { team_id: "T_LOOKUP" },
    }));
    const params = {
      client: {
        users: {
          info: usersInfo,
        },
      } as never,
      token: "xoxb-test",
      userId: "U_REMOTE",
      fallbackTeamId: "T_LOCAL",
    };

    await expect(resolveSlackStreamRecipientTeamId(params)).resolves.toBe("T_LOOKUP");
    await expect(resolveSlackStreamRecipientTeamId(params)).resolves.toBe("T_LOOKUP");
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });
});

describe("slack turn delivery tracker", () => {
  it("treats repeated text payloads on the same thread as duplicates", () => {
    const tracker = createSlackTurnDeliveryTracker();
    const payload = { text: "same reply" };

    expect(tracker.hasDelivered({ kind: "final", payload, threadTs: "123.456" })).toBe(false);
    tracker.markDelivered({ kind: "final", payload, threadTs: "123.456" });
    expect(tracker.hasDelivered({ kind: "final", payload, threadTs: "123.456" })).toBe(true);
    expect(tracker.hasDelivered({ kind: "final", payload, threadTs: "other-thread" })).toBe(false);
  });

  it("keeps explicit reply targets distinct from the shared thread target", () => {
    const tracker = createSlackTurnDeliveryTracker();

    tracker.markDelivered({
      kind: "final",
      payload: { text: "same reply", replyToId: "thread-A" },
      threadTs: "123.456",
    });

    expect(
      tracker.hasDelivered({
        kind: "final",
        payload: { text: "same reply", replyToId: "thread-B" },
        threadTs: "123.456",
      }),
    ).toBe(false);
  });

  it("keeps distinct dispatch kinds separate for identical payloads", () => {
    const tracker = createSlackTurnDeliveryTracker();
    const payload = { text: "same reply" };

    tracker.markDelivered({ kind: "tool", payload, threadTs: "123.456" });

    expect(tracker.hasDelivered({ kind: "tool", payload, threadTs: "123.456" })).toBe(true);
    expect(tracker.hasDelivered({ kind: "final", payload, threadTs: "123.456" })).toBe(false);
  });
});

describe("slack native streaming thread hint", () => {
  it("stays off-thread when replyToMode=off and message is not in a thread", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: undefined,
        messageTs: "1000.1",
      }),
    ).toBeUndefined();
  });

  it("uses first-reply thread when replyToMode=first", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "first",
        incomingThreadTs: undefined,
        messageTs: "1000.2",
      }),
    ).toBe("1000.2");
  });

  it("uses the message timestamp for top-level channel replies when replyToMode=all", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "all",
        incomingThreadTs: undefined,
        messageTs: "1000.4",
        isThreadReply: false,
      }),
    ).toBe("1000.4");
  });

  it("uses the existing incoming thread regardless of replyToMode", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: "2000.1",
        messageTs: "1000.3",
      }),
    ).toBe("2000.1");
  });
});

describe("slack preview streaming eligibility", () => {
  it("stays off when streaming mode is disabled", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "off",
      }),
    ).toBe(false);
  });

  it("stays on for room messages when streaming mode is enabled", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "partial",
      }),
    ).toBe(true);
  });

  it("allows top-level DM draft previews without a reply thread", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "partial",
      }),
    ).toBe(true);
  });

  it("allows non-partial draft preview modes", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "block",
      }),
    ).toBe(true);
    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "progress",
      }),
    ).toBe(true);
  });

  it("keeps native streaming thread hints separate from draft preview eligibility", () => {
    const streamThreadHint = resolveSlackStreamingThreadHint({
      replyToMode: "all",
      incomingThreadTs: undefined,
      messageTs: "1000.4",
      isThreadReply: false,
    });

    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "partial",
      }),
    ).toBe(true);
    expect(streamThreadHint).toBe("1000.4");
  });
});

describe("slack draft stream initialization", () => {
  it("stays off when preview streaming is disabled", () => {
    expect(
      shouldInitializeSlackDraftStream({
        previewStreamingEnabled: false,
        useStreaming: false,
      }),
    ).toBe(false);
  });

  it("stays off when native streaming is active", () => {
    expect(
      shouldInitializeSlackDraftStream({
        previewStreamingEnabled: true,
        useStreaming: true,
      }),
    ).toBe(false);
  });

  it("turns on only for preview-only paths", () => {
    expect(
      shouldInitializeSlackDraftStream({
        previewStreamingEnabled: true,
        useStreaming: false,
      }),
    ).toBe(true);
  });
});

describe("slack block streaming suppression", () => {
  it("disables block streaming when native Slack streaming is active", () => {
    expect(
      resolveSlackDisableBlockStreaming({
        useStreaming: true,
        shouldUseDraftStream: false,
        blockStreamingEnabled: true,
      }),
    ).toBe(true);
  });

  it("disables block streaming when draft preview streaming is active", () => {
    expect(
      resolveSlackDisableBlockStreaming({
        useStreaming: false,
        shouldUseDraftStream: true,
        blockStreamingEnabled: true,
      }),
    ).toBe(true);
  });

  it("respects explicit block streaming config when preview streaming is inactive", () => {
    expect(
      resolveSlackDisableBlockStreaming({
        useStreaming: false,
        shouldUseDraftStream: false,
        blockStreamingEnabled: true,
      }),
    ).toBe(false);
    expect(
      resolveSlackDisableBlockStreaming({
        useStreaming: false,
        shouldUseDraftStream: false,
        blockStreamingEnabled: false,
      }),
    ).toBe(true);
  });

  it("leaves block streaming policy unset when no channel override exists", () => {
    expect(
      resolveSlackDisableBlockStreaming({
        useStreaming: false,
        shouldUseDraftStream: false,
        blockStreamingEnabled: undefined,
      }),
    ).toBeUndefined();
  });
});
