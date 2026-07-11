// Msteams tests cover channel.actions plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "./channel.js";

const {
  addParticipantMSTeamsMock,
  editMessageMSTeamsMock,
  deleteMessageMSTeamsMock,
  getChannelInfoMSTeamsMock,
  getMemberInfoMSTeamsMock,
  getMessageMSTeamsMock,
  listChannelsMSTeamsMock,
  listReactionsMSTeamsMock,
  pinMessageMSTeamsMock,
  reactMessageMSTeamsMock,
  removeParticipantMSTeamsMock,
  renameGroupMSTeamsMock,
  searchMessagesMSTeamsMock,
  sendAdaptiveCardMSTeamsMock,
  sendMessageMSTeamsMock,
  unpinMessageMSTeamsMock,
} = vi.hoisted(() => ({
  addParticipantMSTeamsMock: vi.fn(),
  editMessageMSTeamsMock: vi.fn(),
  deleteMessageMSTeamsMock: vi.fn(),
  getChannelInfoMSTeamsMock: vi.fn(),
  getMemberInfoMSTeamsMock: vi.fn(),
  getMessageMSTeamsMock: vi.fn(),
  listChannelsMSTeamsMock: vi.fn(),
  listReactionsMSTeamsMock: vi.fn(),
  pinMessageMSTeamsMock: vi.fn(),
  reactMessageMSTeamsMock: vi.fn(),
  removeParticipantMSTeamsMock: vi.fn(),
  renameGroupMSTeamsMock: vi.fn(),
  searchMessagesMSTeamsMock: vi.fn(),
  sendAdaptiveCardMSTeamsMock: vi.fn(),
  sendMessageMSTeamsMock: vi.fn(),
  unpinMessageMSTeamsMock: vi.fn(),
}));
vi.mock("./channel.runtime.js", () => ({
  msTeamsChannelRuntime: {
    addParticipantMSTeams: addParticipantMSTeamsMock,
    editMessageMSTeams: editMessageMSTeamsMock,
    deleteMessageMSTeams: deleteMessageMSTeamsMock,
    getChannelInfoMSTeams: getChannelInfoMSTeamsMock,
    getMemberInfoMSTeams: getMemberInfoMSTeamsMock,
    getMessageMSTeams: getMessageMSTeamsMock,
    listChannelsMSTeams: listChannelsMSTeamsMock,
    listReactionsMSTeams: listReactionsMSTeamsMock,
    pinMessageMSTeams: pinMessageMSTeamsMock,
    reactMessageMSTeams: reactMessageMSTeamsMock,
    removeParticipantMSTeams: removeParticipantMSTeamsMock,
    renameGroupMSTeams: renameGroupMSTeamsMock,
    searchMessagesMSTeams: searchMessagesMSTeamsMock,
    sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsMock,
    sendMessageMSTeams: sendMessageMSTeamsMock,
    unpinMessageMSTeams: unpinMessageMSTeamsMock,
  },
}));

const actionMocks = [
  addParticipantMSTeamsMock,
  editMessageMSTeamsMock,
  deleteMessageMSTeamsMock,
  getChannelInfoMSTeamsMock,
  getMemberInfoMSTeamsMock,
  getMessageMSTeamsMock,
  listChannelsMSTeamsMock,
  listReactionsMSTeamsMock,
  pinMessageMSTeamsMock,
  reactMessageMSTeamsMock,
  removeParticipantMSTeamsMock,
  renameGroupMSTeamsMock,
  searchMessagesMSTeamsMock,
  sendAdaptiveCardMSTeamsMock,
  sendMessageMSTeamsMock,
  unpinMessageMSTeamsMock,
];
const currentChannelId = "conversation:19:ctx@thread.tacv2";
const graphTeamId = "11111111-1111-1111-1111-111111111111";
const graphChannelId = "19:channel-1@thread.tacv2";
const graphChannelTarget = `${graphTeamId}/${graphChannelId}`;
const reactChannelId = "conversation:19:react@thread.tacv2";
const targetChannelId = "conversation:19:target@thread.tacv2";
const editedConversationId = "19:edited@thread.tacv2";
const editedMessageId = "msg-edit-1";
const readMessage = { id: "msg-1", text: "hello" };
const reactionType = "like";
const updatedText = "updated text";
const reactionTypes = ["like", "heart", "laugh", "surprised", "sad", "angry"];
const deleteMissingTargetError = "Delete requires a target (to) and messageId.";
const reactionsMissingTargetError = "Reactions requires a target (to) and messageId.";
const presentationSendMissingTargetError = "Card send requires a target (to).";
const reactMissingEmojiError =
  "React requires an emoji (reaction type). Valid types: like, heart, laugh, surprised, sad, angry.";
const reactMissingEmojiDetail = "React requires an emoji (reaction type).";
const searchMissingQueryError = "Search requires a target (to) and query.";
const groupManagementAuthError =
  "Microsoft Teams group management requires an owner or operator.admin requester.";

function padded(value: string) {
  return ` ${value} `;
}

function msteamsActionDetails(action: string, details?: Record<string, unknown>) {
  return {
    channel: "msteams",
    action,
    ...details,
  };
}

function okMSTeamsActionDetails(action: string, details?: Record<string, unknown>) {
  return msteamsActionDetails(action, { ok: true, ...details });
}

function requireMSTeamsHandleAction() {
  const handleAction = msteamsPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("msteams actions.handleAction unavailable");
  }
  return handleAction;
}

async function runAction(params: {
  action: string;
  cfg?: Record<string, unknown>;
  accountId?: string;
  requesterAccountId?: string;
  params?: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}) {
  const handleAction = requireMSTeamsHandleAction();
  return await handleAction({
    channel: "msteams",
    action: params.action,
    cfg: params.cfg ?? {},
    accountId: params.accountId,
    requesterAccountId: params.requesterAccountId,
    params: params.params ?? {},
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
    toolContext: params.toolContext,
    requesterSenderId: params.requesterSenderId,
    senderIsOwner: params.senderIsOwner,
    gatewayClientScopes: params.gatewayClientScopes,
  } as Parameters<ReturnType<typeof requireMSTeamsHandleAction>>[0]);
}

async function expectActionError(
  params: Parameters<typeof runAction>[0],
  expectedMessage: string,
  expectedDetails?: Record<string, unknown>,
) {
  await expect(runAction(params)).resolves.toEqual({
    isError: true,
    content: [{ type: "text", text: expectedMessage }],
    details: expectedDetails ?? { error: expectedMessage },
  });
}

async function expectActionParamError(
  action: Parameters<typeof runAction>[0]["action"],
  params: Record<string, unknown>,
  expectedMessage: string,
  expectedDetails?: Record<string, unknown>,
) {
  await expectActionError({ action, params }, expectedMessage, expectedDetails);
}

function expectActionSuccess(
  result: Awaited<ReturnType<typeof runAction>>,
  details: Record<string, unknown>,
  contentDetails: Record<string, unknown> = details,
) {
  expect(result).toEqual({
    content: [
      {
        type: "text",
        text: JSON.stringify(contentDetails),
      },
    ],
    details,
  });
}

function expectActionRuntimeCall(
  mockFn: ReturnType<typeof vi.fn>,
  params: Record<string, unknown>,
  cfg: Record<string, unknown> = {},
) {
  expect(mockFn).toHaveBeenCalledWith({
    cfg,
    ...params,
  });
}

async function expectSuccessfulAction(params: {
  mockFn: ReturnType<typeof vi.fn>;
  mockResult: unknown;
  action: Parameters<typeof runAction>[0]["action"];
  cfg?: Parameters<typeof runAction>[0]["cfg"];
  accountId?: Parameters<typeof runAction>[0]["accountId"];
  requesterAccountId?: Parameters<typeof runAction>[0]["requesterAccountId"];
  actionParams?: Parameters<typeof runAction>[0]["params"];
  toolContext?: Parameters<typeof runAction>[0]["toolContext"];
  mediaLocalRoots?: Parameters<typeof runAction>[0]["mediaLocalRoots"];
  mediaReadFile?: Parameters<typeof runAction>[0]["mediaReadFile"];
  requesterSenderId?: Parameters<typeof runAction>[0]["requesterSenderId"];
  senderIsOwner?: Parameters<typeof runAction>[0]["senderIsOwner"];
  gatewayClientScopes?: Parameters<typeof runAction>[0]["gatewayClientScopes"];
  runtimeParams: Record<string, unknown>;
  details: Record<string, unknown>;
  contentDetails?: Record<string, unknown>;
}) {
  params.mockFn.mockResolvedValue(params.mockResult);
  const result = await runAction({
    action: params.action,
    cfg: params.cfg,
    accountId: params.accountId,
    requesterAccountId: params.requesterAccountId,
    params: params.actionParams,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
    toolContext: params.toolContext,
    requesterSenderId: params.requesterSenderId,
    senderIsOwner: params.senderIsOwner,
    gatewayClientScopes: params.gatewayClientScopes,
  });
  expectActionRuntimeCall(params.mockFn, params.runtimeParams, params.cfg);
  expectActionSuccess(result, params.details, params.contentDetails);
}

describe("msteamsPlugin message actions", () => {
  const unrestrictedReadCfg = {
    channels: {
      msteams: {
        groupPolicy: "open",
        dmPolicy: "open",
      },
    },
  };
  beforeEach(() => {
    for (const mockFn of actionMocks) {
      mockFn.mockReset();
    }
  });

  it("falls back to toolContext.currentChannelId for read actions", async () => {
    await expectSuccessfulAction({
      mockFn: getMessageMSTeamsMock,
      mockResult: readMessage,
      action: "read",
      actionParams: {
        messageId: padded("msg-1"),
      },
      toolContext: {
        currentChannelId: padded(currentChannelId),
        currentChannelProvider: "msteams",
      },
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            dmPolicy: "pairing",
          },
        },
      },
      accountId: "default",
      requesterAccountId: "default",
      runtimeParams: {
        to: currentChannelId,
        messageId: "msg-1",
      },
      details: okMSTeamsActionDetails("read", {
        message: readMessage,
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "read",
        message: readMessage,
      },
    });
  });

  it("allows the trusted current paired DM target", async () => {
    await expectSuccessfulAction({
      mockFn: getMessageMSTeamsMock,
      mockResult: readMessage,
      action: "read",
      actionParams: {
        to: "user:aad-user-1",
        messageId: "msg-1",
      },
      toolContext: {
        currentChannelId: "user:aad-user-1",
        currentChannelProvider: "msteams",
      },
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            dmPolicy: "pairing",
          },
        },
      },
      accountId: "default",
      requesterAccountId: "default",
      runtimeParams: {
        to: "user:aad-user-1",
        messageId: "msg-1",
      },
      details: okMSTeamsActionDetails("read", {
        message: readMessage,
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "read",
        message: readMessage,
      },
    });
  });

  it("uses the global group policy when Teams does not override it", async () => {
    await expectSuccessfulAction({
      mockFn: getMessageMSTeamsMock,
      mockResult: readMessage,
      action: "read",
      actionParams: {
        to: graphChannelTarget,
        messageId: "msg-1",
      },
      cfg: {
        channels: {
          defaults: { groupPolicy: "open" },
          msteams: {},
        },
      },
      runtimeParams: {
        to: graphChannelTarget,
        messageId: "msg-1",
      },
      details: okMSTeamsActionDetails("read", {
        message: readMessage,
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "read",
        message: readMessage,
      },
    });
  });

  it("allows the trusted current channel under allowlist policy", async () => {
    await expectSuccessfulAction({
      mockFn: getMessageMSTeamsMock,
      mockResult: readMessage,
      action: "read",
      actionParams: {
        messageId: "msg-1",
      },
      toolContext: {
        currentChannelProvider: "msteams",
        currentMessagingTarget: "team-1/channel-1",
      },
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["aad-user-1"],
          },
        },
      },
      accountId: "default",
      requesterAccountId: "default",
      runtimeParams: {
        to: "team-1/channel-1",
        messageId: "msg-1",
      },
      details: okMSTeamsActionDetails("read", {
        message: readMessage,
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "read",
        message: readMessage,
      },
    });
  });

  it("does not route channel Graph actions through a Bot Framework conversation id", async () => {
    await expectActionError(
      {
        action: "read",
        params: { messageId: "msg-1" },
        toolContext: {
          currentChannelId: "conversation:19:channel@thread.tacv2",
          currentChatType: "channel",
        },
      },
      "Read requires a target (to) and messageId.",
    );
    expect(getMessageMSTeamsMock).not.toHaveBeenCalled();
  });

  it("allows the trusted current group chat when DMs are disabled", async () => {
    await expectSuccessfulAction({
      mockFn: getMessageMSTeamsMock,
      mockResult: readMessage,
      action: "read",
      actionParams: {
        messageId: "msg-1",
      },
      toolContext: {
        currentChannelProvider: "msteams",
        currentChannelId: "conversation:19:group@thread.v2",
        currentChatType: "group",
      },
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "open",
            dmPolicy: "disabled",
          },
        },
      },
      accountId: "default",
      requesterAccountId: "default",
      runtimeParams: {
        to: "conversation:19:group@thread.v2",
        messageId: "msg-1",
      },
      details: okMSTeamsActionDetails("read", {
        message: readMessage,
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "read",
        message: readMessage,
      },
    });
  });

  it("allows a bare trusted current group target when DMs are disabled", async () => {
    await expectSuccessfulAction({
      mockFn: getMessageMSTeamsMock,
      mockResult: readMessage,
      action: "read",
      actionParams: {
        messageId: "msg-1",
      },
      toolContext: {
        currentChannelProvider: "msteams",
        currentChannelId: "19:group@thread.v2",
        currentChatType: "group",
      },
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "open",
            dmPolicy: "disabled",
          },
        },
      },
      accountId: "default",
      requesterAccountId: "default",
      runtimeParams: {
        to: "19:group@thread.v2",
        messageId: "msg-1",
      },
      details: okMSTeamsActionDetails("read", {
        message: readMessage,
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "read",
        message: readMessage,
      },
    });
  });

  it("requires both scopes for a non-current opaque chat target", async () => {
    getMessageMSTeamsMock.mockResolvedValue(readMessage);

    await expect(
      runAction({
        action: "read",
        params: {
          to: "conversation:19:direct@thread.v2",
          messageId: "msg-1",
        },
        cfg: {
          channels: {
            msteams: {
              groupPolicy: "open",
              dmPolicy: "pairing",
            },
          },
        },
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
    expect(getMessageMSTeamsMock).not.toHaveBeenCalled();
  });

  it("allows a non-current opaque chat target when both scopes are open", async () => {
    await expectSuccessfulAction({
      mockFn: getMessageMSTeamsMock,
      mockResult: readMessage,
      action: "read",
      actionParams: {
        to: "conversation:19:opaque@thread.v2",
        messageId: "msg-1",
      },
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "open",
            dmPolicy: "open",
          },
        },
      },
      runtimeParams: {
        to: "conversation:19:opaque@thread.v2",
        messageId: "msg-1",
      },
      details: okMSTeamsActionDetails("read", {
        message: readMessage,
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "read",
        message: readMessage,
      },
    });
  });

  it("does not treat per-DM history config as read authorization", async () => {
    getMessageMSTeamsMock.mockResolvedValue(readMessage);

    await expect(
      runAction({
        action: "read",
        params: {
          to: "user:aad-user-1",
          messageId: "msg-1",
        },
        cfg: {
          channels: {
            msteams: {
              dmPolicy: "allowlist",
              allowFrom: [],
              dms: { "aad-user-1": { historyLimit: 5 } },
            },
          },
        },
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
    expect(getMessageMSTeamsMock).not.toHaveBeenCalled();
  });

  it("advertises upload-file in the message tool surface", () => {
    expect(
      msteamsPlugin.actions?.describeMessageTool?.({
        cfg: {
          channels: {
            msteams: {
              appId: "app-id",
              appPassword: "secret",
              tenantId: "tenant-id",
            },
          },
        } as OpenClawConfig,
      })?.actions,
    ).toContain("upload-file");
  });

  it("routes upload-file through sendMessageMSTeams with filename override", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("pdf"));
    await expectSuccessfulAction({
      mockFn: sendMessageMSTeamsMock,
      mockResult: {
        messageId: "msg-upload-1",
        conversationId: "conv-upload-1",
      },
      action: "upload-file",
      actionParams: {
        target: padded(targetChannelId),
        path: " /tmp/report.pdf ",
        message: "Quarterly report",
        filename: "Q1-report.pdf",
      },
      mediaLocalRoots: ["/tmp"],
      mediaReadFile,
      runtimeParams: {
        to: targetChannelId,
        text: "Quarterly report",
        mediaUrl: " /tmp/report.pdf ",
        filename: "Q1-report.pdf",
        mediaLocalRoots: ["/tmp"],
        mediaReadFile,
      },
      details: {
        ok: true,
        channel: "msteams",
        messageId: "msg-upload-1",
      },
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "upload-file",
        messageId: "msg-upload-1",
        conversationId: "conv-upload-1",
      },
    });
  });

  it("routes member-info through the Teams runtime", async () => {
    await expectSuccessfulAction({
      mockFn: getMemberInfoMSTeamsMock,
      mockResult: { member: { id: "user-1" } },
      action: "member-info",
      cfg: unrestrictedReadCfg,
      actionParams: { userId: " user-1 ", to: graphChannelTarget },
      runtimeParams: {
        to: graphChannelTarget,
        userId: "user-1",
        currentRequesterId: undefined,
      },
      details: okMSTeamsActionDetails("member-info", {
        member: { id: "user-1" },
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "member-info",
        member: { id: "user-1" },
      },
    });
  });

  it("passes the trusted requester only for current Teams chats", async () => {
    await expectSuccessfulAction({
      mockFn: getMemberInfoMSTeamsMock,
      mockResult: { member: { id: "user-1" } },
      action: "member-info",
      cfg: unrestrictedReadCfg,
      accountId: "default",
      requesterAccountId: "default",
      requesterSenderId: "user-1",
      toolContext: {
        currentChannelProvider: "msteams",
        currentChannelId: "conversation:19:group@thread.v2",
        currentChatType: "group",
      },
      actionParams: {
        userId: "user-1",
        to: "conversation:19:group@thread.v2",
      },
      runtimeParams: {
        to: "conversation:19:group@thread.v2",
        userId: "user-1",
        currentRequesterId: "user-1",
      },
      details: okMSTeamsActionDetails("member-info", {
        member: { id: "user-1" },
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "member-info",
        member: { id: "user-1" },
      },
    });
  });

  it("routes channel-list through the Teams runtime", async () => {
    await expectSuccessfulAction({
      mockFn: listChannelsMSTeamsMock,
      mockResult: { channels: [{ id: "channel-1" }] },
      action: "channel-list",
      cfg: unrestrictedReadCfg,
      actionParams: { teamId: ` ${graphTeamId} ` },
      runtimeParams: { teamId: graphTeamId },
      details: okMSTeamsActionDetails("channel-list", {
        channels: [{ id: "channel-1" }],
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "channel-list",
        channels: [{ id: "channel-1" }],
      },
    });
  });

  it("routes channel-info through the Teams runtime", async () => {
    await expectSuccessfulAction({
      mockFn: getChannelInfoMSTeamsMock,
      mockResult: { channel: { id: "channel-1" } },
      action: "channel-info",
      cfg: unrestrictedReadCfg,
      actionParams: {
        teamId: ` ${graphTeamId} `,
        channelId: ` ${graphChannelId} `,
      },
      runtimeParams: {
        teamId: graphTeamId,
        channelId: graphChannelId,
      },
      details: okMSTeamsActionDetails("channel-info", {
        channelInfo: { id: "channel-1" },
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "channel-info",
        channelInfo: { id: "channel-1" },
      },
    });
  });

  it("requires trusted requester sender for Teams group-management actions from Teams turns", () => {
    const requiresTrustedRequesterSender = msteamsPlugin.actions?.requiresTrustedRequesterSender;
    if (!requiresTrustedRequesterSender) {
      throw new Error("msteams actions.requiresTrustedRequesterSender unavailable");
    }

    for (const action of ["addParticipant", "removeParticipant", "renameGroup"] as const) {
      expect(
        requiresTrustedRequesterSender({
          action,
          toolContext: { currentChannelProvider: "msteams" },
        }),
      ).toBe(true);
    }
    expect(
      requiresTrustedRequesterSender({
        action: "addParticipant",
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).toBe(false);
    expect(
      requiresTrustedRequesterSender({
        action: "read",
        toolContext: { currentChannelProvider: "msteams" },
      }),
    ).toBe(false);
  });

  it("rejects group-management actions from non-owner non-admin callers", async () => {
    const cases = [
      {
        action: "addParticipant",
        mockFn: addParticipantMSTeamsMock,
        params: { target: targetChannelId, userId: "user-1" },
      },
      {
        action: "removeParticipant",
        mockFn: removeParticipantMSTeamsMock,
        params: { target: targetChannelId, userId: "user-1" },
      },
      {
        action: "renameGroup",
        mockFn: renameGroupMSTeamsMock,
        params: { target: targetChannelId, name: "Renamed group" },
      },
    ] as const;

    for (const testCase of cases) {
      await expectActionError(
        {
          action: testCase.action,
          params: testCase.params,
          senderIsOwner: false,
          gatewayClientScopes: ["operator.write"],
        },
        groupManagementAuthError,
      );
      expect(testCase.mockFn).not.toHaveBeenCalled();
    }
  });

  it("allows owner-authorized group-management actions", async () => {
    await expectSuccessfulAction({
      mockFn: addParticipantMSTeamsMock,
      mockResult: { added: { userId: "user-1", chatId: targetChannelId } },
      action: "addParticipant",
      actionParams: {
        target: targetChannelId,
        userId: " user-1 ",
        role: " owner ",
      },
      senderIsOwner: true,
      runtimeParams: {
        to: targetChannelId,
        userId: "user-1",
        role: "owner",
      },
      details: okMSTeamsActionDetails("addParticipant", {
        added: { userId: "user-1", chatId: targetChannelId },
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "addParticipant",
        added: { userId: "user-1", chatId: targetChannelId },
      },
    });
  });

  it("allows operator.admin group-management actions without owner sender status", async () => {
    await expectSuccessfulAction({
      mockFn: removeParticipantMSTeamsMock,
      mockResult: { removed: { userId: "user-1", chatId: targetChannelId } },
      action: "removeParticipant",
      actionParams: {
        target: targetChannelId,
        userId: " user-1 ",
      },
      senderIsOwner: false,
      gatewayClientScopes: ["operator.admin"],
      runtimeParams: {
        to: targetChannelId,
        userId: "user-1",
      },
      details: okMSTeamsActionDetails("removeParticipant", {
        removed: { userId: "user-1", chatId: targetChannelId },
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "removeParticipant",
        removed: { userId: "user-1", chatId: targetChannelId },
      },
    });

    await expectSuccessfulAction({
      mockFn: renameGroupMSTeamsMock,
      mockResult: { renamed: { chatId: targetChannelId, newName: "Renamed group" } },
      action: "renameGroup",
      actionParams: {
        target: targetChannelId,
        name: " Renamed group ",
      },
      senderIsOwner: false,
      gatewayClientScopes: ["operator.admin"],
      runtimeParams: {
        to: targetChannelId,
        name: "Renamed group",
      },
      details: okMSTeamsActionDetails("renameGroup", {
        renamed: { chatId: targetChannelId, newName: "Renamed group" },
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "renameGroup",
        renamed: { chatId: targetChannelId, newName: "Renamed group" },
      },
    });
  });

  it("accepts target as an alias for pin actions", async () => {
    await expectSuccessfulAction({
      mockFn: pinMessageMSTeamsMock,
      mockResult: { ok: true, pinnedMessageId: "pin-1" },
      action: "pin",
      cfg: unrestrictedReadCfg,
      actionParams: {
        target: padded(targetChannelId),
        messageId: padded("msg-2"),
      },
      runtimeParams: {
        to: targetChannelId,
        messageId: "msg-2",
      },
      details: okMSTeamsActionDetails("pin", {
        pinnedMessageId: "pin-1",
      }),
    });
  });

  it("falls back from content to message fields for edit actions", async () => {
    await expectSuccessfulAction({
      mockFn: editMessageMSTeamsMock,
      mockResult: { conversationId: editedConversationId },
      action: "edit",
      cfg: unrestrictedReadCfg,
      actionParams: {
        to: targetChannelId,
        messageId: editedMessageId,
        content: updatedText,
      },
      runtimeParams: {
        to: targetChannelId,
        activityId: editedMessageId,
        text: updatedText,
      },
      details: {
        ok: true,
        channel: "msteams",
      },
      contentDetails: {
        ok: true,
        channel: "msteams",
        conversationId: editedConversationId,
      },
    });
  });

  it("falls back from pinnedMessageId to messageId for unpin actions", async () => {
    await expectSuccessfulAction({
      mockFn: unpinMessageMSTeamsMock,
      mockResult: { ok: true },
      action: "unpin",
      cfg: unrestrictedReadCfg,
      actionParams: {
        target: padded(targetChannelId),
        messageId: padded("pin-2"),
      },
      runtimeParams: {
        to: targetChannelId,
        pinnedMessageId: "pin-2",
      },
      details: okMSTeamsActionDetails("unpin"),
    });
  });

  it("uses explicit pinnedMessageId over messageId for unpin actions", async () => {
    await expectSuccessfulAction({
      mockFn: unpinMessageMSTeamsMock,
      mockResult: { ok: true },
      action: "unpin",
      cfg: unrestrictedReadCfg,
      actionParams: {
        target: padded(targetChannelId),
        pinnedMessageId: padded("pinned-resource-99"),
        messageId: padded("msg-99"),
      },
      runtimeParams: {
        to: targetChannelId,
        pinnedMessageId: "pinned-resource-99",
      },
      details: okMSTeamsActionDetails("unpin"),
    });
  });

  it("returns an error when unpin is called without pinnedMessageId or messageId", async () => {
    await expectActionParamError(
      "unpin",
      { target: targetChannelId },
      "Unpin requires a target (to) and pinnedMessageId.",
    );
  });

  it("exposes pinnedMessageId in the tool schema", () => {
    const discovery = msteamsPlugin.actions?.describeMessageTool?.({
      cfg: {
        channels: {
          msteams: {
            appId: "app-id",
            appPassword: "secret",
            tenantId: "tenant-id",
          },
        },
      } as OpenClawConfig,
    });
    const schema = discovery?.schema;
    if (!schema) {
      throw new Error("expected msteams message tool schema");
    }
    const properties = Array.isArray(schema)
      ? schema[0]?.properties
      : (schema as { properties: Record<string, unknown> })?.properties;
    expect(properties).toHaveProperty("pinnedMessageId");
  });

  it("reuses currentChannelId fallback for react actions", async () => {
    await expectSuccessfulAction({
      mockFn: reactMessageMSTeamsMock,
      mockResult: { ok: true },
      action: "react",
      cfg: unrestrictedReadCfg,
      accountId: "default",
      requesterAccountId: "default",
      actionParams: {
        messageId: padded("msg-3"),
        emoji: padded(reactionType),
      },
      toolContext: {
        currentChannelId: padded(reactChannelId),
      },
      runtimeParams: {
        to: reactChannelId,
        messageId: "msg-3",
        reactionType,
      },
      details: okMSTeamsActionDetails("react", {
        reactionType,
      }),
      contentDetails: {
        channel: "msteams",
        action: "react",
        reactionType,
        ok: true,
      },
    });
  });

  it("shares the missing target and messageId validation across actions", async () => {
    await expectActionParamError("delete", {}, deleteMissingTargetError);

    await expectActionParamError("reactions", { to: targetChannelId }, reactionsMissingTargetError);
  });

  it("keeps presentation-card target validation shared", async () => {
    await expectActionParamError(
      "send",
      { presentation: { blocks: [{ type: "text", text: "hello" }] } },
      presentationSendMissingTargetError,
    );
  });

  it("preserves message text when sending presentation cards", async () => {
    await expectSuccessfulAction({
      mockFn: sendAdaptiveCardMSTeamsMock,
      mockResult: {
        messageId: "msg-card-1",
        conversationId: "conv-card-1",
      },
      action: "send",
      actionParams: {
        to: targetChannelId,
        message: "Deploy finished",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open", value: "open" }],
            },
          ],
        },
      },
      runtimeParams: {
        to: targetChannelId,
        card: {
          type: "AdaptiveCard",
          version: "1.4",
          body: [{ type: "TextBlock", text: "Deploy finished", wrap: true }],
          actions: [
            { type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } },
          ],
        },
      },
      details: {
        ok: true,
        channel: "msteams",
        messageId: "msg-card-1",
      },
      contentDetails: {
        ok: true,
        channel: "msteams",
        messageId: "msg-card-1",
        conversationId: "conv-card-1",
      },
    });
  });

  it("downgrades select blocks when sending presentation cards", async () => {
    await expectSuccessfulAction({
      mockFn: sendAdaptiveCardMSTeamsMock,
      mockResult: {
        messageId: "msg-card-select-1",
        conversationId: "conv-card-select-1",
      },
      action: "send",
      actionParams: {
        to: targetChannelId,
        presentation: {
          blocks: [
            {
              type: "select",
              placeholder: "Pick a lane",
              options: [
                { label: "Canary", value: "canary" },
                { label: "Stable", value: "stable" },
              ],
            },
          ],
        },
      },
      runtimeParams: {
        to: targetChannelId,
        card: {
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: "Pick a lane:\n- Canary\n- Stable",
              wrap: true,
              isSubtle: true,
              size: "Small",
            },
          ],
        },
      },
      details: {
        ok: true,
        channel: "msteams",
        messageId: "msg-card-select-1",
      },
      contentDetails: {
        ok: true,
        channel: "msteams",
        messageId: "msg-card-select-1",
        conversationId: "conv-card-select-1",
      },
    });
  });

  it("reports the allowed reaction types when emoji is missing", async () => {
    await expectActionParamError(
      "react",
      {
        to: targetChannelId,
        messageId: "msg-4",
      },
      reactMissingEmojiError,
      {
        error: reactMissingEmojiDetail,
        validTypes: reactionTypes,
      },
    );
  });

  it("requires a non-empty search query after trimming", async () => {
    await expectActionError(
      {
        action: "search",
        cfg: unrestrictedReadCfg,
        params: {
          to: targetChannelId,
          query: "   ",
        },
      },
      searchMissingQueryError,
    );
  });

  it("rejects reads outside configured Teams channels before calling Graph", async () => {
    await expect(
      runAction({
        action: "read",
        cfg: {
          channels: {
            msteams: {
              groupPolicy: "allowlist",
              teams: {
                "team-1": {
                  channels: {
                    "channel-1": { enabled: true },
                  },
                },
              },
            },
          },
        },
        params: { to: "team-1/channel-2", messageId: "msg-1" },
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
    expect(getMessageMSTeamsMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: "edit",
      params: { to: targetChannelId, messageId: "msg-1", content: "updated" },
      runtimeMock: editMessageMSTeamsMock,
    },
    {
      action: "delete",
      params: { to: targetChannelId, messageId: "msg-1" },
      runtimeMock: deleteMessageMSTeamsMock,
    },
    {
      action: "pin",
      params: { to: targetChannelId, messageId: "msg-1" },
      runtimeMock: pinMessageMSTeamsMock,
    },
    {
      action: "unpin",
      params: { to: targetChannelId, pinnedMessageId: "pin-1" },
      runtimeMock: unpinMessageMSTeamsMock,
    },
    {
      action: "react",
      params: { to: targetChannelId, messageId: "msg-1", emoji: "like" },
      runtimeMock: reactMessageMSTeamsMock,
    },
  ])("rejects a blocked $action target before the provider operation", async (testCase) => {
    await expect(
      runAction({
        action: testCase.action,
        cfg: {
          channels: {
            msteams: {
              groupPolicy: "allowlist",
              dmPolicy: "pairing",
            },
          },
        },
        accountId: "default",
        requesterAccountId: "default",
        params: testCase.params,
        toolContext: {
          currentChannelProvider: "msteams",
          currentChannelId,
          currentChatType: "group",
        },
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
    expect(testCase.runtimeMock).not.toHaveBeenCalled();
  });

  it("restores the Graph route from a core-materialized channel target", async () => {
    // Core materializes an omitted target from currentChannelId before plugin
    // dispatch. Teams must restore the prepared Graph target for channel turns.
    const teamChannelTarget = "team-1/19:channel-abc@thread.tacv2";
    const conversationTarget = "conversation:19:channel-abc@thread.tacv2";
    await expectSuccessfulAction({
      mockFn: reactMessageMSTeamsMock,
      mockResult: { ok: true },
      action: "react",
      cfg: unrestrictedReadCfg,
      accountId: "default",
      requesterAccountId: "default",
      actionParams: {
        target: conversationTarget,
        messageId: "msg-channel-react",
        emoji: reactionType,
      },
      toolContext: {
        currentChannelProvider: "msteams",
        currentChannelId: conversationTarget,
        currentChatType: "channel",
        currentMessagingTarget: teamChannelTarget,
      },
      runtimeParams: {
        to: teamChannelTarget,
        messageId: "msg-channel-react",
        reactionType,
      },
      details: okMSTeamsActionDetails("react", {
        reactionType,
      }),
      contentDetails: {
        channel: "msteams",
        action: "react",
        reactionType,
        ok: true,
      },
    });
  });

  it("preserves explicit teamId/channelId target over toolContext fallback", async () => {
    // Even in a channel context with a compound currentChannelId, an
    // explicit `target` param must take precedence.
    const teamChannelTarget = "22222222-2222-2222-2222-222222222222/19:channel-def@thread.tacv2";
    const explicitTarget = "33333333-3333-3333-3333-333333333333/19:other@thread.tacv2";
    await expectSuccessfulAction({
      mockFn: reactMessageMSTeamsMock,
      mockResult: { ok: true },
      action: "react",
      cfg: unrestrictedReadCfg,
      actionParams: {
        target: explicitTarget,
        messageId: "msg-explicit",
        emoji: reactionType,
      },
      toolContext: {
        currentChannelId: teamChannelTarget,
        currentGraphChannelId: teamChannelTarget,
      },
      runtimeParams: {
        to: explicitTarget,
        messageId: "msg-explicit",
        reactionType,
      },
      details: okMSTeamsActionDetails("react", {
        reactionType,
      }),
      contentDetails: {
        channel: "msteams",
        action: "react",
        reactionType,
        ok: true,
      },
    });
  });

  it("keeps chat conversation fallback targets as-is for DM react actions", async () => {
    // DM/group-chat turns continue to set currentChannelId to a
    // `conversation:<id>` string (no `teamId/` prefix), which the runtime
    // will resolve through `/chats/{id}`.
    const dmFallback = "conversation:19:chat-dm@thread.skype";
    await expectSuccessfulAction({
      mockFn: reactMessageMSTeamsMock,
      mockResult: { ok: true },
      action: "react",
      cfg: unrestrictedReadCfg,
      actionParams: {
        messageId: "msg-dm-react",
        emoji: reactionType,
      },
      toolContext: {
        currentChannelId: dmFallback,
        currentChatType: "direct",
      },
      runtimeParams: {
        to: dmFallback,
        messageId: "msg-dm-react",
        reactionType,
      },
      details: okMSTeamsActionDetails("react", {
        reactionType,
      }),
      contentDetails: {
        channel: "msteams",
        action: "react",
        reactionType,
        ok: true,
      },
    });
  });
});

describe("msteamsPlugin.threading.buildToolContext", () => {
  function callBuildToolContext(context: {
    ChatType?: string;
    To?: string;
    NativeChannelId?: string;
    ReplyToId?: string;
  }) {
    const build = msteamsPlugin.threading?.buildToolContext;
    if (!build) {
      throw new Error("msteams threading.buildToolContext unavailable");
    }
    return build({
      cfg: {} as OpenClawConfig,
      accountId: undefined,
      context,
    });
  }

  it("uses NativeChannelId for channel turns so actions route via Graph team/channel ids", () => {
    // Teams channel inbound messages carry the compound Graph target
    // on NativeChannelId. buildToolContext must prefer it over the bare
    // `conversation:<id>` in To so action fallbacks route via
    // `/teams/{teamId}/channels/{channelId}`.
    const result = callBuildToolContext({
      ChatType: "channel",
      To: "conversation:19:channel-abc@thread.tacv2",
      NativeChannelId: "graph-team-1/19:channel-abc@thread.tacv2",
      ReplyToId: "reply-1",
    });
    expect(result?.currentChannelId).toBe("conversation:19:channel-abc@thread.tacv2");
    expect(result?.currentChatType).toBe("channel");
    expect(result?.currentMessagingTarget).toBe("graph-team-1/19:channel-abc@thread.tacv2");
    expect(result?.currentGraphChannelId).toBe("graph-team-1/19:channel-abc@thread.tacv2");
    expect(result?.currentThreadTs).toBe("reply-1");
  });

  it("falls back to To for DM turns (no NativeChannelId)", () => {
    const result = callBuildToolContext({
      ChatType: "direct",
      To: "user:aad-user-1",
    });
    expect(result?.currentChannelId).toBe("user:aad-user-1");
    expect(result?.currentChatType).toBe("direct");
    expect(result?.currentMessagingTarget).toBeUndefined();
    expect(result?.currentGraphChannelId).toBeUndefined();
  });

  it("falls back to To for group chat turns (no NativeChannelId)", () => {
    const result = callBuildToolContext({
      ChatType: "group",
      To: "conversation:19:groupchat@thread.v2",
    });
    expect(result?.currentChannelId).toBe("conversation:19:groupchat@thread.v2");
    expect(result?.currentChatType).toBe("group");
    expect(result?.currentMessagingTarget).toBeUndefined();
    expect(result?.currentGraphChannelId).toBeUndefined();
  });

  it("ignores NativeChannelId that does not encode a teamId/channelId pair", () => {
    // Safety: only compound forms (with "/") should preempt the To fallback.
    // A bare native id without a team prefix must not accidentally route
    // through channel Graph paths.
    const result = callBuildToolContext({
      To: "conversation:19:chat@thread.v2",
      NativeChannelId: "19:chat@thread.v2",
    });
    expect(result?.currentChannelId).toBe("conversation:19:chat@thread.v2");
    expect(result?.currentMessagingTarget).toBeUndefined();
    expect(result?.currentGraphChannelId).toBeUndefined();
  });
});
