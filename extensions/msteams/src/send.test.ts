import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { deleteMessageMSTeams, editMessageMSTeams, sendMessageMSTeams } from "./send.js";

const mockState = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  resolveMSTeamsSendContext: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "off"),
  convertMarkdownTables: vi.fn((text: string) => text),
  runtimeResolveMarkdownTableMode: vi.fn(() => "off"),
  runtimeConvertMarkdownTables: vi.fn((text: string) => text),
  requiresFileConsent: vi.fn(),
  prepareFileConsentActivity: vi.fn(),
  prepareFileConsentActivityFs: vi.fn(),
  extractFilename: vi.fn(async () => "fallback.bin"),
  sendMSTeamsMessages: vi.fn(),
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
  buildTeamsFileInfoCard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: mockState.resolveMarkdownTableMode,
}));

vi.mock("openclaw/plugin-sdk/text-chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-chunking")>();
  return {
    ...actual,
    convertMarkdownTables: mockState.convertMarkdownTables,
  };
});

vi.mock("./send-context.js", () => ({
  resolveMSTeamsSendContext: mockState.resolveMSTeamsSendContext,
}));

vi.mock("./file-consent-helpers.js", () => ({
  requiresFileConsent: mockState.requiresFileConsent,
  prepareFileConsentActivity: mockState.prepareFileConsentActivity,
  prepareFileConsentActivityFs: mockState.prepareFileConsentActivityFs,
}));

vi.mock("./media-helpers.js", () => ({
  extractFilename: mockState.extractFilename,
  extractMessageId: () => "message-1",
}));

vi.mock("./messenger.js", () => ({
  sendMSTeamsMessages: mockState.sendMSTeamsMessages,
  buildConversationReference: () => ({}),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: mockState.runtimeResolveMarkdownTableMode,
        convertMarkdownTables: mockState.runtimeConvertMarkdownTables,
      },
    },
  }),
}));

vi.mock("./graph-upload.js", () => ({
  uploadAndShareSharePoint: mockState.uploadAndShareSharePoint,
  getDriveItemProperties: mockState.getDriveItemProperties,
  uploadAndShareOneDrive: vi.fn(),
}));

vi.mock("./graph-chat.js", () => ({
  buildTeamsFileInfoCard: mockState.buildTeamsFileInfoCard,
}));

function mockContinueConversationFailure(error: string) {
  const mockContinueConversation = vi.fn().mockRejectedValue(new Error(error));
  mockState.resolveMSTeamsSendContext.mockResolvedValue({
    adapter: { continueConversation: mockContinueConversation },
    appId: "app-id",
    conversationId: "19:conversation@thread.tacv2",
    ref: {
      user: { id: "user-1" },
      agent: { id: "agent-1" },
      conversation: { id: "19:conversation@thread.tacv2" },
      channelId: "msteams",
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    conversationType: "personal",
    tokenProvider: {},
  });
  return mockContinueConversation;
}

const continueConversationFailureCases = [
  {
    name: "editMessageMSTeams",
    error: "Service unavailable",
    expected: "msteams edit failed",
    invoke: () =>
      editMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "conversation:19:conversation@thread.tacv2",
        activityId: "activity-123",
        text: "Updated text",
      }),
  },
  {
    name: "deleteMessageMSTeams",
    error: "Not found",
    expected: "msteams delete failed",
    invoke: () =>
      deleteMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "conversation:19:conversation@thread.tacv2",
        activityId: "activity-456",
      }),
  },
];

function createSharePointSendContext(params: {
  conversationId: string;
  graphChatId: string | null;
  siteId: string;
}) {
  return {
    adapter: {
      continueConversation: vi.fn(
        async (
          _id: string,
          _ref: unknown,
          fn: (ctx: { sendActivity: () => { id: "msg-1" } }) => Promise<void>,
        ) => fn({ sendActivity: () => ({ id: "msg-1" }) }),
      ),
    },
    appId: "app-id",
    conversationId: params.conversationId,
    graphChatId: params.graphChatId,
    ref: {},
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    conversationType: "groupChat" as const,
    replyStyle: "top-level" as const,
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
    mediaMaxBytes: 8 * 1024 * 1024,
    sharePointSiteId: params.siteId,
  };
}

function mockSharePointPdfUpload(params: {
  bufferSize: number;
  fileName: string;
  itemId: string;
  uniqueId: string;
}) {
  mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
    buffer: Buffer.alloc(params.bufferSize, "pdf"),
    contentType: "application/pdf",
    fileName: params.fileName,
    kind: "file",
  });
  mockState.requiresFileConsent.mockReturnValue(false);
  mockState.uploadAndShareSharePoint.mockResolvedValue({
    itemId: params.itemId,
    webUrl: `https://sp.example.com/${params.fileName}`,
    shareUrl: `https://sp.example.com/share/${params.fileName}`,
    name: params.fileName,
  });
  mockState.getDriveItemProperties.mockResolvedValue({
    eTag: `"${params.uniqueId},1"`,
    webDavUrl: `https://sp.example.com/dav/${params.fileName}`,
    name: params.fileName,
  });
  mockState.buildTeamsFileInfoCard.mockReturnValue({
    contentType: "application/vnd.microsoft.teams.card.file.info",
    contentUrl: `https://sp.example.com/dav/${params.fileName}`,
    name: params.fileName,
    content: { uniqueId: params.uniqueId, fileType: "pdf" },
  });
}

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function firstObjectArg(mock: MockWithCalls): Record<string, unknown> {
  const value = mock.mock.calls[0]?.[0];
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected first mock call to receive an object argument");
  }
  return value as Record<string, unknown>;
}

function continueConversationRef(mock: MockWithCalls): Record<string, unknown> {
  const ref = mock.mock.calls[0]?.[1];
  if (ref === undefined || ref === null || typeof ref !== "object" || Array.isArray(ref)) {
    throw new Error("expected continueConversation ref object");
  }
  return ref as Record<string, unknown>;
}

describe("sendMessageMSTeams", () => {
  beforeEach(() => {
    mockState.loadOutboundMediaFromUrl.mockReset();
    mockState.resolveMSTeamsSendContext.mockReset();
    mockState.resolveMarkdownTableMode.mockReset();
    mockState.resolveMarkdownTableMode.mockReturnValue("off");
    mockState.convertMarkdownTables.mockReset();
    mockState.convertMarkdownTables.mockImplementation((text: string) => text);
    mockState.runtimeResolveMarkdownTableMode.mockReset();
    mockState.runtimeResolveMarkdownTableMode.mockReturnValue("off");
    mockState.runtimeConvertMarkdownTables.mockReset();
    mockState.runtimeConvertMarkdownTables.mockImplementation((text: string) => text);
    mockState.requiresFileConsent.mockReset();
    mockState.prepareFileConsentActivity.mockReset();
    mockState.prepareFileConsentActivityFs.mockReset();
    mockState.extractFilename.mockReset();
    mockState.sendMSTeamsMessages.mockReset();
    mockState.uploadAndShareSharePoint.mockReset();
    mockState.getDriveItemProperties.mockReset();
    mockState.buildTeamsFileInfoCard.mockReset();

    mockState.extractFilename.mockResolvedValue("fallback.bin");
    mockState.requiresFileConsent.mockReturnValue(false);
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: {},
      appId: "app-id",
      conversationId: "19:conversation@thread.tacv2",
      ref: {},
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "personal",
      replyStyle: "top-level",
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      mediaMaxBytes: 8 * 1024,
      sharePointSiteId: undefined,
    });
    mockState.sendMSTeamsMessages.mockResolvedValue(["message-1"]);
  });

  it("loads media through shared helper and forwards mediaLocalRoots", async () => {
    const mediaBuffer = Buffer.from("tiny-image");
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: mediaBuffer,
      contentType: "image/png",
      fileName: "inline.png",
      kind: "image",
    });

    const result = await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conversation@thread.tacv2",
      text: "hello",
      mediaUrl: "file:///tmp/agent-workspace/inline.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "file:///tmp/agent-workspace/inline.png",
      {
        maxBytes: 8 * 1024,
        mediaLocalRoots: ["/tmp/agent-workspace"],
      },
    );

    const sendPayload = firstObjectArg(mockState.sendMSTeamsMessages);
    const messages = sendPayload.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("hello");
    expect(messages[0]?.mediaUrl).toBe(`data:image/png;base64,${mediaBuffer.toString("base64")}`);
    expect(result.receipt?.primaryPlatformMessageId).toBe("message-1");
    expect(result.receipt?.platformMessageIds).toEqual(["message-1"]);
    expect(result.receipt?.parts).toHaveLength(1);
    expect(result.receipt?.parts[0]?.platformMessageId).toBe("message-1");
    expect(result.receipt?.parts[0]?.kind).toBe("media");
  });

  it("sends with provided cfg even when Teams runtime text helpers are unavailable", async () => {
    mockState.runtimeResolveMarkdownTableMode.mockImplementation(() => {
      throw new Error("MSTeams runtime not initialized");
    });
    mockState.runtimeConvertMarkdownTables.mockImplementation(() => {
      throw new Error("MSTeams runtime not initialized");
    });
    mockState.resolveMarkdownTableMode.mockReturnValue("off");
    mockState.convertMarkdownTables.mockReturnValue("hello");

    const result = await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conversation@thread.tacv2",
      text: "hello",
    });

    expect(result.messageId).toBe("message-1");
    expect(result.conversationId).toBe("19:conversation@thread.tacv2");
    expect(result.receipt?.primaryPlatformMessageId).toBe("message-1");
    expect(result.receipt?.platformMessageIds).toEqual(["message-1"]);
    expect(result.receipt?.parts).toHaveLength(1);
    expect(result.receipt?.parts[0]?.platformMessageId).toBe("message-1");
    expect(result.receipt?.parts[0]?.kind).toBe("text");

    expect(mockState.resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg: {},
      channel: "msteams",
    });
    expect(mockState.convertMarkdownTables).toHaveBeenCalledWith("hello", "off");
  });

  it("passes the resolved proactive replyStyle to text sends", async () => {
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: {},
      appId: "app-id",
      conversationId: "19:channel@thread.tacv2",
      ref: {
        threadId: "thread-root-1",
        conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "channel",
      replyStyle: "thread",
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      mediaMaxBytes: 8 * 1024,
      sharePointSiteId: undefined,
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:channel@thread.tacv2",
      text: "threaded reply",
    });

    expect(firstObjectArg(mockState.sendMSTeamsMessages).replyStyle).toBe("thread");
  });

  it("keeps top-level proactive replyStyle when resolved for a channel", async () => {
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: {},
      appId: "app-id",
      conversationId: "19:channel@thread.tacv2",
      ref: {
        threadId: "thread-root-1",
        conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "channel",
      replyStyle: "top-level",
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      mediaMaxBytes: 8 * 1024,
      sharePointSiteId: undefined,
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:channel@thread.tacv2",
      text: "top-level reply",
    });

    expect(firstObjectArg(mockState.sendMSTeamsMessages).replyStyle).toBe("top-level");
  });

  it("uses graphChatId instead of conversationId when uploading to SharePoint", async () => {
    // Simulates a group chat where Bot Framework conversationId is valid but we have
    // a resolved Graph chat ID cached from a prior send.
    const graphChatId = "19:graph-native-chat-id@thread.tacv2";
    const botFrameworkConversationId = "19:bot-framework-id@thread.tacv2";

    mockState.resolveMSTeamsSendContext.mockResolvedValue(
      createSharePointSendContext({
        conversationId: botFrameworkConversationId,
        graphChatId,
        siteId: "site-123",
      }),
    );
    mockSharePointPdfUpload({
      bufferSize: 100,
      fileName: "doc.pdf",
      itemId: "item-1",
      uniqueId: "{GUID-123}",
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:bot-framework-id@thread.tacv2",
      text: "here is a file",
      mediaUrl: "https://example.com/doc.pdf",
    });

    // The Graph-native chatId must be passed to SharePoint upload, not the Bot Framework ID
    const uploadPayload = firstObjectArg(mockState.uploadAndShareSharePoint);
    expect(uploadPayload.chatId).toBe(graphChatId);
    expect(uploadPayload.siteId).toBe("site-123");
  });

  it("falls back to conversationId when graphChatId is not available", async () => {
    const botFrameworkConversationId = "19:fallback-id@thread.tacv2";

    mockState.resolveMSTeamsSendContext.mockResolvedValue(
      createSharePointSendContext({
        conversationId: botFrameworkConversationId,
        graphChatId: null,
        siteId: "site-456",
      }),
    );
    mockSharePointPdfUpload({
      bufferSize: 50,
      fileName: "report.pdf",
      itemId: "item-2",
      uniqueId: "{GUID-456}",
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:fallback-id@thread.tacv2",
      text: "report",
      mediaUrl: "https://example.com/report.pdf",
    });

    // Falls back to conversationId when graphChatId is null
    const uploadPayload = firstObjectArg(mockState.uploadAndShareSharePoint);
    expect(uploadPayload.chatId).toBe(botFrameworkConversationId);
    expect(uploadPayload.siteId).toBe("site-456");
  });
});

describe("MSTeams continueConversation failure handling", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
  });

  it.each(continueConversationFailureCases)(
    "$name throws a descriptive error when continueConversation fails",
    async ({ error, expected, invoke }) => {
      mockContinueConversationFailure(error);

      await expect(invoke()).rejects.toThrow(expected);
    },
  );
});

describe("editMessageMSTeams", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
  });

  it("calls continueConversation and updateActivity with correct params", async () => {
    const mockUpdateActivity = vi.fn();
    const mockContinueConversation = vi.fn(
      async (_appId: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => {
        await logic({
          sendActivity: vi.fn(),
          updateActivity: mockUpdateActivity,
          deleteActivity: vi.fn(),
        });
      },
    );
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: { continueConversation: mockContinueConversation },
      appId: "app-id",
      conversationId: "19:conversation@thread.tacv2",
      ref: {
        user: { id: "user-1" },
        agent: { id: "agent-1" },
        conversation: { id: "19:conversation@thread.tacv2", conversationType: "personal" },
        channelId: "msteams",
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "personal",
      tokenProvider: {},
    });

    const result = await editMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conversation@thread.tacv2",
      activityId: "activity-123",
      text: "Updated message text",
    });

    expect(result.conversationId).toBe("19:conversation@thread.tacv2");
    expect(mockContinueConversation).toHaveBeenCalledTimes(1);
    const continueConversationCall = mockContinueConversation.mock.calls[0];
    expect(continueConversationCall?.[0]).toBe("app-id");
    expect(continueConversationRef(mockContinueConversation).activityId).toBeUndefined();
    expect(typeof continueConversationCall?.[2]).toBe("function");
    expect(mockUpdateActivity).toHaveBeenCalledWith({
      type: "message",
      id: "activity-123",
      text: "Updated message text",
    });
  });
});

describe("deleteMessageMSTeams", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
  });

  it("calls continueConversation and deleteActivity with correct activityId", async () => {
    const mockDeleteActivity = vi.fn();
    const mockContinueConversation = vi.fn(
      async (_appId: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => {
        await logic({
          sendActivity: vi.fn(),
          updateActivity: vi.fn(),
          deleteActivity: mockDeleteActivity,
        });
      },
    );
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: { continueConversation: mockContinueConversation },
      appId: "app-id",
      conversationId: "19:conversation@thread.tacv2",
      ref: {
        user: { id: "user-1" },
        agent: { id: "agent-1" },
        conversation: { id: "19:conversation@thread.tacv2", conversationType: "groupChat" },
        channelId: "msteams",
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "groupChat",
      tokenProvider: {},
    });

    const result = await deleteMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conversation@thread.tacv2",
      activityId: "activity-456",
    });

    expect(result.conversationId).toBe("19:conversation@thread.tacv2");
    expect(mockContinueConversation).toHaveBeenCalledTimes(1);
    const continueConversationCall = mockContinueConversation.mock.calls[0];
    expect(continueConversationCall?.[0]).toBe("app-id");
    expect(continueConversationRef(mockContinueConversation).activityId).toBeUndefined();
    expect(typeof continueConversationCall?.[2]).toBe("function");
    expect(mockDeleteActivity).toHaveBeenCalledWith("activity-456");
  });

  it("passes the appId and proactive ref to continueConversation", async () => {
    const mockContinueConversation = vi.fn(
      async (_appId: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => {
        await logic({
          sendActivity: vi.fn(),
          updateActivity: vi.fn(),
          deleteActivity: vi.fn(),
        });
      },
    );
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: { continueConversation: mockContinueConversation },
      appId: "my-app-id",
      conversationId: "19:conv@thread.tacv2",
      ref: {
        activityId: "original-activity",
        user: { id: "user-1" },
        agent: { id: "agent-1" },
        conversation: { id: "19:conv@thread.tacv2" },
        channelId: "msteams",
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "personal",
      tokenProvider: {},
    });

    await deleteMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conv@thread.tacv2",
      activityId: "activity-789",
    });

    // appId should be forwarded correctly
    expect(mockContinueConversation.mock.calls[0]?.[0]).toBe("my-app-id");
    // activityId on the proactive ref should be cleared (undefined) — proactive pattern
    expect(continueConversationRef(mockContinueConversation).activityId).toBeUndefined();
  });
});
