// Msteams tests cover inbound media plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../attachments.js", () => ({
  downloadMSTeamsAttachments: vi.fn(async () => []),
  downloadMSTeamsGraphMedia: vi.fn(async () => ({ media: [] })),
  downloadMSTeamsBotFrameworkAttachments: vi.fn(async () => ({ media: [], attachmentCount: 0 })),
  buildMSTeamsGraphMessageUrl: vi.fn(
    (params: { conversationType: string; teamAadGroupId?: string }) =>
      params.conversationType.toLowerCase() === "channel" && params.teamAadGroupId === undefined
        ? undefined
        : "https://graph.microsoft.com/v1.0/teams/team-aad-guid/channels/chan/messages/m",
  ),
  extractMSTeamsHtmlAttachmentIds: vi.fn(() => ["att-0", "att-1"]),
  isBotFrameworkPersonalChatId: vi.fn((id: string | null | undefined) => {
    if (typeof id !== "string") {
      return false;
    }
    return id.startsWith("a:") || id.startsWith("8:orgid:");
  }),
}));

import {
  buildMSTeamsGraphMessageUrl,
  downloadMSTeamsAttachments,
  downloadMSTeamsBotFrameworkAttachments,
  downloadMSTeamsGraphMedia,
  extractMSTeamsHtmlAttachmentIds,
} from "../attachments.js";
import { resolveMSTeamsInboundMedia, resolveMSTeamsInboundMediaBody } from "./inbound-media.js";

// Channel context by default: the Graph fallback is a channel/group code path,
// so its trigger tests must run against a channel conversation, not a DM.
const baseParams = {
  maxBytes: 1024 * 1024,
  tokenProvider: { getAccessToken: vi.fn(async () => "token") },
  conversationType: "channel",
  conversationId: "19:channel-thread@thread.tacv2",
  teamAadGroupId: "team-aad-guid",
  activity: {
    id: "msg-1",
    replyToId: undefined,
    channelData: {
      team: { id: "19:team-general@thread.tacv2", aadGroupId: "team-aad-guid" },
      channel: { id: "19:channel-thread@thread.tacv2" },
    },
  },
  log: { debug: vi.fn() },
};

const htmlSummary = {
  htmlAttachments: 1,
  imgTags: 0,
  dataImages: 0,
  cidImages: 0,
  srcHosts: [],
  attachmentTags: 0,
  attachmentIds: [],
};

function firstGraphMediaCall() {
  const [call] = vi.mocked(downloadMSTeamsGraphMedia).mock.calls;
  if (!call) {
    throw new Error("expected Graph media download call");
  }
  return call[0];
}

function firstBotFrameworkAttachmentCall() {
  const [call] = vi.mocked(downloadMSTeamsBotFrameworkAttachments).mock.calls;
  if (!call) {
    throw new Error("expected Bot Framework attachment download call");
  }
  return call[0];
}

describe("resolveMSTeamsInboundMedia graph fallback trigger", () => {
  it("replaces a failed attachment placeholder without marking mention-only HTML", () => {
    expect(
      resolveMSTeamsInboundMediaBody({
        body: "<media:document>",
        mediaPlaceholder: "<media:document>",
        materializedMediaPlaceholder: "",
        expectedMediaCount: 1,
        mediaCount: 0,
      }),
    ).toBe("[msteams attachment unavailable]");
    expect(
      resolveMSTeamsInboundMediaBody({
        body: "hello",
        mediaPlaceholder: "<media:document>",
        materializedMediaPlaceholder: "",
        expectedMediaCount: 0,
        mediaCount: 0,
      }),
    ).toBe("hello");
  });

  it("preserves successful media while exposing partial download failures", () => {
    expect(
      resolveMSTeamsInboundMediaBody({
        body: "<media:document> (2 files)",
        mediaPlaceholder: "<media:document> (2 files)",
        materializedMediaPlaceholder: "<media:document>",
        expectedMediaCount: 2,
        mediaCount: 1,
      }),
    ).toBe("<media:document>\n\n[msteams attachment unavailable]");
  });

  it("triggers Graph fallback when HTML contains <attachment> tags", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce(["att-0"]);
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({
      media: [{ path: "/tmp/img.png", contentType: "image/png", placeholder: "[image]" }],
    });

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        {
          contentType: "text/html",
          content: '<div>A file <attachment id="att-0"></attachment></div>',
        },
      ],
    });

    expect(buildMSTeamsGraphMessageUrl).toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalled();
  });

  it("triggers opted-in Graph fallback for text plus a tagless channel file stub", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      graphMediaFallback: true,
      htmlSummary,
      attachments: [
        {
          contentType: "Text/HTML; charset=utf-8",
          content: '<div><at id="0">Bot</at></div>',
        },
      ],
    });

    expect(buildMSTeamsGraphMessageUrl).toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalled();
  });

  it("keeps marker-free Graph fallback disabled by default", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      htmlSummary,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><at id="0">Bot</at> Describe the attached image file</div>',
        },
      ],
    });

    expect(buildMSTeamsGraphMessageUrl).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("triggers Graph fallback for a tagless group-chat HTML attachment", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      graphMediaFallback: true,
      conversationType: "groupChat",
      conversationId: "19:group-chat@thread.v2",
      teamAadGroupId: undefined,
      activity: { id: "msg-1", replyToId: undefined, channelData: {} },
      htmlSummary,
      attachments: [{ contentType: "text/html", content: "<div>file stub</div>" }],
    });

    expect(buildMSTeamsGraphMessageUrl).toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalled();
  });

  it("does not widen marker-free fallback to a Graph-compatible personal chat", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      graphMediaFallback: true,
      conversationType: "personal",
      conversationId: "19:real-graph-chat@unq.gbl.spaces",
      teamAadGroupId: undefined,
      activity: { id: "msg-1", replyToId: undefined, channelData: {} },
      htmlSummary,
      attachments: [{ contentType: "text/html", content: "<div>mention only</div>" }],
    });

    expect(buildMSTeamsGraphMessageUrl).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does NOT trigger Graph fallback when no attachments are text/html", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    // No HTML attachments at all → extractor returns [].
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      graphMediaFallback: true,
      attachments: [
        { contentType: "image/png", contentUrl: "https://example.com/img.png" },
        { contentType: "application/pdf", contentUrl: "https://example.com/doc.pdf" },
      ],
    });

    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does not resolve Graph team identity when direct media succeeds", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValueOnce([
      { path: "/tmp/direct.png", contentType: "image/png", placeholder: "<media:image>" },
    ]);
    const resolveTeamAadGroupId = vi.fn(async () => "team-aad-guid");

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      teamAadGroupId: undefined,
      resolveTeamAadGroupId,
      attachments: [{ contentType: "image/png", contentUrl: "https://example.com/direct.png" }],
    });

    expect(resolveTeamAadGroupId).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("forwards canonical channel reply identifiers to the URL builder", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce(["att-0"]);
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({ media: [] });

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      conversationMessageId: "conversation-root",
      teamAadGroupId: "entra-team-id",
      activity: {
        id: "reply-id",
        replyToId: "activity-root",
        channelData: {
          team: { id: "bot-framework-team-id", aadGroupId: "stale-activity-value" },
          channel: { id: "channel-id" },
        },
      },
      attachments: [
        {
          contentType: "text/html",
          content: '<attachment id="att-0"></attachment>',
        },
      ],
    });

    expect(buildMSTeamsGraphMessageUrl).toHaveBeenCalledWith({
      conversationType: "channel",
      conversationId: "19:channel-thread@thread.tacv2",
      messageId: "reply-id",
      threadRootMessageId: "conversation-root",
      teamAadGroupId: "entra-team-id",
      channelId: "channel-id",
    });
  });

  it("fails closed when a channel AAD group ID could not be resolved", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce(["att-0"]);
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      teamAadGroupId: undefined,
      attachments: [
        {
          contentType: "text/html",
          content: '<attachment id="att-0"></attachment>',
        },
      ],
    });

    expect(buildMSTeamsGraphMessageUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        teamAadGroupId: undefined,
        channelId: "19:channel-thread@thread.tacv2",
      }),
    );
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does NOT trigger Graph fallback when direct download succeeds", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([
      { path: "/tmp/img.png", contentType: "image/png", placeholder: "[image]" },
    ]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><attachment id="att-0"></attachment></div>',
        },
      ],
    });

    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("forwards log through to downloadMSTeamsGraphMedia for diagnostics", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce(["att-0"]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({ media: [] });
    const log = { debug: vi.fn() };

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      log,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><attachment id="att-0"></attachment></div>',
        },
      ],
    });

    const call = firstGraphMediaCall();
    // The monitor handler's logger is forwarded so graph.ts can report
    // message fetch failures instead of swallowing them (#51749).
    expect(call?.logger).toBe(log);
    expect(log.debug).toHaveBeenCalledWith("graph media fetch empty", {
      messageUrl: "https://graph.microsoft.com/v1.0/teams/team-aad-guid/channels/chan/messages/m",
      hostedStatus: undefined,
      attachmentStatus: undefined,
      hostedCount: undefined,
      attachmentCount: undefined,
      tokenError: undefined,
      attachmentIdCount: 1,
    });
  });
});

describe("resolveMSTeamsInboundMedia bot framework DM routing", () => {
  const dmParams = {
    ...baseParams,
    conversationType: "personal",
    conversationId: "a:1dRsHCobZ1AxURzY05Dc",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    activity: { id: "msg-1", replyToId: undefined, channelData: {} },
  };

  it("routes 'a:' conversation IDs through the Bot Framework attachment endpoint", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockResolvedValue({
      media: [
        {
          path: "/tmp/report.pdf",
          contentType: "application/pdf",
          placeholder: "<media:document>",
        },
      ],
      attachmentCount: 1,
    });
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();

    const mediaList = await resolveMSTeamsInboundMedia({
      ...dmParams,
      attachments: [
        {
          contentType: "text/html",
          content: '<div>A file <attachment id="att-0"></attachment></div>',
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).toHaveBeenCalledTimes(1);
    const call = firstBotFrameworkAttachmentCall();
    expect(call?.serviceUrl).toBe(dmParams.serviceUrl);
    expect(call?.attachmentIds).toEqual(["att-0", "att-1"]);
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
    expect(mediaList).toHaveLength(1);
    expect(expectDefined(mediaList[0], "MSTeams inbound media").path).toBe("/tmp/report.pdf");
  });

  it("skips Graph fallback for an 'a:' conversation without an exact Graph chat ID", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockResolvedValue({
      media: [],
      attachmentCount: 1,
    });
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...dmParams,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><attachment id="att-0"></attachment></div>',
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).toHaveBeenCalled();
    expect(buildMSTeamsGraphMessageUrl).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does NOT call the Bot Framework endpoint for Graph-compatible '19:' IDs", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({ media: [] });

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      conversationType: "personal",
      conversationId: "19:abc@thread.tacv2",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      activity: { id: "msg-1", replyToId: undefined, channelData: {} },
      attachments: [
        {
          contentType: "text/html",
          content: '<div><attachment id="att-0"></attachment></div>',
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalled();
  });

  it("skips BF DM attachment fetch entirely when HTML has no <attachment> tags", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    // Mention-only HTML (no `<attachment id="...">` tag) → extractor
    // returns []. The fallback skips both the Bot Framework and Graph
    // paths so we do not emit spurious 404 diagnostics (#58617).
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);

    await resolveMSTeamsInboundMedia({
      ...dmParams,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><at id="0">Bot</at> hello</div>',
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("logs when serviceUrl is missing for a BF DM with HTML content", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();
    const log = { debug: vi.fn() };

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      log,
      conversationType: "personal",
      conversationId: "a:bf-dm-id",
      activity: { id: "msg-1", replyToId: undefined, channelData: {} },
      attachments: [
        {
          contentType: "text/html",
          content: '<div><attachment id="att-0"></attachment></div>',
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    // Graph fallback is also skipped because the ID is 'a:'
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "bot framework attachment skipped (missing serviceUrl)",
      {
        conversationType: "personal",
        conversationId: "a:bf-dm-id",
      },
    );
  });
});
