// Msteams tests cover outbound plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendAdaptiveCardMSTeams: vi.fn(),
  sendMessageMSTeams: vi.fn(),
  sendPollMSTeams: vi.fn(),
  createPoll: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendAdaptiveCardMSTeams: mocks.sendAdaptiveCardMSTeams,
  sendMessageMSTeams: mocks.sendMessageMSTeams,
  sendPollMSTeams: mocks.sendPollMSTeams,
}));

vi.mock("./polls.js", () => ({
  createMSTeamsPollStoreState: ({ accountId }: { accountId: string }) => ({
    createPoll: async (poll: unknown) =>
      await mocks.createPoll({
        ...(poll && typeof poll === "object" && !Array.isArray(poll) ? poll : {}),
        accountId,
      }),
  }),
}));

import { msteamsPlugin } from "./channel.js";
import { msteamsOutbound } from "./outbound.js";

const cfg = {
  channels: {
    msteams: {
      appId: "resolved-app-id",
    },
  },
} as OpenClawConfig;

type MSTeamsSendText = NonNullable<typeof msteamsOutbound.sendText>;
type MSTeamsSendMedia = NonNullable<typeof msteamsOutbound.sendMedia>;
type MSTeamsSendPayload = NonNullable<typeof msteamsOutbound.sendPayload>;
type MSTeamsSendPoll = NonNullable<typeof msteamsOutbound.sendPoll>;
type MSTeamsRenderPresentation = NonNullable<typeof msteamsOutbound.renderPresentation>;

function requireSendText(): MSTeamsSendText {
  const sendText = msteamsOutbound.sendText;
  if (!sendText) {
    throw new Error("Expected msteams outbound sendText");
  }
  return sendText;
}

function requireSendMedia(): MSTeamsSendMedia {
  const sendMedia = msteamsOutbound.sendMedia;
  if (!sendMedia) {
    throw new Error("Expected msteams outbound sendMedia");
  }
  return sendMedia;
}

function requireSendPayload(): MSTeamsSendPayload {
  const sendPayload = msteamsOutbound.sendPayload;
  if (!sendPayload) {
    throw new Error("Expected msteams outbound sendPayload");
  }
  return sendPayload;
}

function requireSendPoll(): MSTeamsSendPoll {
  const sendPoll = msteamsOutbound.sendPoll;
  if (!sendPoll) {
    throw new Error("Expected msteams outbound sendPoll");
  }
  return sendPoll;
}

function requireRenderPresentation(): MSTeamsRenderPresentation {
  const renderPresentation = msteamsOutbound.renderPresentation;
  if (!renderPresentation) {
    throw new Error("Expected msteams outbound renderPresentation");
  }
  return renderPresentation;
}

type PollRecord = Record<string, unknown> & { createdAt: string };

function firstPollRecord(): PollRecord {
  const [call] = mocks.createPoll.mock.calls;
  if (!call) {
    throw new Error("expected createPoll call");
  }
  const [pollRecord] = call;
  if (!pollRecord || typeof pollRecord !== "object" || Array.isArray(pollRecord)) {
    throw new Error("expected createPoll record");
  }
  if (typeof (pollRecord as { createdAt?: unknown }).createdAt !== "string") {
    throw new Error("expected createPoll record timestamp");
  }
  return pollRecord as PollRecord;
}

describe("msteamsOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMSTeams.mockReset();
    mocks.sendAdaptiveCardMSTeams.mockReset();
    mocks.sendPollMSTeams.mockReset();
    mocks.createPoll.mockReset();
    mocks.sendMessageMSTeams.mockResolvedValue({
      messageId: "msg-1",
      conversationId: "conv-1",
    });
    mocks.sendPollMSTeams.mockResolvedValue({
      pollId: "poll-1",
      messageId: "msg-poll-1",
      conversationId: "conv-1",
    });
    mocks.sendAdaptiveCardMSTeams.mockResolvedValue({
      messageId: "msg-card-1",
      conversationId: "conv-card-1",
    });
    mocks.createPoll.mockResolvedValue(undefined);
  });

  it("advertises durable payload delivery for presentation cards", () => {
    expect(msteamsOutbound.deliveryCapabilities?.durableFinal).toMatchObject({
      text: true,
      media: true,
      payload: true,
      messageSendingHooks: true,
    });
  });

  it.each([
    { configuredLimit: 6000, expectedLimit: 4000 },
    { configuredLimit: 1000, expectedLimit: 1000 },
  ])(
    "resolves the same capped $configuredLimit-character limit for lightweight and runtime outbound",
    ({ configuredLimit, expectedLimit }) => {
      const configuredCfg = {
        channels: {
          msteams: {
            appId: "resolved-app-id",
            textChunkLimit: configuredLimit,
          },
        },
      } as OpenClawConfig;
      const params = { cfg: configuredCfg, fallbackLimit: configuredLimit };

      expect(msteamsPlugin.outbound?.resolveEffectiveTextChunkLimit?.(params)).toBe(expectedLimit);
      expect(msteamsOutbound.resolveEffectiveTextChunkLimit?.(params)).toBe(expectedLimit);
    },
  );

  it("passes resolved cfg to sendMessageMSTeams for text sends", async () => {
    const cfgResult = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await requireSendText()({
      cfg: cfgResult,
      to: "conversation:abc",
      text: "hello",
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg: cfgResult,
      to: "conversation:abc",
      text: "hello",
    });
  });

  it("passes accountId to sendMessageMSTeams for named account text sends", async () => {
    await requireSendText()({
      cfg,
      accountId: "secondary",
      to: "user:secondary-user",
      text: "hello secondary",
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      accountId: "secondary",
      to: "user:secondary-user",
      text: "hello secondary",
    });
  });

  it("stores polls under the configured default account when accountId is omitted", async () => {
    const cfgWithNamedDefault = {
      channels: {
        msteams: {
          defaultAccount: "secondary",
          accounts: {
            secondary: {
              appId: "secondary-app-id",
              appPassword: "secondary-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    await requireSendPoll()({
      cfg: cfgWithNamedDefault,
      to: "conversation:abc",
      poll: {
        question: "Approve?",
        options: ["Yes", "No"],
      },
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith({
      cfg: cfgWithNamedDefault,
      accountId: "secondary",
      to: "conversation:abc",
      question: "Approve?",
      options: ["Yes", "No"],
      maxSelections: 1,
    });
    expect(firstPollRecord()).toMatchObject({
      accountId: "secondary",
      id: "poll-1",
      conversationId: "conv-1",
      messageId: "msg-poll-1",
    });
  });

  it("uses one canonical account identity for display-style poll delivery and state", async () => {
    const cfgWithDisplayAccount = {
      channels: {
        msteams: {
          accounts: {
            "Support Bot": {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    await requireSendPoll()({
      cfg: cfgWithDisplayAccount,
      accountId: "Support Bot",
      to: "conversation:abc",
      poll: {
        question: "Approve?",
        options: ["Yes", "No"],
      },
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "support-bot" }),
    );
    expect(firstPollRecord()).toMatchObject({
      accountId: "support-bot",
      id: "poll-1",
    });
  });

  it("passes accountId through injected text send dependencies", async () => {
    const injected = vi.fn().mockResolvedValue({
      messageId: "dep-msg-1",
      conversationId: "dep-conv-1",
    });

    const result = await requireSendText()({
      cfg,
      accountId: "secondary",
      deps: { msteams: injected },
      to: "user:secondary-user",
      text: "hello secondary",
    });

    expect(injected).toHaveBeenCalledWith("user:secondary-user", "hello secondary", {
      cfg,
      accountId: "secondary",
    });
    expect(mocks.sendMessageMSTeams).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "msteams",
      messageId: "dep-msg-1",
      target: { kind: "conversation", id: "dep-conv-1" },
    });
  });

  it.each([
    {
      title: "forwards resolved channel thread ids through the Teams target",
      target: "conversation:19:channel@thread.tacv2",
      peerKind: "threaded",
      threadId: "thread-root-2",
      expectedTarget: "conversation:19:channel@thread.tacv2;messageid=thread-root-2",
      expectedPeerKind: "threaded",
    },
    {
      title: "preserves explicit Teams thread targets",
      target: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
      peerKind: "threaded",
      threadId: "ambient-root",
      expectedTarget: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
      expectedPeerKind: "threaded",
    },
    {
      title: "forwards thread ids through Graph team/channel targets",
      target: "graph-team/19:channel@thread.tacv2",
      peerKind: "threaded",
      threadId: "thread-root-3",
      expectedTarget: "graph-team/19:channel@thread.tacv2;messageid=thread-root-3",
      expectedPeerKind: "threaded",
    },
    {
      title: "does not append channel thread ids to direct-message targets",
      target: "user:aad-user-1",
      peerKind: "direct",
      threadId: "quoted-parent",
      expectedTarget: "user:aad-user-1",
      expectedPeerKind: "direct",
    },
  ])("$title", async ({ target, peerKind, threadId, expectedTarget, expectedPeerKind }) => {
    await requireSendText()({
      cfg,
      to: target,
      text: peerKind,
      threadId,
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      to: expectedTarget,
      text: expectedPeerKind,
    });
  });

  it("passes resolved cfg and media roots for media sends", async () => {
    const cfgValue = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await requireSendMedia()({
      cfg: cfgValue,
      accountId: "secondary",
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg: cfgValue,
      accountId: "secondary",
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp"],
    });
  });

  it("passes accountId through injected media send dependencies", async () => {
    const injected = vi.fn().mockResolvedValue({
      messageId: "dep-media-1",
      conversationId: "dep-conv-1",
    });

    const result = await requireSendMedia()({
      cfg,
      accountId: "secondary",
      deps: { msteams: injected },
      to: "user:secondary-user",
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(injected).toHaveBeenCalledWith("user:secondary-user", "photo", {
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: undefined,
      cfg,
      accountId: "secondary",
    });
    expect(mocks.sendMessageMSTeams).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "msteams",
      messageId: "dep-media-1",
      target: { kind: "conversation", id: "dep-conv-1" },
    });
  });

  it("preserves host-owned workspace media access for direct attachments", async () => {
    const readFile = vi.fn(async () => Buffer.from("approved attachment"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      readFile,
      workspaceDir: "/approved/workspace",
    };
    const conflictingReader = vi.fn(async () => Buffer.from("unapproved attachment"));

    await requireSendMedia()({
      cfg,
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "reports/photo.png",
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
      mediaReadFile: conflictingReader,
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "reports/photo.png",
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
      mediaReadFile: conflictingReader,
    });
    expect(mocks.sendMessageMSTeams.mock.calls[0]?.[0]?.mediaAccess).toBe(mediaAccess);
  });

  it("renders and sends presentation payloads as Adaptive Cards", async () => {
    const presentation = {
      title: "Deploy",
      blocks: [
        { type: "text" as const, text: "Finished" },
        {
          type: "buttons" as const,
          buttons: [{ label: "Open", value: "open" }],
        },
      ],
    };
    const payload = {
      text: "Deploy finished",
      presentation,
    };
    const rendered = await requireRenderPresentation()({
      payload,
      presentation,
      ctx: {
        cfg,
        to: "conversation:abc",
        text: "Deploy finished",
        payload,
      },
    });

    expect(rendered?.presentation).toBe(presentation);
    expect(rendered?.channelData?.msteams).toEqual({
      presentationCard: {
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", text: "Deploy finished", wrap: true },
          { type: "TextBlock", text: "Deploy", weight: "Bolder", size: "Medium", wrap: true },
          { type: "TextBlock", text: "Finished", wrap: true },
        ],
        actions: [{ type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } }],
      },
    });

    const result = await requireSendPayload()({
      cfg,
      accountId: "secondary",
      to: "conversation:19:channel@thread.tacv2",
      threadId: "presentation-thread-root",
      text: "Deploy finished",
      payload: rendered!,
    });

    expect(mocks.sendAdaptiveCardMSTeams).toHaveBeenCalledWith({
      cfg,
      accountId: "secondary",
      to: "conversation:19:channel@thread.tacv2;messageid=presentation-thread-root",
      card: (rendered!.channelData!.msteams as { presentationCard: unknown }).presentationCard,
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-card-1",
      target: { kind: "conversation", id: "conv-card-1" },
    });
  });

  it("renders typed URL actions and omits unresolved approval actions", async () => {
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Review",
              action: { type: "url" as const, url: "https://example.com/review" },
            },
            {
              label: "Open app",
              action: { type: "web-app" as const, url: "https://example.com/app" },
            },
            {
              label: "Hosted widget",
              action: {
                type: "web-app" as const,
                widgetId: "AAAAAAAAAAAAAAAAAAAAAA",
              },
            },
            {
              label: "Allow",
              action: {
                type: "approval" as const,
                approvalId: "approval-1",
                approvalKind: "exec" as const,
                decision: "allow-once" as const,
              },
              value: "/approve approval-1 allow-once",
            },
          ],
        },
      ],
    };
    const payload = { presentation };
    const rendered = await requireRenderPresentation()({
      payload,
      presentation,
      ctx: {
        cfg,
        to: "conversation:abc",
        text: "",
        payload,
      },
    });

    const card = (rendered?.channelData?.msteams as { presentationCard?: unknown } | undefined)
      ?.presentationCard as { actions?: unknown[] } | undefined;
    expect(card?.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: "Review",
        url: "https://example.com/review",
      },
      {
        type: "Action.OpenUrl",
        title: "Open app",
        url: "https://example.com/app",
      },
    ]);
    expect(JSON.stringify(card)).not.toContain("approval-1");
    expect(JSON.stringify(card)).not.toContain("/approve");
  });

  it("falls back to text/media delivery when payload rendering did not produce a card", async () => {
    const result = await requireSendPayload()({
      cfg,
      to: "conversation:abc",
      text: "hello",
      payload: {
        text: "hello",
        channelData: { msteams: { traceId: "trace-1" } },
      },
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      text: "hello",
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-1",
      target: { kind: "conversation", id: "conv-1" },
    });
  });

  it("chunks text fallback payloads that only carry channel metadata", async () => {
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-text-1", conversationId: "conv-text" })
      .mockResolvedValueOnce({ messageId: "msg-text-2", conversationId: "conv-text" });
    const text = "x".repeat(4001);

    const result = await requireSendPayload()({
      cfg,
      to: "conversation:abc",
      text,
      payload: {
        text,
        channelData: { msteams: { traceId: "trace-1" } },
      },
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(1, {
      cfg,
      to: "conversation:abc",
      text: "x".repeat(4000),
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(2, {
      cfg,
      to: "conversation:abc",
      text: "x",
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-text-2",
      target: { kind: "conversation", id: "conv-text" },
    });
  });

  it("uses the named account chunk limit without changing root configuration", async () => {
    const configuredCfg = {
      channels: {
        msteams: {
          textChunkLimit: 4000,
          accounts: {
            secondary: {
              appId: "secondary-app-id",
              appPassword: "secondary-secret",
              webhook: { port: 3979 },
              textChunkLimit: 1000,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const text = "x".repeat(1500);

    await requireSendPayload()({
      cfg: configuredCfg,
      accountId: "secondary",
      to: "conversation:abc",
      text,
      payload: {
        text,
        channelData: { msteams: { traceId: "trace-1" } },
      },
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(1, {
      cfg: configuredCfg,
      accountId: "secondary",
      to: "conversation:abc",
      text: "x".repeat(1000),
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(2, {
      cfg: configuredCfg,
      accountId: "secondary",
      to: "conversation:abc",
      text: "x".repeat(500),
    });
    expect(configuredCfg.channels?.msteams?.textChunkLimit).toBe(4000);
  });

  it("keeps multi-media payloads on the media fallback path", async () => {
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-media-1", conversationId: "conv-media" })
      .mockResolvedValueOnce({ messageId: "msg-media-2", conversationId: "conv-media" });

    const result = await requireSendPayload()({
      cfg,
      to: "conversation:abc",
      text: "album",
      payload: {
        text: "album",
        mediaUrls: ["file:///tmp/one.png", "file:///tmp/two.png"],
        channelData: { msteams: { traceId: "trace-1" } },
      },
      mediaLocalRoots: ["/tmp"],
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(1, {
      cfg,
      to: "conversation:abc",
      text: "album",
      mediaUrl: "file:///tmp/one.png",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: undefined,
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(2, {
      cfg,
      to: "conversation:abc",
      text: "",
      mediaUrl: "file:///tmp/two.png",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: undefined,
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-media-2",
      target: { kind: "conversation", id: "conv-media" },
    });
  });

  it("preserves host media authority for every workspace-relative payload attachment", async () => {
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
    };
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-media-1", conversationId: "conv-media" })
      .mockResolvedValueOnce({ messageId: "msg-media-2", conversationId: "conv-media" });

    await requireSendPayload()({
      cfg,
      to: "conversation:abc",
      text: "album",
      payload: { text: "album", mediaUrls: ["one.png", "reports/two.png"] },
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledTimes(2);
    for (const [index, mediaUrl] of ["one.png", "reports/two.png"].entries()) {
      expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(index + 1, {
        cfg,
        to: "conversation:abc",
        text: index === 0 ? "album" : "",
        mediaUrl,
        mediaAccess,
        mediaLocalRoots: ["/unapproved/workspace"],
        mediaReadFile: undefined,
      });
      expect(mocks.sendMessageMSTeams.mock.calls[index]?.[0]?.mediaAccess).toBe(mediaAccess);
    }
  });

  it("lets media payloads use text fallback instead of card rendering", async () => {
    const payload = {
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      presentation: {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
      },
    };
    const rendered = await requireRenderPresentation()({
      payload,
      presentation: payload.presentation,
      ctx: {
        cfg,
        to: "conversation:abc",
        text: "photo",
        mediaUrl: "file:///tmp/photo.png",
        payload,
      },
    });

    expect(rendered).toBeNull();
  });

  it("passes resolved cfg to sendPollMSTeams and stores poll metadata", async () => {
    const cfgLocal = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await requireSendPoll()({
      cfg: cfgLocal,
      accountId: "secondary",
      to: "conversation:abc",
      poll: {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      },
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith({
      cfg: cfgLocal,
      accountId: "secondary",
      to: "conversation:abc",
      question: "Snack?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
    });
    const pollRecord = firstPollRecord();
    expect(pollRecord).toEqual({
      accountId: "secondary",
      id: "poll-1",
      question: "Snack?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      createdAt: pollRecord?.createdAt,
      conversationId: "conv-1",
      messageId: "msg-poll-1",
      votes: {},
    });
    expect(Number.isNaN(Date.parse(pollRecord?.createdAt))).toBe(false);
  });

  it("forwards resolved channel thread ids to poll sends", async () => {
    await requireSendPoll()({
      cfg,
      accountId: "secondary",
      to: "conversation:19:channel@thread.tacv2",
      threadId: "poll-thread-root",
      poll: {
        question: "Ship it?",
        options: ["Yes", "No"],
      },
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith({
      cfg,
      accountId: "secondary",
      to: "conversation:19:channel@thread.tacv2;messageid=poll-thread-root",
      question: "Ship it?",
      options: ["Yes", "No"],
      maxSelections: 1,
    });
  });

  it("chunks outbound text without requiring MSTeams runtime initialization", () => {
    const chunker = msteamsOutbound.chunker;
    if (!chunker) {
      throw new Error("msteams outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });
});
