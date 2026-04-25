import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuPlugin } from "./channel.js";
import { looksLikeFeishuId, normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const addReactionFeishuMock = vi.hoisted(() => vi.fn());
const listReactionsFeishuMock = vi.hoisted(() => vi.fn());
const removeReactionFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const editMessageFeishuMock = vi.hoisted(() => vi.fn());
const createPinFeishuMock = vi.hoisted(() => vi.fn());
const listPinsFeishuMock = vi.hoisted(() => vi.fn());
const removePinFeishuMock = vi.hoisted(() => vi.fn());
const getChatInfoMock = vi.hoisted(() => vi.fn());
const getChatMembersMock = vi.hoisted(() => vi.fn());
const getFeishuMemberInfoMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryPeersLiveMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryGroupsLiveMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    addReactionFeishu: addReactionFeishuMock,
    createPinFeishu: createPinFeishuMock,
    editMessageFeishu: editMessageFeishuMock,
    getChatInfo: getChatInfoMock,
    getChatMembers: getChatMembersMock,
    getFeishuMemberInfo: getFeishuMemberInfoMock,
    getMessageFeishu: getMessageFeishuMock,
    listFeishuDirectoryGroupsLive: listFeishuDirectoryGroupsLiveMock,
    listFeishuDirectoryPeersLive: listFeishuDirectoryPeersLiveMock,
    listPinsFeishu: listPinsFeishuMock,
    listReactionsFeishu: listReactionsFeishuMock,
    probeFeishu: probeFeishuMock,
    removePinFeishu: removePinFeishuMock,
    removeReactionFeishu: removeReactionFeishuMock,
    sendCardFeishu: sendCardFeishuMock,
    sendMessageFeishu: sendMessageFeishuMock,
    feishuOutbound: {
      sendText: vi.fn(),
      sendMedia: feishuOutboundSendMediaMock,
    },
  },
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

function getDescribedActions(cfg: OpenClawConfig, accountId?: string): string[] {
  return [...(feishuPlugin.actions?.describeMessageTool?.({ cfg, accountId })?.actions ?? [])];
}

describe("feishuPlugin.status.probeAccount", () => {
  it("uses current account credentials for multi-account config", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = feishuPlugin.config.resolveAccount(cfg, "main");
    probeFeishuMock.mockResolvedValueOnce({ ok: true, appId: "cli_main" });

    const result = await feishuPlugin.status?.probeAccount?.({
      account,
      timeoutMs: 1_000,
      cfg,
    });

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(probeFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        appId: "cli_main",
        appSecret: "secret_main",
      }),
    );
    expect(result).toMatchObject({ ok: true, appId: "cli_main" });
  });
});

describe("feishuPlugin.pairing.notifyApproval", () => {
  beforeEach(() => {
    sendMessageFeishuMock.mockReset();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "pairing-msg", chatId: "ou_user" });
  });

  it("preserves accountId when sending pairing approvals", async () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            work: {
              appId: "cli_work",
              appSecret: "secret_work",
              enabled: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    await feishuPlugin.pairing?.notifyApproval?.({
      cfg,
      id: "ou_user",
      accountId: "work",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        to: "ou_user",
        accountId: "work",
      }),
    );
  });
});

describe("feishuPlugin messaging", () => {
  it("owns sender/topic session inheritance candidates", () => {
    expect(
      feishuPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      }),
    ).toEqual({
      id: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      baseConversationId: "oc_group_chat",
      parentConversationCandidates: ["oc_group_chat:topic:om_topic_root", "oc_group_chat"],
    });
    expect(
      feishuPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: "oc_group_chat:topic:om_topic_root",
      }),
    ).toEqual({
      id: "oc_group_chat:topic:om_topic_root",
      baseConversationId: "oc_group_chat",
      parentConversationCandidates: ["oc_group_chat"],
    });
    expect(
      feishuPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: "oc_group_chat:Topic:om_topic_root:Sender:ou_topic_user",
      }),
    ).toEqual({
      id: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      baseConversationId: "oc_group_chat",
      parentConversationCandidates: ["oc_group_chat:topic:om_topic_root", "oc_group_chat"],
    });
  });
});

describe("feishuPlugin actions", () => {
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_main",
        appSecret: "secret_main",
        actions: {
          reactions: true,
        },
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({ tag: "client" });
  });

  it("advertises the expanded Feishu action surface", () => {
    expect(getDescribedActions(cfg)).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
      "react",
      "reactions",
    ]);
  });

  it("does not advertise reactions when disabled via actions config", () => {
    const disabledCfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: "cli_main",
          appSecret: "secret_main",
          actions: {
            reactions: false,
          },
        },
      },
    } as OpenClawConfig;

    expect(getDescribedActions(disabledCfg)).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
    ]);
  });

  it("honors the selected Feishu account during discovery", () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          actions: { reactions: false },
          accounts: {
            default: {
              enabled: true,
              appId: "cli_main",
              appSecret: "secret_main",
              actions: { reactions: false },
            },
            work: {
              enabled: true,
              appId: "cli_work",
              appSecret: "secret_work",
              actions: { reactions: true },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(getDescribedActions(cfg, "default")).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
    ]);
    expect(getDescribedActions(cfg, "work")).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
      "react",
      "reactions",
    ]);
  });

  it("sends text messages", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_sent", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", message: "hello" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "hello",
      accountId: undefined,
      replyToMessageId: undefined,
      replyInThread: false,
    });
    expect(result?.details).toMatchObject({ ok: true, messageId: "om_sent", chatId: "oc_group_1" });
  });

  it("renders presentation messages as cards", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        presentation: {
          title: "Status",
          blocks: [{ type: "text", text: "Build completed" }],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      card: expect.objectContaining({
        schema: "2.0",
        header: {
          title: { tag: "plain_text", content: "Status" },
          template: "blue",
        },
        body: {
          elements: [
            {
              tag: "markdown",
              content: "Build completed",
            },
          ],
        },
      }),
      accountId: undefined,
      replyToMessageId: undefined,
      replyInThread: false,
    });
    expect(result?.details).toMatchObject({ ok: true, messageId: "om_card", chatId: "oc_group_1" });
  });

  it("renders presentation button labels into the card fallback", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Run help", value: "feishu.quick_actions.help" }],
            },
          ],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        card: expect.objectContaining({
          body: {
            elements: [
              {
                tag: "markdown",
                content: "- Run help",
              },
            ],
          },
        }),
      }),
    );
  });

  it("renders presentation select labels into the card fallback", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        presentation: {
          blocks: [
            {
              type: "select",
              placeholder: "Pick one",
              options: [{ label: "Option A", value: "a" }],
            },
          ],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        card: expect.objectContaining({
          body: {
            elements: [
              {
                tag: "markdown",
                content: "Pick one:\n- Option A",
              },
            ],
          },
        }),
      }),
    );
  });

  it("sends media through the outbound adapter", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_media",
      details: { messageId: "om_media", chatId: "oc_group_1" },
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "test",
        media: "/tmp/image.png",
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "test",
      mediaUrl: "/tmp/image.png",
      accountId: undefined,
      mediaLocalRoots: ["/tmp"],
      replyToId: undefined,
    });
    expect(result?.details).toMatchObject({ messageId: "om_media" });
  });

  it("passes asVoice through media sends", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_voice",
      details: { messageId: "om_voice", chatId: "oc_group_1" },
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        media: "https://example.com/reply.mp3",
        asVoice: true,
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: [],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      }),
    );
  });

  it("reads messages", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_1",
      content: "hello",
      contentType: "text",
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "read",
      params: { messageId: "om_1" },
      cfg,
      accountId: undefined,
    } as never);

    expect(getMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_1",
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      message: expect.objectContaining({ messageId: "om_1", content: "hello" }),
    });
  });

  it("returns an error result when message reads fail", async () => {
    getMessageFeishuMock.mockResolvedValueOnce(null);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "read",
      params: { messageId: "om_missing" },
      cfg,
      accountId: undefined,
    } as never);

    expect((result as { isError?: boolean } | undefined)?.isError).toBe(true);
    expect(result?.details).toEqual({
      error: "Feishu read failed or message not found: om_missing",
    });
  });

  it("edits messages", async () => {
    editMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_2", contentType: "post" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "edit",
      params: { messageId: "om_2", text: "updated" },
      cfg,
      accountId: undefined,
    } as never);

    expect(editMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_2",
      text: "updated",
      card: undefined,
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({ ok: true, messageId: "om_2", contentType: "post" });
  });

  it("sends explicit thread replies with reply_in_thread semantics", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_reply", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "thread-reply",
      params: { to: "chat:oc_group_1", messageId: "om_parent", text: "reply body" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "reply body",
      accountId: undefined,
      replyToMessageId: "om_parent",
      replyInThread: true,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      action: "thread-reply",
      messageId: "om_reply",
    });
  });

  it("creates pins", async () => {
    createPinFeishuMock.mockResolvedValueOnce({ messageId: "om_pin", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "pin",
      params: { messageId: "om_pin" },
      cfg,
      accountId: undefined,
    } as never);

    expect(createPinFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_pin",
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      pin: expect.objectContaining({ messageId: "om_pin" }),
    });
  });

  it("lists pins", async () => {
    listPinsFeishuMock.mockResolvedValueOnce({
      chatId: "oc_group_1",
      pins: [{ messageId: "om_pin" }],
      hasMore: false,
      pageToken: undefined,
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "list-pins",
      params: { chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(listPinsFeishuMock).toHaveBeenCalledWith({
      cfg,
      chatId: "oc_group_1",
      startTime: undefined,
      endTime: undefined,
      pageSize: undefined,
      pageToken: undefined,
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      pins: [expect.objectContaining({ messageId: "om_pin" })],
    });
  });

  it("removes pins", async () => {
    const result = await feishuPlugin.actions?.handleAction?.({
      action: "unpin",
      params: { messageId: "om_pin" },
      cfg,
      accountId: undefined,
    } as never);

    expect(removePinFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_pin",
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({ ok: true, messageId: "om_pin" });
  });

  it("fetches channel info", async () => {
    getChatInfoMock.mockResolvedValueOnce({ chat_id: "oc_group_1", name: "Eng" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "channel-info",
      params: { chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(createFeishuClientMock).toHaveBeenCalled();
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
    expect(result?.details).toMatchObject({
      ok: true,
      channel: expect.objectContaining({ chat_id: "oc_group_1", name: "Eng" }),
    });
  });

  it("fetches member lists from a chat", async () => {
    getChatMembersMock.mockResolvedValueOnce({
      chat_id: "oc_group_1",
      members: [{ member_id: "ou_1", name: "Alice" }],
      has_more: false,
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(getChatMembersMock).toHaveBeenCalledWith(
      { tag: "client" },
      "oc_group_1",
      undefined,
      undefined,
      "open_id",
    );
    expect(result?.details).toMatchObject({
      ok: true,
      members: [expect.objectContaining({ member_id: "ou_1", name: "Alice" })],
    });
  });

  it("fetches individual member info", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "ou_1", name: "Alice" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { memberId: "ou_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "ou_1", "open_id");
    expect(result?.details).toMatchObject({
      ok: true,
      member: expect.objectContaining({ member_id: "ou_1", name: "Alice" }),
    });
  });

  it("infers user_id lookups from the userId alias", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "u_1", name: "Alice" });

    await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { userId: "u_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "u_1", "user_id");
  });

  it("honors explicit open_id over alias heuristics", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "u_1", name: "Alice" });

    await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { userId: "u_1", memberIdType: "open_id" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "u_1", "open_id");
  });

  it("lists directory-backed peers and groups", async () => {
    listFeishuDirectoryGroupsLiveMock.mockResolvedValueOnce([{ kind: "group", id: "oc_group_1" }]);
    listFeishuDirectoryPeersLiveMock.mockResolvedValueOnce([{ kind: "user", id: "ou_1" }]);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "channel-list",
      params: { query: "eng", limit: 5 },
      cfg,
      accountId: undefined,
    } as never);

    expect(listFeishuDirectoryGroupsLiveMock).toHaveBeenCalledWith({
      cfg,
      query: "eng",
      limit: 5,
      fallbackToStatic: false,
      accountId: undefined,
    });
    expect(listFeishuDirectoryPeersLiveMock).toHaveBeenCalledWith({
      cfg,
      query: "eng",
      limit: 5,
      fallbackToStatic: false,
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      groups: [expect.objectContaining({ id: "oc_group_1" })],
      peers: [expect.objectContaining({ id: "ou_1" })],
    });
  });

  it("fails channel-list when live discovery fails", async () => {
    listFeishuDirectoryGroupsLiveMock.mockRejectedValueOnce(new Error("token expired"));

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "channel-list",
        params: { query: "eng", limit: 5, scope: "groups" },
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow("token expired");
  });

  it("requires clearAll=true before removing all bot reactions", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "react",
        params: { messageId: "om_msg1" },
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow(
      "Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.",
    );
  });

  it("allows explicit clearAll=true when removing all bot reactions", async () => {
    listReactionsFeishuMock.mockResolvedValueOnce([
      { reactionId: "r1", operatorType: "app" },
      { reactionId: "r2", operatorType: "app" },
    ]);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "react",
      params: { messageId: "om_msg1", clearAll: true },
      cfg,
      accountId: undefined,
    } as never);

    expect(listReactionsFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_msg1",
      accountId: undefined,
    });
    expect(removeReactionFeishuMock).toHaveBeenCalledTimes(2);
    expect(result?.details).toMatchObject({ ok: true, removed: 2 });
  });

  it("fails for missing params on supported actions", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "thread-reply",
        params: { to: "chat:oc_group_1", message: "reply body" },
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow("Feishu thread-reply requires messageId.");
  });

  it("sends media-only messages without requiring card", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_media_only",
      details: { messageId: "om_media_only", chatId: "oc_group_1" },
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        media: "https://example.com/image.png",
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: [],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_group_1",
        mediaUrl: "https://example.com/image.png",
      }),
    );
    expect(result?.details).toMatchObject({ messageId: "om_media_only" });
  });

  it("fails for unsupported action names", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "search",
        params: {},
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow('Unsupported Feishu action: "search"');
  });
});

describe("resolveReceiveIdType", () => {
  it("resolves chat IDs by oc_ prefix", () => {
    expect(resolveReceiveIdType("oc_123")).toBe("chat_id");
  });

  it("resolves open IDs by ou_ prefix", () => {
    expect(resolveReceiveIdType("ou_123")).toBe("open_id");
  });

  it("defaults unprefixed IDs to user_id", () => {
    expect(resolveReceiveIdType("u_123")).toBe("user_id");
  });

  it("treats explicit group targets as chat_id", () => {
    expect(resolveReceiveIdType("group:oc_123")).toBe("chat_id");
  });

  it("treats explicit channel targets as chat_id", () => {
    expect(resolveReceiveIdType("channel:oc_123")).toBe("chat_id");
  });

  it("treats dm-prefixed open IDs as open_id", () => {
    expect(resolveReceiveIdType("dm:ou_123")).toBe("open_id");
  });
});

describe("normalizeFeishuTarget", () => {
  it("strips provider and user prefixes", () => {
    expect(normalizeFeishuTarget("feishu:user:ou_123")).toBe("ou_123");
    expect(normalizeFeishuTarget("lark:user:ou_123")).toBe("ou_123");
  });

  it("strips provider and chat prefixes", () => {
    expect(normalizeFeishuTarget("feishu:chat:oc_123")).toBe("oc_123");
  });

  it("normalizes group/channel prefixes to chat ids", () => {
    expect(normalizeFeishuTarget("group:oc_123")).toBe("oc_123");
    expect(normalizeFeishuTarget("feishu:group:oc_123")).toBe("oc_123");
    expect(normalizeFeishuTarget("channel:oc_456")).toBe("oc_456");
    expect(normalizeFeishuTarget("lark:channel:oc_456")).toBe("oc_456");
  });

  it("accepts provider-prefixed raw ids", () => {
    expect(normalizeFeishuTarget("feishu:ou_123")).toBe("ou_123");
  });

  it("strips provider and dm prefixes", () => {
    expect(normalizeFeishuTarget("lark:dm:ou_123")).toBe("ou_123");
  });
});

describe("feishuPlugin.messaging.resolveDeliveryTarget", () => {
  it("routes direct conversations to user targets", () => {
    expect(
      feishuPlugin.messaging?.resolveDeliveryTarget?.({
        conversationId: "ou_123",
      }),
    ).toEqual({ to: "user:ou_123" });
  });

  it("routes group conversations to chat targets", () => {
    expect(
      feishuPlugin.messaging?.resolveDeliveryTarget?.({
        conversationId: "oc_123",
      }),
    ).toEqual({ to: "chat:oc_123" });
  });

  it("routes topic conversations to parent chat plus thread id", () => {
    expect(
      feishuPlugin.messaging?.resolveDeliveryTarget?.({
        conversationId: "oc_123:topic:omt_456",
        parentConversationId: "oc_123",
      }),
    ).toEqual({ to: "chat:oc_123", threadId: "omt_456" });
  });
});

describe("looksLikeFeishuId", () => {
  it("accepts provider-prefixed user targets", () => {
    expect(looksLikeFeishuId("feishu:user:ou_123")).toBe(true);
  });

  it("accepts provider-prefixed chat targets", () => {
    expect(looksLikeFeishuId("lark:chat:oc_123")).toBe(true);
  });

  it("accepts group/channel targets", () => {
    expect(looksLikeFeishuId("feishu:group:oc_123")).toBe(true);
    expect(looksLikeFeishuId("group:oc_123")).toBe(true);
    expect(looksLikeFeishuId("channel:oc_456")).toBe(true);
  });
});
