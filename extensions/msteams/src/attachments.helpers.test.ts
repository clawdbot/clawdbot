// Msteams tests cover attachments.helpers plugin behavior.
import { describe, expect, it } from "vitest";
import { buildMSTeamsGraphMessageUrl, resolveMSTeamsAdvertisedMedia } from "./attachments.js";

const SHAREPOINT_HOST = "contoso.sharepoint.com";
const TEST_HOST = "x";
const createUrlForHost = (host: string, pathSegment: string) => `https://${host}/${pathSegment}`;
const createTestUrl = (pathSegment: string) => createUrlForHost(TEST_HOST, pathSegment);
const TEST_URL_IMAGE = createTestUrl("img");
const TEST_URL_PDF = createTestUrl("x.pdf");
const CONTENT_TYPE_APPLICATION_PDF = "application/pdf";
const CONTENT_TYPE_TEXT_HTML = "text/html";
type GraphMessageUrlParams = Parameters<typeof buildMSTeamsGraphMessageUrl>[0];
const withLabel = <T extends object>(label: string, fields: T): T & { label: string } => ({
  label,
  ...fields,
});
const buildAttachment = <T extends Record<string, unknown>>(contentType: string, props: T) => ({
  contentType,
  ...props,
});
const createHtmlAttachment = (content: string) =>
  buildAttachment(CONTENT_TYPE_TEXT_HTML, { content });
const DEFAULT_CHANNEL_TEAM_ID = "team-id";
const DEFAULT_CHANNEL_ID = "chan-id";
const createChannelGraphMessageUrlParams = (
  params: Pick<GraphMessageUrlParams, "messageId" | "threadRootMessageId">,
) => ({
  conversationType: "channel" as const,
  teamAadGroupId: DEFAULT_CHANNEL_TEAM_ID,
  channelId: DEFAULT_CHANNEL_ID,
  ...params,
});
const GRAPH_CHANNEL_MESSAGES_ROOT =
  "https://graph.microsoft.com/v1.0/teams/team-id/channels/chan-id/messages";

const ADVERTISED_MEDIA_CASES = [
  withLabel("returns no facts without attachments", {
    attachments: undefined,
    expected: [],
  }),
  withLabel("returns no facts for an empty attachment list", {
    attachments: [],
    expected: [],
  }),
  withLabel("returns an image fact for one image", {
    attachments: [{ contentType: "image/png", contentUrl: "https://x.test/image.png" }],
    expected: [{ kind: "image" }],
  }),
  withLabel("counts multiple images", {
    attachments: [
      { contentType: "image/png", contentUrl: "https://x.test/one.png" },
      { contentType: "image/jpeg", contentUrl: "https://x.test/two.jpg" },
    ],
    expected: [{ kind: "image" }, { kind: "image" }],
  }),
  withLabel("recognizes Teams download-info images", {
    attachments: [
      {
        contentType: "application/vnd.microsoft.teams.file.download.info",
        content: { downloadUrl: "https://x.test/download", fileType: "png" },
      },
    ],
    expected: [{ kind: "image" }],
  }),
  withLabel("returns a document presentation for one document", {
    attachments: [{ contentType: "application/pdf", contentUrl: "https://x.test/file.pdf" }],
    expected: [{ kind: "document" }],
  }),
  withLabel("counts multiple documents", {
    attachments: [
      { contentType: "application/pdf", contentUrl: "https://x.test/one.pdf" },
      { contentType: "application/pdf", contentUrl: "https://x.test/two.pdf" },
    ],
    expected: [{ kind: "document" }, { kind: "document" }],
  }),
  withLabel("counts one inline image", {
    attachments: [createHtmlAttachment('<p>hi</p><img src="https://x.test/one.png" />')],
    expected: [{ kind: "image", sourceId: "https://x.test/one.png" }],
  }),
  withLabel("counts multiple inline images", {
    attachments: [
      createHtmlAttachment(
        '<img src="https://x.test/one.png" /><img src="https://x.test/two.png" />',
      ),
    ],
    expected: [
      { kind: "image", sourceId: "https://x.test/one.png" },
      { kind: "image", sourceId: "https://x.test/two.png" },
    ],
  }),
];

const GRAPH_MESSAGE_URL_CASES = [
  withLabel("builds a channel top-level message URL", {
    params: createChannelGraphMessageUrlParams({
      messageId: "123",
    }),
    expectedUrl: `${GRAPH_CHANNEL_MESSAGES_ROOT}/123`,
  }),
  withLabel("builds a channel reply URL beneath its thread root", {
    params: createChannelGraphMessageUrlParams({
      messageId: "reply-id",
      threadRootMessageId: "root-id",
    }),
    expectedUrl: `${GRAPH_CHANNEL_MESSAGES_ROOT}/root-id/replies/reply-id`,
  }),
  withLabel("builds a chat message URL", {
    params: {
      conversationType: "groupChat" as const,
      conversationId: "19:chat@thread.v2",
      messageId: "456",
    } satisfies GraphMessageUrlParams,
    expectedUrl: "https://graph.microsoft.com/v1.0/chats/19%3Achat%40thread.v2/messages/456",
  }),
];

describe("msteams attachment helpers", () => {
  describe("resolveMSTeamsAdvertisedMedia", () => {
    it.each(ADVERTISED_MEDIA_CASES)("$label", ({ attachments, expected }) => {
      expect(resolveMSTeamsAdvertisedMedia(attachments)).toEqual(expected);
    });

    it("preserves an inline image fact when materialization limits reject it", () => {
      const attachments = [
        createHtmlAttachment(`<img src="data:image/png;base64,${"A".repeat(16)}" />`),
      ];

      expect(
        resolveMSTeamsAdvertisedMedia(attachments, {
          maxInlineBytes: 4,
          maxInlineTotalBytes: 4,
        }),
      ).toEqual([{ kind: "image" }]);
    });

    it("aligns Graph hosted-content image URLs with their fallback resource id", () => {
      const hostedUrl =
        "https://graph.microsoft.com/v1.0/chats/chat/messages/message/hostedContents/hosted%2D1/$value";
      expect(
        resolveMSTeamsAdvertisedMedia([createHtmlAttachment(`<img src="${hostedUrl}" />`)]),
      ).toEqual([{ kind: "image", sourceId: "hosted-1" }]);
    });

    it("counts advertised files without URLs and ignores mention-only HTML", () => {
      expect(
        resolveMSTeamsAdvertisedMedia([{ contentType: "application/pdf", name: "report.pdf" }]),
      ).toEqual([{ kind: "document" }]);
      expect(
        resolveMSTeamsAdvertisedMedia([
          { contentType: "text/html", content: "<div><at>Bot</at> hello</div>" },
        ]),
      ).toEqual([]);
    });

    it("does not count HTML references separately from files or cards", () => {
      expect(
        resolveMSTeamsAdvertisedMedia([
          createHtmlAttachment('<attachment id="file-1"></attachment>'),
          {
            id: "file-1",
            contentType: CONTENT_TYPE_APPLICATION_PDF,
            contentUrl: TEST_URL_PDF,
          },
        ]),
      ).toEqual([{ kind: "document", sourceId: "file-1" }]);

      expect(
        resolveMSTeamsAdvertisedMedia([
          createHtmlAttachment('<attachment id="card-1"></attachment>'),
          {
            id: "card-1",
            contentType: "application/vnd.microsoft.card.adaptive",
            content: { type: "AdaptiveCard" },
          },
        ]),
      ).toEqual([]);
    });

    it("does not count CID image references separately from their attachment", () => {
      expect(
        resolveMSTeamsAdvertisedMedia([
          createHtmlAttachment('<img src="cid:image-1" />'),
          {
            id: "image-1",
            contentType: "image/png",
            contentUrl: "https://x.test/image.png",
          },
        ]),
      ).toEqual([{ kind: "image", sourceId: "image-1" }]);
    });

    it("counts repeated inline URLs once while keeping data images per occurrence", () => {
      const repeatedUrl = "https://example.com/repeated.png";
      expect(
        resolveMSTeamsAdvertisedMedia([
          {
            contentType: "text/html",
            content: `<img src="${repeatedUrl}"><img src="${repeatedUrl}">`,
          },
        ]),
      ).toEqual([{ kind: "image", sourceId: repeatedUrl }]);

      const dataUrl = "data:image/png;base64,AQ==";
      expect(
        resolveMSTeamsAdvertisedMedia([
          {
            contentType: "text/html",
            content: `<img src="${dataUrl}"><img src="${dataUrl}">`,
          },
        ]),
      ).toEqual([{ kind: "image" }, { kind: "image" }]);
    });
  });

  describe("buildMSTeamsGraphMessageUrl", () => {
    it.each(GRAPH_MESSAGE_URL_CASES)("$label", ({ params, expectedUrl }) => {
      expect(buildMSTeamsGraphMessageUrl(params)).toBe(expectedUrl);
    });

    it("fails closed when a canonical channel identifier is missing", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          conversationType: "channel",
          messageId: "message-id",
          channelId: DEFAULT_CHANNEL_ID,
        }),
      ).toBeUndefined();
      expect(
        buildMSTeamsGraphMessageUrl({
          conversationType: "channel",
          teamAadGroupId: DEFAULT_CHANNEL_TEAM_ID,
          channelId: DEFAULT_CHANNEL_ID,
        }),
      ).toBeUndefined();
    });

    it("treats a matching thread root and message ID as a top-level message", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          ...createChannelGraphMessageUrlParams({
            messageId: "root-id",
            threadRootMessageId: "root-id",
          }),
        }),
      ).toBe(`${GRAPH_CHANNEL_MESSAGES_ROOT}/root-id`);
    });

    it("uses a resolved Graph chat ID for personal DMs", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          conversationType: "personal",
          conversationId: "19:real-graph-chat-id@unq.gbl.spaces",
          messageId: "msg-1",
        }),
      ).toBe(
        "https://graph.microsoft.com/v1.0/chats/19%3Areal-graph-chat-id%40unq.gbl.spaces/messages/msg-1",
      );
    });

    it("encodes every channel path identifier", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          conversationType: "channel",
          teamAadGroupId: "team/id",
          channelId: "channel id",
          messageId: "reply/id",
          threadRootMessageId: "root id",
        }),
      ).toBe(
        "https://graph.microsoft.com/v1.0/teams/team%2Fid/channels/channel%20id/messages/root%20id/replies/reply%2Fid",
      );
    });
  });

  it("retains the expected sharepoint host fixture", () => {
    expect(SHAREPOINT_HOST).toBe("contoso.sharepoint.com");
    expect(TEST_URL_IMAGE).toContain(TEST_HOST);
  });
});
