// Msteams tests cover attachments.helpers plugin behavior.
import { beforeEach, describe, expect, it } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsGraphMessageUrl,
  buildMSTeamsMediaPayload,
  resolveMSTeamsInboundAttachmentPresentation,
} from "./attachments.js";
import { setMSTeamsRuntime } from "./runtime.js";

const SHAREPOINT_HOST = "contoso.sharepoint.com";
const TEST_HOST = "x";
const createUrlForHost = (host: string, pathSegment: string) => `https://${host}/${pathSegment}`;
const createTestUrl = (pathSegment: string) => createUrlForHost(TEST_HOST, pathSegment);
const TEST_URL_IMAGE = createTestUrl("img");
const TEST_URL_IMAGE_PNG = createTestUrl("img.png");
const TEST_URL_IMAGE_1_PNG = createTestUrl("1.png");
const TEST_URL_IMAGE_2_JPG = createTestUrl("2.jpg");
const TEST_URL_PDF = createTestUrl("x.pdf");
const TEST_URL_PDF_1 = createTestUrl("1.pdf");
const TEST_URL_PDF_2 = createTestUrl("2.pdf");
const TEST_URL_HTML_A = createTestUrl("a.png");
const TEST_URL_HTML_B = createTestUrl("b.png");
const CONTENT_TYPE_IMAGE_PNG = "image/png";
const CONTENT_TYPE_APPLICATION_PDF = "application/pdf";
const CONTENT_TYPE_TEXT_HTML = "text/html";
const CONTENT_TYPE_TEAMS_FILE_DOWNLOAD_INFO = "application/vnd.microsoft.teams.file.download.info";
type AttachmentPlaceholderInput = Parameters<typeof buildMSTeamsAttachmentPlaceholder>[0];
type GraphMessageUrlParams = Parameters<typeof buildMSTeamsGraphMessageUrl>[0];
type MSTeamsMediaPayload = ReturnType<typeof buildMSTeamsMediaPayload>;

const runtimeStub = {
  channel: {
    text: {
      chunkText: (text: string) => (text ? [text] : []),
    },
  },
} as unknown as PluginRuntime;
const MEDIA_PLACEHOLDER_IMAGE = "<media:image>";
const MEDIA_PLACEHOLDER_DOCUMENT = "<media:document>";
const formatImagePlaceholder = (count: number) =>
  count > 1 ? `${MEDIA_PLACEHOLDER_IMAGE} (${count} images)` : MEDIA_PLACEHOLDER_IMAGE;
const formatDocumentPlaceholder = (count: number) =>
  count > 1 ? `${MEDIA_PLACEHOLDER_DOCUMENT} (${count} files)` : MEDIA_PLACEHOLDER_DOCUMENT;
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
const buildHtmlImageTag = (src: string) => `<img src="${src}" />`;
const createHtmlImageAttachments = (sources: string[], prefix = "") => [
  createHtmlAttachment(`${prefix}${sources.map(buildHtmlImageTag).join("")}`),
];
const createContentUrlAttachments = (contentType: string, ...contentUrls: string[]) =>
  contentUrls.map((contentUrl) => buildAttachment(contentType, { contentUrl }));
const createImageAttachments = (...contentUrls: string[]) =>
  createContentUrlAttachments(CONTENT_TYPE_IMAGE_PNG, ...contentUrls);
const createPdfAttachments = (...contentUrls: string[]) =>
  createContentUrlAttachments(CONTENT_TYPE_APPLICATION_PDF, ...contentUrls);
const createTeamsFileDownloadInfoAttachments = (
  downloadUrl = createTestUrl("dl"),
  fileType = "png",
) => [
  buildAttachment(CONTENT_TYPE_TEAMS_FILE_DOWNLOAD_INFO, {
    content: { downloadUrl, fileType },
  }),
];
const createMediaEntriesWithType = (contentType: string, ...paths: string[]) =>
  paths.map((path) => ({ path, contentType }));
const createImageMediaEntries = (...paths: string[]) =>
  createMediaEntriesWithType(CONTENT_TYPE_IMAGE_PNG, ...paths);
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

const expectMSTeamsMediaPayload = (
  payload: MSTeamsMediaPayload,
  expected: { firstPath: string; paths: string[]; types: string[] },
) => {
  expect(payload.MediaPath).toBe(expected.firstPath);
  expect(payload.MediaUrl).toBe(expected.firstPath);
  expect(payload.MediaPaths).toEqual(expected.paths);
  expect(payload.MediaUrls).toEqual(expected.paths);
  expect(payload.MediaTypes).toEqual(expected.types);
};

const ATTACHMENT_PLACEHOLDER_CASES = [
  withLabel("returns empty string when no attachments", {
    attachments: undefined as AttachmentPlaceholderInput,
    expected: "",
  }),
  withLabel("returns empty string when attachments are empty", {
    attachments: [],
    expected: "",
  }),
  withLabel("returns image placeholder for one image attachment", {
    attachments: createImageAttachments(TEST_URL_IMAGE_PNG),
    expected: formatImagePlaceholder(1),
  }),
  withLabel("returns image placeholder with count for many image attachments", {
    attachments: [
      ...createImageAttachments(TEST_URL_IMAGE_1_PNG),
      { contentType: "image/jpeg", contentUrl: TEST_URL_IMAGE_2_JPG },
    ],
    expected: formatImagePlaceholder(2),
  }),
  withLabel("treats Teams file.download.info image attachments as images", {
    attachments: createTeamsFileDownloadInfoAttachments(),
    expected: formatImagePlaceholder(1),
  }),
  withLabel("returns document placeholder for non-image attachments", {
    attachments: createPdfAttachments(TEST_URL_PDF),
    expected: formatDocumentPlaceholder(1),
  }),
  withLabel("returns document placeholder with count for many non-image attachments", {
    attachments: createPdfAttachments(TEST_URL_PDF_1, TEST_URL_PDF_2),
    expected: formatDocumentPlaceholder(2),
  }),
  withLabel("counts one inline image in html attachments", {
    attachments: createHtmlImageAttachments([TEST_URL_HTML_A], "<p>hi</p>"),
    expected: formatImagePlaceholder(1),
  }),
  withLabel("counts many inline images in html attachments", {
    attachments: createHtmlImageAttachments([TEST_URL_HTML_A, TEST_URL_HTML_B]),
    expected: formatImagePlaceholder(2),
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
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
  });

  describe("buildMSTeamsAttachmentPlaceholder", () => {
    it.each(ATTACHMENT_PLACEHOLDER_CASES)("$label", ({ attachments, expected }) => {
      expect(buildMSTeamsAttachmentPlaceholder(attachments)).toBe(expected);
    });

    it("respects inline image limits when counting placeholder images", () => {
      const attachments = [
        {
          contentType: "text/html",
          content: `<img src="data:image/png;base64,${"A".repeat(16)}" />`,
        },
      ];

      expect(
        buildMSTeamsAttachmentPlaceholder(attachments, {
          maxInlineBytes: 4,
          maxInlineTotalBytes: 4,
        }),
      ).toBe("<media:document>");
    });

    it("counts advertised files without URLs and ignores mention-only HTML", () => {
      expect(
        resolveMSTeamsInboundAttachmentPresentation([
          { contentType: "application/pdf", name: "report.pdf" },
        ]),
      ).toEqual({ placeholder: "<media:document>", expectedMediaCount: 1 });
      expect(
        resolveMSTeamsInboundAttachmentPresentation([
          { contentType: "text/html", content: "<div><at>Bot</at> hello</div>" },
        ]),
      ).toEqual({ placeholder: "", expectedMediaCount: 0 });
    });

    it("does not count HTML references separately from files or cards", () => {
      expect(
        resolveMSTeamsInboundAttachmentPresentation([
          createHtmlAttachment('<attachment id="file-1"></attachment>'),
          {
            id: "file-1",
            contentType: CONTENT_TYPE_APPLICATION_PDF,
            contentUrl: TEST_URL_PDF,
          },
        ]),
      ).toEqual({ placeholder: "<media:document>", expectedMediaCount: 1 });

      expect(
        resolveMSTeamsInboundAttachmentPresentation([
          createHtmlAttachment('<attachment id="card-1"></attachment>'),
          {
            id: "card-1",
            contentType: "application/vnd.microsoft.card.adaptive",
            content: { type: "AdaptiveCard" },
          },
        ]),
      ).toEqual({ placeholder: "", expectedMediaCount: 0 });
    });

    it("counts repeated inline URLs once while keeping data images per occurrence", () => {
      const repeatedUrl = "https://example.com/repeated.png";
      expect(
        resolveMSTeamsInboundAttachmentPresentation([
          {
            contentType: "text/html",
            content: `<img src="${repeatedUrl}"><img src="${repeatedUrl}">`,
          },
        ]),
      ).toEqual({ placeholder: "<media:image>", expectedMediaCount: 1 });

      const dataUrl = "data:image/png;base64,AQ==";
      expect(
        resolveMSTeamsInboundAttachmentPresentation([
          {
            contentType: "text/html",
            content: `<img src="${dataUrl}"><img src="${dataUrl}">`,
          },
        ]),
      ).toEqual({ placeholder: "<media:image> (2 images)", expectedMediaCount: 2 });
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

  describe("buildMSTeamsMediaPayload", () => {
    it("returns single and multi-file fields", () => {
      const payload = buildMSTeamsMediaPayload(createImageMediaEntries("/tmp/a.png", "/tmp/b.png"));
      expectMSTeamsMediaPayload(payload, {
        firstPath: "/tmp/a.png",
        paths: ["/tmp/a.png", "/tmp/b.png"],
        types: [CONTENT_TYPE_IMAGE_PNG, CONTENT_TYPE_IMAGE_PNG],
      });
    });
  });

  it("retains the expected sharepoint host fixture", () => {
    expect(SHAREPOINT_HOST).toBe("contoso.sharepoint.com");
    expect(TEST_URL_IMAGE).toContain(TEST_HOST);
  });
});
