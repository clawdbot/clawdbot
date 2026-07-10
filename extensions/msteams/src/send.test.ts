// Msteams tests cover send plugin behavior.
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
  sendMSTeamsActivityWithReference: vi.fn(async () => ({ id: "message-1" })),
  updateMSTeamsActivityWithReference: vi.fn(async () => ({ id: "updated" })),
  deleteMSTeamsActivityWithReference: vi.fn(async () => {}),
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
  buildTeamsFileInfoCard: vi.fn(),
  createMSTeamsTokenProvider: vi.fn(),
}));

// `loadOutboundMediaFromUrl` is re-exported from msteams's runtime-api which
// pulls from `openclaw/plugin-sdk/outbound-media` (post-migration). Mock the
// canonical source so the re-export carries our stub through.
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
  buildConversationReference: (ref: Record<string, unknown>) => ({
    serviceUrl: (ref as { serviceUrl?: string }).serviceUrl ?? "https://service.example.com",
    conversation: (ref as { conversation?: Record<string, unknown> }).conversation ?? {
      id: "19:conversation@thread.tacv2",
    },
    agent: (ref as { agent?: Record<string, unknown> }).agent,
    user: (ref as { user?: Record<string, unknown> }).user,
    tenantId: (ref as { tenantId?: string }).tenantId,
    aadObjectId: (ref as { aadObjectId?: string }).aadObjectId,
  }),
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

vi.mock("./sdk.js", () => ({
  createMSTeamsTokenProvider: mockState.createMSTeamsTokenProvider,
}));

vi.mock("./sdk-proactive.js", () => ({
  sendMSTeamsActivityWithReference: mockState.sendMSTeamsActivityWithReference,
  updateMSTeamsActivityWithReference: mockState.updateMSTeamsActivityWithReference,
  deleteMSTeamsActivityWithReference: mockState.deleteMSTeamsActivityWithReference,
}));

function createMockApp(overrides?: {
  send?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}) {
  const sendFn = overrides?.send ?? vi.fn(async () => ({ id: "message-1" }));
  const updateFn = overrides?.update ?? vi.fn(async () => ({ id: "updated" }));
  const deleteFn = overrides?.delete ?? vi.fn(async () => {});
  return {
    send: sendFn,
    api: {
      conversations: {
        activities: () => ({
          create: sendFn,
          update: updateFn,
          delete: deleteFn,
        }),
      },
    },
  };
}

function mockProactiveSendContextFailure(error: string) {
  mockState.sendMSTeamsActivityWithReference.mockRejectedValue(new Error(error));
  mockState.updateMSTeamsActivityWithReference.mockRejectedValue(new Error(error));
  mockState.deleteMSTeamsActivityWithReference.mockRejectedValue(new Error(error));
  const failingApp = createMockApp({
    send: vi.fn().mockRejectedValue(new Error(error)),
    update: vi.fn().mockRejectedValue(new Error(error)),
    delete: vi.fn().mockRejectedValue(new Error(error)),
  });
  mockState.resolveMSTeamsSendContext.mockResolvedValue({
    app: failingApp,
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
    sdkCloudOptions: { cloud: "Public" },
    tokenProvider: {},
  });
}

function createSharePointSendContext(params: { conversationId: string; siteId: string }) {
  return {
    app: createMockApp(),
    appId: "app-id",
    conversationId: params.conversationId,
    ref: {},
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    conversationType: "groupChat" as const,
    replyStyle: "top-level" as const,
    sdkCloudOptions: { cloud: "Public" as const },
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
    mockState.sendMSTeamsActivityWithReference.mockReset();
    mockState.updateMSTeamsActivityWithReference.mockReset();
    mockState.deleteMSTeamsActivityWithReference.mockReset();
    mockState.uploadAndShareSharePoint.mockReset();
    mockState.getDriveItemProperties.mockReset();
    mockState.buildTeamsFileInfoCard.mockReset();

    mockState.extractFilename.mockResolvedValue("fallback.bin");
    mockState.requiresFileConsent.mockReturnValue(false);
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      app: createMockApp(),
      appId: "app-id",
      conversationId: "19:conversation@thread.tacv2",
      ref: {},
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "personal",
      replyStyle: "top-level",
      sdkCloudOptions: { cloud: "Public" },
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      mediaMaxBytes: 8 * 1024,
      sharePointSiteId: undefined,
    });
    mockState.sendMSTeamsMessages.mockResolvedValue(["message-1"]);
    mockState.sendMSTeamsActivityWithReference.mockResolvedValue({ id: "message-1" });
    mockState.updateMSTeamsActivityWithReference.mockResolvedValue({ id: "updated" });
    mockState.deleteMSTeamsActivityWithReference.mockResolvedValue(undefined);
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
      sdkCloudOptions: { cloud: "Public" },
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
      sdkCloudOptions: { cloud: "Public" },
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

  it("uses the Graph-native group conversation ID for SharePoint sharing", async () => {
    const graphConversationId = "19:group-id@thread.v2";

    mockState.resolveMSTeamsSendContext.mockResolvedValue(
      createSharePointSendContext({
        conversationId: graphConversationId,
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
      to: `conversation:${graphConversationId}`,
      text: "report",
      mediaUrl: "https://example.com/report.pdf",
    });

    const uploadPayload = firstObjectArg(mockState.uploadAndShareSharePoint);
    expect(uploadPayload.chatId).toBe(graphConversationId);
    expect(uploadPayload.siteId).toBe("site-456");
  });

  it("fails clearly when a group file has no SharePoint site", async () => {
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      ...createSharePointSendContext({
        conversationId: "19:group-id@thread.v2",
        siteId: "unused",
      }),
      sharePointSiteId: undefined,
    });
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("pdf"),
      contentType: "application/pdf",
      fileName: "report.pdf",
      kind: "file",
    });

    await expect(
      sendMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "conversation:19:group-id@thread.v2",
        text: "report",
        mediaUrl: "https://example.com/report.pdf",
      }),
    ).rejects.toThrow("channels.msteams.sharePointSiteId is required");
    expect(mockState.uploadAndShareSharePoint).not.toHaveBeenCalled();
  });
});

describe("MSTeams continueConversation failure handling", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
  });
});

describe("editMessageMSTeams", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
    mockState.updateMSTeamsActivityWithReference.mockReset();
    mockState.updateMSTeamsActivityWithReference.mockResolvedValue({ id: "updated" });
  });

  it("updates with the resolved Teams conversation reference", async () => {
    const mockUpdateActivity = vi.fn(async () => ({ id: "updated" }));
    const mockApp = createMockApp({ update: mockUpdateActivity });
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      app: mockApp,
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
      sdkCloudOptions: { cloud: "Public" },
      tokenProvider: {},
    });

    const result = await editMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conversation@thread.tacv2",
      activityId: "activity-123",
      text: "Updated message text",
    });

    expect(result.conversationId).toBe("19:conversation@thread.tacv2");

    expect(mockState.updateMSTeamsActivityWithReference).toHaveBeenCalledWith(
      mockApp,
      expect.objectContaining({
        conversation: { id: "19:conversation@thread.tacv2", conversationType: "personal" },
        serviceUrl: "https://service.example.com",
      }),
      "activity-123",
      {
        type: "message",
        id: "activity-123",
        text: "Updated message text",
      },
      { serviceUrlBoundary: { cloud: "Public" } },
    );
  });

  it("throws a descriptive error when update fails", async () => {
    mockProactiveSendContextFailure("Service unavailable");

    await expect(
      editMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "conversation:19:conversation@thread.tacv2",
        activityId: "activity-123",
        text: "Updated text",
      }),
    ).rejects.toThrow("msteams edit failed");
  });
});

describe("deleteMessageMSTeams", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
    mockState.deleteMSTeamsActivityWithReference.mockReset();
    mockState.deleteMSTeamsActivityWithReference.mockResolvedValue(undefined);
  });

  it("deletes with the resolved Teams conversation reference", async () => {
    const mockDeleteActivity = vi.fn(async () => {});
    const mockApp = createMockApp({ delete: mockDeleteActivity });
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      app: mockApp,
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
      sdkCloudOptions: { cloud: "Public" },
      tokenProvider: {},
    });

    const result = await deleteMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conversation@thread.tacv2",
      activityId: "activity-456",
    });

    expect(result.conversationId).toBe("19:conversation@thread.tacv2");

    expect(mockState.deleteMSTeamsActivityWithReference).toHaveBeenCalledWith(
      mockApp,
      expect.objectContaining({
        conversation: { id: "19:conversation@thread.tacv2", conversationType: "groupChat" },
        serviceUrl: "https://service.example.com",
      }),
      "activity-456",
      { serviceUrlBoundary: { cloud: "Public" } },
    );
  });

  it("throws a descriptive error when delete fails", async () => {
    mockProactiveSendContextFailure("Not found");

    await expect(
      deleteMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "conversation:19:conversation@thread.tacv2",
        activityId: "activity-456",
      }),
    ).rejects.toThrow("msteams delete failed");
  });

  it("uses app from the resolved context for delete operations", async () => {
    const mockDeleteActivity = vi.fn(async () => {});
    const mockApp = createMockApp({ delete: mockDeleteActivity });
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      app: mockApp,
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
      sdkCloudOptions: { cloud: "Public" },
      tokenProvider: {},
    });

    await deleteMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conv@thread.tacv2",
      activityId: "activity-789",
    });

    expect(mockState.deleteMSTeamsActivityWithReference).toHaveBeenCalledWith(
      mockApp,
      expect.objectContaining({
        conversation: { id: "19:conv@thread.tacv2" },
        serviceUrl: "https://service.example.com",
      }),
      "activity-789",
      { serviceUrlBoundary: { cloud: "Public" } },
    );
  });
});
