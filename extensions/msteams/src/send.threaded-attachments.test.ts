import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client as TeamsApiClient } from "@microsoft/teams.api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { sendMessageMSTeams } from "./send.js";

const serviceUrl = "https://smba.trafficmanager.net/amer";
const conversationId = "19:channel@thread.tacv2";

const mockState = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  resolveMSTeamsSendContext: vi.fn(),
  requiresFileConsent: vi.fn(() => false),
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
  buildTeamsFileInfoCard: vi.fn(),
  sendMSTeamsMessages: vi.fn(async () => ["text-message-1"]),
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: vi.fn(() => "off"),
}));

vi.mock("openclaw/plugin-sdk/text-chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-chunking")>();
  return {
    ...actual,
    convertMarkdownTables: (text: string) => text,
  };
});

vi.mock("./send-context.js", () => ({
  resolveMSTeamsSendContext: mockState.resolveMSTeamsSendContext,
}));

vi.mock("./file-consent-helpers.js", () => ({
  requiresFileConsent: mockState.requiresFileConsent,
  prepareFileConsentActivityFs: vi.fn(),
}));

vi.mock("./graph-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-upload.js")>();
  return {
    ...actual,
    uploadAndShareSharePoint: mockState.uploadAndShareSharePoint,
    getDriveItemProperties: mockState.getDriveItemProperties,
  };
});

vi.mock("./graph-chat.js", () => ({
  buildTeamsFileInfoCard: mockState.buildTeamsFileInfoCard,
}));

vi.mock("./messenger.js", () => ({
  sendMSTeamsMessages: mockState.sendMSTeamsMessages,
  buildConversationReference: (ref: {
    serviceUrl?: string;
    activityId?: string;
    conversation?: Record<string, unknown>;
    agent?: Record<string, unknown>;
    user?: Record<string, unknown>;
  }) => ({
    serviceUrl: ref.serviceUrl,
    activityId: ref.activityId,
    conversation: ref.conversation,
    agent: ref.agent,
    user: ref.user,
    channelId: "msteams",
  }),
}));

type CapturedRequest = {
  path: string;
  body: Record<string, unknown>;
};

type TeamsSdkHttpTransport = {
  post: (destination: string, data?: unknown) => Promise<{ data: unknown }>;
};

async function withRealTeamsSdkHttp<T>(
  run: (params: { api: TeamsApiClient; requests: CapturedRequest[] }) => Promise<T>,
): Promise<T> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    request.once("end", () => {
      requests.push({
        path: request.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "sdk-http-message-1" }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = (server.address() as AddressInfo).port;
    const api = new TeamsApiClient(serviceUrl);
    // OpenClaw's minimal SDK ambient declaration omits the real client's public HTTP transport.
    const transport = (api as unknown as { http: TeamsSdkHttpTransport }).http;
    vi.spyOn(transport, "post").mockImplementation(async (destination, data) => {
      const destinationUrl = new URL(destination);
      const response = await fetch(
        `http://127.0.0.1:${port}${destinationUrl.pathname}${destinationUrl.search}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        },
      );
      return { data: await response.json() };
    });

    return await run({ api, requests });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function mockSharePointFileUpload(): void {
  mockState.loadOutboundMediaFromUrl.mockResolvedValue({
    buffer: Buffer.from("pdf-content"),
    contentType: "application/pdf",
    fileName: "report.pdf",
    kind: "file",
  });
  mockState.uploadAndShareSharePoint.mockResolvedValue({
    itemId: "item-1",
    webUrl: "https://sharepoint.example.com/report.pdf",
    shareUrl: "https://sharepoint.example.com/shared/report.pdf",
    name: "report.pdf",
  });
  mockState.getDriveItemProperties.mockResolvedValue({
    eTag: '"file-guid,1"',
    webDavUrl: "https://sharepoint.example.com/dav/report.pdf",
    name: "report.pdf",
  });
  mockState.buildTeamsFileInfoCard.mockReturnValue({
    contentType: "application/vnd.microsoft.teams.card.file.info",
    contentUrl: "https://sharepoint.example.com/dav/report.pdf",
    name: "report.pdf",
    content: { uniqueId: "file-guid", fileType: "pdf" },
  });
}

type AttachmentRoutingCase = {
  label: string;
  conversationType: "channel" | "groupChat";
  replyStyle: "thread" | "top-level";
  threadId?: string;
  activityId?: string;
  expectedConversationId: string;
};

const attachmentRoutingCases: AttachmentRoutingCase[] = [
  {
    label: "channel attachment in its stored thread root",
    conversationType: "channel",
    replyStyle: "thread",
    threadId: "thread-root-1",
    activityId: "incoming-activity-1",
    expectedConversationId: `${conversationId};messageid=thread-root-1`,
  },
  {
    label: "channel attachment using the stored activity root",
    conversationType: "channel",
    replyStyle: "thread",
    activityId: "incoming-activity-1",
    expectedConversationId: `${conversationId};messageid=incoming-activity-1`,
  },
  {
    label: "explicit top-level channel attachment",
    conversationType: "channel",
    replyStyle: "top-level",
    threadId: "thread-root-1",
    expectedConversationId: conversationId,
  },
  {
    label: "group chat attachment without channel threading",
    conversationType: "groupChat",
    replyStyle: "thread",
    threadId: "thread-root-1",
    expectedConversationId: conversationId,
  },
];

describe("Microsoft Teams SharePoint attachment thread routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.requiresFileConsent.mockReturnValue(false);
    mockState.sendMSTeamsMessages.mockResolvedValue(["text-message-1"]);
    mockSharePointFileUpload();
  });

  it.each(attachmentRoutingCases)(
    "sends $label through the real Teams SDK and Bot Framework HTTP endpoint",
    async ({ conversationType, replyStyle, threadId, activityId, expectedConversationId }) => {
      await withRealTeamsSdkHttp(async ({ api, requests }) => {
        mockState.resolveMSTeamsSendContext.mockResolvedValue({
          app: { api },
          appId: "app-id",
          conversationId,
          ref: {
            serviceUrl,
            agent: { id: "28:bot", name: "OpenClaw", role: "bot" },
            user: { id: "29:user" },
            conversation: { id: conversationId, conversationType },
            ...(threadId ? { threadId } : {}),
            ...(activityId ? { activityId } : {}),
          },
          conversationType,
          replyStyle,
          sdkCloudOptions: { cloud: "Public" },
          tokenProvider: { getAccessToken: vi.fn(async () => "token") },
          sharePointSiteId: "sharepoint-site-1",
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });

        const result = await sendMessageMSTeams({
          cfg: {} as OpenClawConfig,
          to: conversationId,
          text: "Here is the report",
          mediaUrl: "https://media.example.com/report.pdf",
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          path: `${new URL(serviceUrl).pathname}/v3/conversations/${expectedConversationId}/activities`,
          body: {
            type: "message",
            text: "Here is the report",
            conversation: { id: expectedConversationId, conversationType },
            attachments: [
              {
                contentType: "application/vnd.microsoft.teams.card.file.info",
                name: "report.pdf",
              },
            ],
          },
        });
        expect(result).toMatchObject({
          messageId: "sdk-http-message-1",
          conversationId,
        });
      });
    },
  );

  it("keeps personal image delivery on the existing non-SharePoint path", async () => {
    await withRealTeamsSdkHttp(async ({ api, requests }) => {
      mockState.loadOutboundMediaFromUrl.mockResolvedValue({
        buffer: Buffer.from("image-content"),
        contentType: "image/png",
        fileName: "image.png",
        kind: "image",
      });
      mockState.resolveMSTeamsSendContext.mockResolvedValue({
        app: { api },
        appId: "app-id",
        conversationId,
        ref: {
          serviceUrl,
          agent: { id: "28:bot", name: "OpenClaw", role: "bot" },
          user: { id: "29:user" },
          conversation: { id: conversationId, conversationType: "personal" },
        },
        conversationType: "personal",
        replyStyle: "thread",
        sdkCloudOptions: { cloud: "Public" },
        tokenProvider: { getAccessToken: vi.fn(async () => "token") },
        sharePointSiteId: "sharepoint-site-1",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const result = await sendMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: conversationId,
        text: "Here is the image",
        mediaUrl: "https://media.example.com/image.png",
      });

      expect(mockState.sendMSTeamsMessages).toHaveBeenCalledOnce();
      expect(mockState.uploadAndShareSharePoint).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      expect(result.messageId).toBe("text-message-1");
    });
  });
});
