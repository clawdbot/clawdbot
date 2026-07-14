// Msteams tests cover attachments.helpers plugin behavior.
import { beforeEach, describe, expect, it } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
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
const TEST_URL_PDF = createTestUrl("x.pdf");
const CONTENT_TYPE_IMAGE_PNG = "image/png";
const CONTENT_TYPE_APPLICATION_PDF = "application/pdf";
const CONTENT_TYPE_TEXT_HTML = "text/html";
type GraphMessageUrlParams = Parameters<typeof buildMSTeamsGraphMessageUrl>[0];
type MSTeamsMediaPayload = ReturnType<typeof buildMSTeamsMediaPayload>;

const runtimeStub = {
  channel: {
    text: {
      chunkText: (text: string) => (text ? [text] : []),
    },
  },
} as unknown as PluginRuntime;
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

const ATTACHMENT_PRESENTATION_CASES = [
  withLabel("returns empty presentation without attachments", {
    attachments: undefined,
    expected: { placeholder: "", expectedMediaCount: 0 },
  }),
  withLabel("returns empty presentation for an empty attachment list", {
    attachments: [],
    expected: { placeholder: "", expectedMediaCount: 0 },
  }),
  withLabel("returns an image presentation for one image", {
    attachments: [{ contentType: "image/png", contentUrl: "https://x.test/image.png" }],
    expected: { placeholder: "<media:image>", expectedMediaCount: 1 },
  }),
  withLabel("counts multiple images", {
    attachments: [
      { contentType: "image/png", contentUrl: "https://x.test/one.png" },
      { contentType: "image/jpeg", contentUrl: "https://x.test/two.jpg" },
    ],
    expected: { placeholder: "<media:image> (2 images)", expectedMediaCount: 2 },
  }),
  withLabel("recognizes Teams download-info images", {
    attachments: [
      {
        contentType: "application/vnd.microsoft.teams.file.download.info",
        content: { downloadUrl: "https://x.test/download", fileType: "png" },
      },
    ],
    expected: { placeholder: "<media:image>", expectedMediaCount: 1 },
  }),
  withLabel("returns a document presentation for one document", {
    attachments: [{ contentType: "application/pdf", contentUrl: "https://x.test/file.pdf" }],
    expected: { placeholder: "<media:document>", expectedMediaCount: 1 },
  }),
  withLabel("counts multiple documents", {
    attachments: [
      { contentType: "application/pdf", contentUrl: "https://x.test/one.pdf" },
      { contentType: "application/pdf", contentUrl: "https://x.test/two.pdf" },
    ],
    expected: { placeholder: "<media:document> (2 files)", expectedMediaCount: 2 },
  }),
  withLabel("counts one inline image", {
    attachments: [createHtmlAttachment('<p>hi</p><img src="https://x.test/one.png" />')],
    expected: { placeholder: "<media:image>", expectedMediaCount: 1 },
  }),
  withLabel("counts multiple inline images", {
    attachments: [
      createHtmlAttachment(
        '<img src="https://x.test/one.png" /><img src="https://x.test/two.png" />',
      ),
    ],
    expected: { placeholder: "<media:image> (2 images)", expectedMediaCount: 2 },
  }),
];

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

  describe("resolveMSTeamsInboundAttachmentPresentation", () => {
    it.each(ATTACHMENT_PRESENTATION_CASES)("$label", ({ attachments, expected }) => {
      expect(resolveMSTeamsInboundAttachmentPresentation(attachments)).toEqual(expected);
    });

    it("respects inline image limits when choosing the placeholder", () => {
      const attachments = [
        createHtmlAttachment(`<img src="data:image/png;base64,${"A".repeat(16)}" />`),
      ];

      expect(
        resolveMSTeamsInboundAttachmentPresentation(attachments, {
          maxInlineBytes: 4,
          maxInlineTotalBytes: 4,
        }),
      ).toEqual({ placeholder: "<media:document>", expectedMediaCount: 1 });
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
