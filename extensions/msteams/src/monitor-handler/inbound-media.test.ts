import { describe, expect, it, vi } from "vitest";

vi.mock("../attachments.js", () => ({
  downloadMSTeamsAttachments: vi.fn(async () => []),
  downloadMSTeamsGraphMedia: vi.fn(async () => ({ media: [] })),
  downloadMSTeamsBotFrameworkAttachments: vi.fn(async () => ({ media: [], attachmentCount: 0 })),
  buildMSTeamsGraphMessageUrls: vi.fn(() => [
    "https://graph.microsoft.com/v1.0/chats/c/messages/m",
  ]),
  extractMSTeamsHtmlAttachmentIds: vi.fn(() => ["att-0", "att-1"]),
  isBotFrameworkPersonalChatId: vi.fn((id: string | null | undefined) => {
    if (typeof id !== "string") {
      return false;
    }
    return id.startsWith("a:") || id.startsWith("8:orgid:");
  }),
}));

import {
  buildMSTeamsGraphMessageUrls,
  downloadMSTeamsAttachments,
  downloadMSTeamsBotFrameworkAttachments,
  downloadMSTeamsGraphMedia,
  extractMSTeamsHtmlAttachmentIds,
} from "../attachments.js";
import { resolveMSTeamsInboundMedia } from "./inbound-media.js";

const baseParams = {
  maxBytes: 1024 * 1024,
  tokenProvider: { getAccessToken: vi.fn(async () => "token") },
  conversationType: "personal",
  conversationId: "19:user_bot@unq.gbl.spaces",
  activity: { id: "msg-1", replyToId: undefined, channelData: {} },
  log: { debug: vi.fn() },
};

describe("resolveMSTeamsInboundMedia graph fallback trigger", () => {
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

    expect(buildMSTeamsGraphMessageUrls).toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalled();
  });

  it("does NOT trigger Graph fallback for mention-only HTML (no <attachment> tags)", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    // Mention cards include `<at>` markers but no `<attachment id="...">`,
    // so the extractor returns an empty ID list. The fallback must skip.
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrls).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><at id="0">Bot</at> hello there</div>',
        },
      ],
    });

    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
    expect(buildMSTeamsGraphMessageUrls).not.toHaveBeenCalled();
  });

  it("does NOT trigger Graph fallback when no attachments are text/html", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    // No HTML attachments at all → extractor returns [].
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrls).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        { contentType: "image/png", contentUrl: "https://example.com/img.png" },
        { contentType: "application/pdf", contentUrl: "https://example.com/doc.pdf" },
      ],
    });

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

    const call = vi.mocked(downloadMSTeamsGraphMedia).mock.calls[0]?.[0];
    // The monitor handler's logger is forwarded so graph.ts can report
    // message fetch failures instead of swallowing them (#51749).
    expect(call?.log).toBe(log);
    expect(log.debug).toHaveBeenCalledWith(
      "graph media fetch empty",
      expect.objectContaining({ attachmentIdCount: 1 }),
    );
  });
});

describe("resolveMSTeamsInboundMedia bot framework DM routing", () => {
  const dmParams = {
    ...baseParams,
    conversationType: "personal",
    conversationId: "a:1dRsHCobZ1AxURzY05Dc",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
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
    const call = vi.mocked(downloadMSTeamsBotFrameworkAttachments).mock.calls[0]?.[0];
    expect(call?.serviceUrl).toBe(dmParams.serviceUrl);
    expect(call?.attachmentIds).toEqual(["att-0", "att-1"]);
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
    expect(mediaList).toHaveLength(1);
    expect(mediaList[0].path).toBe("/tmp/report.pdf");
  });

  it("skips the Graph fallback entirely for 'a:' conversation IDs", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockResolvedValue({
      media: [],
      attachmentCount: 1,
    });
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrls).mockClear();

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
    expect(buildMSTeamsGraphMessageUrls).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does NOT call the Bot Framework endpoint for Graph-compatible '19:' IDs", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({ media: [] });

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      conversationId: "19:abc@thread.tacv2",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
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
    vi.mocked(buildMSTeamsGraphMessageUrls).mockClear();
    const log = { debug: vi.fn() };

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      log,
      conversationType: "personal",
      conversationId: "a:bf-dm-id",
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
      expect.objectContaining({
        conversationType: "personal",
        conversationId: "a:bf-dm-id",
      }),
    );
  });
});
