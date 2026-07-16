// Feishu tests cover channel plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const buildFeishuDirectChatMembersMock = vi.hoisted(() =>
  vi.fn(
    (authorization: { chatId: string; memberId: string; memberIdType: "open_id" | "user_id" }) => ({
      chat_id: authorization.chatId,
      has_more: false,
      page_token: undefined,
      members: [
        {
          member_id: authorization.memberId,
          name: undefined,
          tenant_key: undefined,
          member_id_type: authorization.memberIdType,
        },
      ],
    }),
  ),
);
const assertFeishuChatMemberMock = vi.hoisted(() => vi.fn());
const getFeishuMemberInfoMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryPeersLiveMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryGroupsLiveMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendMediaMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendPayloadMock = vi.hoisted(() => vi.fn());

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
    buildFeishuDirectChatMembers: buildFeishuDirectChatMembersMock,
    assertFeishuChatMember: assertFeishuChatMemberMock,
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
      sendPayload: feishuOutboundSendPayloadMock,
    },
  },
}));

function getDescribedActions(cfg: OpenClawConfig, accountId?: string): string[] {
  return [...(feishuPlugin.actions?.describeMessageTool?.({ cfg, accountId })?.actions ?? [])];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`Expected ${label} mock calls`);
  }
  const call = calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex + 1}`);
  }
  return call[argIndex];
}

function resultDetails(result: unknown) {
  return requireRecord(requireRecord(result, "action result").details, "action result details");
}

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./channel.runtime.js");
  vi.resetModules();
});

describe("feishuPlugin metadata", () => {
  it("opts announce delivery into persisted session lookup", () => {
    expect(feishuPlugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
  });
});

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
    const probeArgs = requireRecord(
      mockCallArg(probeFeishuMock, 0, 0, "probeFeishu"),
      "probe args",
    );
    expect(probeArgs.accountId).toBe("main");
    expect(probeArgs.appId).toBe("cli_main");
    expect(probeArgs.appSecret).toBe("secret_main");
    const resultRecord = requireRecord(result, "probe result");
    expect(resultRecord.ok).toBe(true);
    expect(resultRecord.appId).toBe("cli_main");
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

    const sendArgs = requireRecord(
      mockCallArg(sendMessageFeishuMock, 0, 0, "sendMessageFeishu"),
      "send args",
    );
    expect(sendArgs.cfg).toBe(cfg);
    expect(sendArgs.to).toBe("ou_user");
    expect(sendArgs.accountId).toBe("work");
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
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({ tag: "client" });
    getChatInfoMock.mockResolvedValue({
      chat_id: "oc_group_1",
      chat_mode: "group",
      chat_type: "private",
    });
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
    const cfgLocal = {
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

    expect(getDescribedActions(cfgLocal, "default")).toEqual([
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
    expect(getDescribedActions(cfgLocal, "work")).toEqual([
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
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.messageId).toBe("om_sent");
    expect(details.chatId).toBe("oc_group_1");
  });

  it("sends plain message card JSON as a native Feishu card", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: JSON.stringify({
          schema: "2.0",
          header: {
            title: { tag: "plain_text", content: "Plain JSON card" },
            template: "green",
          },
          body: {
            elements: [{ tag: "markdown", content: "Card body" }],
          },
        }),
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    expect(sendCardArgs.cfg).toBe(cfg);
    expect(sendCardArgs.to).toBe("chat:oc_group_1");
    expect(sendCardArgs.accountId).toBeUndefined();
    expect(sendCardArgs.replyToMessageId).toBeUndefined();
    expect(sendCardArgs.replyInThread).toBe(false);
    const card = requireRecord(sendCardArgs.card, "card");
    expect(card.header).toEqual({
      title: { tag: "plain_text", content: "Plain JSON card" },
      template: "green",
    });
    expect(card.body).toEqual({
      elements: [{ tag: "markdown", content: "Card body" }],
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.messageId).toBe("om_card");
    expect(details.chatId).toBe("oc_group_1");
  });

  it("sends legacy top-level elements card JSON as a native Feishu card", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: JSON.stringify({
          header: {
            title: { tag: "plain_text", content: "Legacy JSON card" },
            template: "green",
          },
          elements: [
            {
              tag: "div",
              text: { tag: "lark_md", content: '**Legacy** <at id="ou_1">body</at>' },
            },
            {
              tag: "div",
              text: { tag: "plain_text", content: "Literal *text*" },
            },
          ],
        }),
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    expect(card.header).toEqual({
      title: { tag: "plain_text", content: "Legacy JSON card" },
      template: "green",
    });
    expect(card.body).toEqual({
      elements: [
        {
          tag: "markdown",
          content: '**Legacy** &lt;at id="ou_1"&gt;body&lt;/at&gt;',
        },
        { tag: "markdown", content: "Literal \\*text\\*" },
      ],
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("detects message card JSON after the configured response prefix", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });
    const cardJson = JSON.stringify({
      body: {
        elements: [{ tag: "markdown", content: "Prefixed card" }],
      },
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: `[Nexus] ${cardJson}`,
      },
      cfg: {
        ...cfg,
        messages: { responsePrefix: "[Nexus]" },
      },
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    expect(card.body).toEqual({
      elements: [{ tag: "markdown", content: "Prefixed card" }],
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("sends wrapped interactive card JSON as a Feishu thread reply card", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "thread-reply",
      params: {
        to: "chat:oc_group_1",
        messageId: "om_parent",
        text: JSON.stringify({
          type: "interactive",
          card: {
            body: {
              elements: [{ tag: "markdown", content: "Reply card" }],
            },
          },
        }),
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    expect(sendCardArgs.replyToMessageId).toBe("om_parent");
    expect(sendCardArgs.replyInThread).toBe(true);
    const card = requireRecord(sendCardArgs.card, "card");
    expect(card.body).toEqual({
      elements: [{ tag: "markdown", content: "Reply card" }],
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps ordinary JSON messages on the text path", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_sent", chatId: "oc_group_1" });
    const message = JSON.stringify({ ok: true, elements: "not-a-card" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", message },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: message,
      accountId: undefined,
      replyToMessageId: undefined,
      replyInThread: false,
    });
  });

  it("rejects card JSON sent with media", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "send",
        params: {
          to: "chat:oc_group_1",
          message: JSON.stringify({
            elements: [{ tag: "markdown", content: "Card body" }],
          }),
          media: "/tmp/image.png",
        },
        cfg,
        accountId: undefined,
        toolContext: {},
        mediaLocalRoots: ["/tmp"],
      } as never),
    ).rejects.toThrow("Feishu send does not support card with media.");

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
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

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    expect(sendCardArgs.cfg).toBe(cfg);
    expect(sendCardArgs.to).toBe("chat:oc_group_1");
    expect(sendCardArgs.accountId).toBeUndefined();
    expect(sendCardArgs.replyToMessageId).toBeUndefined();
    expect(sendCardArgs.replyInThread).toBe(false);
    const card = requireRecord(sendCardArgs.card, "card");
    expect(card.schema).toBe("2.0");
    expect(card.header).toEqual({
      title: { tag: "plain_text", content: "Status" },
      template: "blue",
    });
    expect(card.body).toEqual({
      elements: [
        {
          tag: "markdown",
          content: "Build completed",
        },
      ],
    });
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.messageId).toBe("om_card");
    expect(details.chatId).toBe("oc_group_1");
  });

  it("hides prefixed native-card JSON in oversized presentation fallbacks", async () => {
    feishuOutboundSendPayloadMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_fallback",
      chatId: "oc_group_1",
    });
    const presentation = {
      blocks: [
        {
          type: "table" as const,
          caption: "Large pipeline",
          headers: ["Account", "Stage"],
          rows: Array.from({ length: 400 }, (_entry, index) => [
            `account-${String(index)}-${"x".repeat(80)}`,
            "Review",
          ]),
        },
      ],
    };
    const rawCardText = JSON.stringify({
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "Raw card JSON must stay hidden" }] },
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: `[Nexus] ${rawCardText}`,
        presentation,
        media: "/tmp/pipeline.png",
      },
      cfg: {
        ...cfg,
        messages: { responsePrefix: "[Nexus]" },
      },
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendPayloadMock).toHaveBeenCalledTimes(1);
    const fallbackArgs = requireRecord(
      mockCallArg(feishuOutboundSendPayloadMock, 0, 0, "feishuOutbound.sendPayload"),
      "fallback args",
    );
    const fallbackPayload = requireRecord(fallbackArgs.payload, "fallback payload");
    const fallbackPresentation = requireRecord(
      fallbackPayload.presentation,
      "fallback presentation",
    );
    const fallbackBlocks = requireArray(fallbackPresentation.blocks, "fallback blocks");
    const table = requireRecord(fallbackBlocks[0], "fallback table");
    const rows = requireArray(table.rows, "fallback rows");
    expect(requireArray(rows.at(-1), "last fallback row")[0]).toContain("account-399-");
    expect(fallbackPayload.mediaUrl).toBe("/tmp/pipeline.png");
    expect(fallbackPayload.text).toBeUndefined();
    expect(fallbackArgs.text).toBe("");
  });

  it("prefers structured presentation over raw card JSON text", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: JSON.stringify({
          header: { title: { tag: "plain_text", content: "Raw card" } },
          elements: [{ tag: "markdown", content: "Raw body" }],
        }),
        presentation: {
          title: "Structured card",
          blocks: [{ type: "text", text: "Structured body" }],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    expect(card.header).toEqual({
      title: { tag: "plain_text", content: "Structured card" },
      template: "blue",
    });
    expect(card.body).toEqual({
      elements: [{ tag: "markdown", content: "Structured body" }],
    });
  });

  it("prefers structured interactive input over raw card JSON text", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: JSON.stringify({
          header: { title: { tag: "plain_text", content: "Raw card" } },
          elements: [{ tag: "markdown", content: "Raw body" }],
        }),
        interactive: {
          blocks: [{ type: "text", text: "Interactive body" }],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    expect(card.header).toBeUndefined();
    expect(card.body).toEqual({
      elements: [{ tag: "markdown", content: "Interactive body" }],
    });
  });

  it("renders presentation buttons as native Feishu card buttons", async () => {
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

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    const elements = requireArray(requireRecord(card.body, "card body").elements, "card elements");
    expect(elements).toEqual([
      {
        tag: "button",
        text: { tag: "plain_text", content: "Run help" },
        type: "default",
        behaviors: [
          {
            type: "callback",
            value: {
              oc: "ocf1",
              k: "quick",
              a: "feishu.payload.button",
              q: "feishu.quick_actions.help",
            },
          },
        ],
      },
    ]);
    expect(
      elements.some((element) => requireRecord(element, "card element").tag === "action"),
    ).toBe(false);
  });

  it("does not render callback action buttons as Feishu quick commands", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Inspect", action: { type: "callback", value: "inspect:123" } }],
            },
          ],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    const elements = requireArray(requireRecord(card.body, "card body").elements, "card elements");
    expect(elements).toEqual([{ tag: "markdown", content: "- Inspect" }]);
  });

  it("renders legacy web_app presentation buttons as native Feishu link buttons", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open app", web_app: { url: "https://example.com/app" } }],
            },
          ],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    const elements = requireArray(requireRecord(card.body, "card body").elements, "card elements");
    expect(elements).toEqual([
      {
        tag: "button",
        text: { tag: "plain_text", content: "Open app" },
        type: "default",
        behaviors: [{ type: "open_url", default_url: "https://example.com/app" }],
      },
    ]);
  });

  it("does not duplicate title-only presentation cards in the body fallback", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        presentation: {
          title: "Status",
          blocks: [],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    expect(card.header).toEqual({
      title: { tag: "plain_text", content: "Status" },
      template: "blue",
    });
    expect(requireRecord(card.body, "card body").elements).toEqual([
      {
        tag: "markdown",
        content: "",
      },
    ]);
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

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    expect(requireRecord(card.body, "card body").elements).toEqual([
      {
        tag: "markdown",
        content: "Pick one:\n- Option A",
      },
    ]);
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
    expect(resultDetails(result).messageId).toBe("om_media");
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

    const mediaArgs = requireRecord(
      mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
      "media args",
    );
    expect(mediaArgs.mediaUrl).toBe("https://example.com/reply.mp3");
    expect(mediaArgs.audioAsVoice).toBe(true);
  });

  it("reads messages", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_1",
      chatId: "oc_group_1",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "read",
      params: { messageId: "om_1", chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
    } as never);

    expect(getMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_1",
      accountId: undefined,
    });
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    const message = requireRecord(details.message, "read message");
    expect(message.messageId).toBe("om_1");
    expect(message.content).toBe("hello");
  });

  it("reads an explicit group target authorized only by groupAllowFrom", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_group_allow_from",
      chatId: "oc_group_allow_from",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "read",
        params: {
          messageId: "om_group_allow_from",
          chatId: "oc_group_allow_from",
        },
        cfg: {
          channels: {
            feishu: {
              appId: "cli_main",
              appSecret: "secret_main",
              groupPolicy: "allowlist",
              groupAllowFrom: ["oc_group_allow_from"],
            },
          },
        } as OpenClawConfig,
      } as never),
    ).resolves.toMatchObject({
      details: {
        ok: true,
        action: "read",
      },
    });
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_allow_from");
    expect(getMessageFeishuMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "open group policy",
      policy: { groupPolicy: "open" as const },
    },
    {
      name: "wildcard group allowlist",
      policy: {
        groupPolicy: "allowlist" as const,
        groupAllowFrom: ["*"],
      },
    },
  ])("classifies an explicit group target before reading under $name", async ({ policy }) => {
    getChatInfoMock.mockResolvedValueOnce({
      chat_id: "oc_open_group",
      chat_mode: "group",
      chat_type: "private",
    });
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_open_group",
      chatId: "oc_open_group",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "read",
        params: { messageId: "om_open_group", chatId: "oc_open_group" },
        cfg: {
          channels: {
            feishu: {
              appId: "cli_main",
              appSecret: "secret_main",
              dmPolicy: "pairing",
              ...policy,
            },
          },
        } as OpenClawConfig,
      } as never),
    ).resolves.toMatchObject({
      details: {
        ok: true,
        action: "read",
      },
    });
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_open_group");
    expect(getChatInfoMock.mock.invocationCallOrder[0]).toBeLessThan(
      getMessageFeishuMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("resolves an omitted message chat type before authorizing a group read", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_group",
      chatId: "oc_group_1",
      content: "hello",
      contentType: "text",
    });

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "read",
        params: { messageId: "om_group" },
        cfg: {
          channels: {
            feishu: {
              appId: "cli_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              dmPolicy: "pairing",
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "feishu",
          currentChannelId: "oc_group_1",
          currentChatType: "group",
        },
      } as never),
    ).resolves.toMatchObject({
      details: {
        ok: true,
        action: "read",
      },
    });
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
  });

  it("resolves private message visibility before applying read policy", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_private_group",
      chatId: "oc_group_1",
      chatType: "private",
      content: "hidden",
      contentType: "text",
    });

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "read",
        params: { messageId: "om_private_group" },
        cfg: {
          channels: {
            feishu: {
              appId: "cli_main",
              appSecret: "secret_main",
              groupPolicy: "disabled",
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "feishu",
          currentChannelId: "oc_group_1",
          currentChatType: "direct",
        },
      } as never),
    ).rejects.toThrow("Feishu read target is not allowed.");
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
  });

  it("returns an error result when message reads fail", async () => {
    getMessageFeishuMock.mockResolvedValueOnce(null);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "read",
      params: { messageId: "om_missing", chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
    } as never);

    expect((result as { isError?: boolean } | undefined)?.isError).toBe(true);
    expect(result?.details).toEqual({
      error: "Feishu read failed or message not found: om_missing",
    });
  });

  it("edits messages", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_2",
      chatId: "oc_group_1",
      chatType: "group",
      content: "before",
      contentType: "text",
    });
    editMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_2", contentType: "post" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "edit",
      params: { messageId: "om_2", text: "updated" },
      cfg,
      accountId: undefined,
      conversationReadOrigin: "direct-operator",
    } as never);

    expect(editMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_2",
      text: "updated",
      card: undefined,
      accountId: undefined,
    });
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.messageId).toBe("om_2");
    expect(details.contentType).toBe("post");
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
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.action).toBe("thread-reply");
    expect(details.messageId).toBe("om_reply");
  });

  it("auto-threads `send` text against the inbound trigger in group_topic sessions", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_topic", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", text: "topic reply" },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
      toolContext: { currentMessageId: "om_inbound" },
    } as never);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "topic reply",
      accountId: undefined,
      replyToMessageId: "om_inbound",
      replyInThread: true,
    });
  });

  it("auto-threads `send` cards against the inbound trigger in group_topic sessions", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_topic_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        presentation: {
          title: "Topic update",
          blocks: [{ type: "text", text: "topic reply" }],
        },
      },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
      toolContext: { currentMessageId: "om_inbound" },
    } as never);

    const sendCardArgs = requireRecord(
      mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
      "send card args",
    );
    expect(sendCardArgs.replyToMessageId).toBe("om_inbound");
    expect(sendCardArgs.replyInThread).toBe(true);
  });

  it("auto-threads `send` media against the inbound trigger in group_topic sessions", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_topic_media",
      details: { messageId: "om_topic_media", chatId: "oc_group_1" },
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "topic reply",
        media: "/tmp/image.png",
      },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
      toolContext: { currentMessageId: "om_inbound" },
      mediaLocalRoots: ["/tmp"],
    } as never);

    const mediaArgs = requireRecord(
      mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
      "media args",
    );
    expect(mediaArgs.threadId).toBe("om_inbound");
    expect("replyToId" in mediaArgs).toBe(false);
  });

  it("auto-threads `send` in group_topic_sender sessions too", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_topic", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", text: "topic reply" },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound:sender:ou_user",
      toolContext: { currentMessageId: "om_inbound" },
    } as never);

    const sendArgs = requireRecord(
      mockCallArg(sendMessageFeishuMock, 0, 0, "sendMessageFeishu"),
      "send args",
    );
    expect(sendArgs.replyToMessageId).toBe("om_inbound");
    expect(sendArgs.replyInThread).toBe(true);
  });

  it("does not auto-thread `send` in plain group sessions (no topic)", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_plain", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", text: "plain group reply" },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1",
      toolContext: { currentMessageId: "om_inbound" },
    } as never);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "plain group reply",
      accountId: undefined,
      replyToMessageId: undefined,
      replyInThread: false,
    });
  });

  it("does not auto-thread `send` in group_topic when no inbound currentMessageId is available", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_topic", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", text: "topic reply" },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
      toolContext: {},
    } as never);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "topic reply",
      accountId: undefined,
      replyToMessageId: undefined,
      replyInThread: false,
    });
  });

  it("creates pins", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_pin",
      chatId: "oc_group_1",
      chatType: "group",
      content: "pin me",
      contentType: "text",
    });
    createPinFeishuMock.mockResolvedValueOnce({ messageId: "om_pin", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "pin",
      params: { messageId: "om_pin" },
      cfg,
      accountId: undefined,
      conversationReadOrigin: "direct-operator",
    } as never);

    expect(createPinFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_pin",
      accountId: undefined,
    });
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(requireRecord(details.pin, "pin").messageId).toBe("om_pin");
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
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    const pins = requireArray(details.pins, "pins");
    expect(requireRecord(pins[0], "pin").messageId).toBe("om_pin");
  });

  it("removes pins", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_pin",
      chatId: "oc_group_1",
      chatType: "group",
      content: "unpin me",
      contentType: "text",
    });
    const result = await feishuPlugin.actions?.handleAction?.({
      action: "unpin",
      params: { messageId: "om_pin" },
      cfg,
      accountId: undefined,
      conversationReadOrigin: "direct-operator",
    } as never);

    expect(removePinFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_pin",
      accountId: undefined,
    });
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.messageId).toBe("om_pin");
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
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    const channel = requireRecord(details.channel, "channel");
    expect(channel.chat_id).toBe("oc_group_1");
    expect(channel.name).toBe("Eng");
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
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    const members = requireArray(details.members, "members");
    const member = requireRecord(members[0], "member");
    expect(member.member_id).toBe("ou_1");
    expect(member.name).toBe("Alice");
  });

  it("fetches individual member info", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "ou_1", name: "Alice" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { memberId: "ou_1", chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "ou_1", "open_id");
    expect(assertFeishuChatMemberMock).toHaveBeenCalledWith(
      { tag: "client" },
      "oc_group_1",
      "ou_1",
      "open_id",
    );
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    const member = requireRecord(details.member, "member");
    expect(member.member_id).toBe("ou_1");
    expect(member.name).toBe("Alice");
  });

  it("uses the trusted sender identity for current direct-chat member info", async () => {
    getChatInfoMock.mockResolvedValueOnce({
      chat_id: "oc_direct",
      chat_mode: "p2p",
      chat_type: "private",
    });
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "ou_sender", name: "Alice" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { memberId: "ou_sender", chatId: "oc_direct" },
      cfg,
      accountId: undefined,
      requesterAccountId: "default",
      requesterSenderId: "ou_sender",
      toolContext: {
        currentChannelProvider: "feishu",
        currentChannelId: "oc_direct",
      },
    } as never);

    expect(assertFeishuChatMemberMock).not.toHaveBeenCalled();
    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "ou_sender", "open_id");
    expect(resultDetails(result).ok).toBe(true);
  });

  it("preserves a trusted user_id for current direct-chat member info", async () => {
    getChatInfoMock.mockResolvedValueOnce({
      chat_id: "oc_direct",
      chat_mode: "p2p",
      chat_type: "private",
    });
    getFeishuMemberInfoMock.mockResolvedValueOnce({
      member_id: "u_mobile_only",
      member_id_type: "user_id",
      name: "Mobile User",
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { memberId: "u_mobile_only", chatId: "oc_direct" },
      cfg,
      accountId: undefined,
      requesterAccountId: "default",
      requesterSenderId: "u_mobile_only",
      toolContext: {
        currentChannelProvider: "feishu",
        currentChannelId: "oc_direct",
      },
    } as never);

    expect(assertFeishuChatMemberMock).not.toHaveBeenCalled();
    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith(
      { tag: "client" },
      "u_mobile_only",
      "user_id",
    );
    expect(resultDetails(result).ok).toBe(true);
  });

  it("rejects unrelated member lookups in current direct chats", async () => {
    getChatInfoMock.mockResolvedValueOnce({
      chat_id: "oc_direct",
      chat_mode: "p2p",
      chat_type: "private",
    });

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "member-info",
        params: { memberId: "ou_other", chatId: "oc_direct" },
        cfg,
        accountId: undefined,
        requesterAccountId: "default",
        requesterSenderId: "ou_sender",
        toolContext: {
          currentChannelProvider: "feishu",
          currentChannelId: "oc_direct",
        },
      } as never),
    ).rejects.toThrow("limited to the current sender");
    expect(getFeishuMemberInfoMock).not.toHaveBeenCalled();
  });

  it("infers user_id lookups from the userId alias", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "u_1", name: "Alice" });

    await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { userId: "u_1", chatId: "oc_group_1" },
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
      params: { userId: "u_1", memberIdType: "open_id", chatId: "oc_group_1" },
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
      accountId: undefined,
      fallbackToStatic: false,
      filter: expect.any(Function),
    });
    expect(listFeishuDirectoryPeersLiveMock).toHaveBeenCalledWith({
      cfg,
      query: "eng",
      limit: 5,
      accountId: undefined,
      fallbackToStatic: false,
    });
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    const groups = requireArray(details.groups, "groups");
    const peers = requireArray(details.peers, "peers");
    expect(requireRecord(groups[0], "group").id).toBe("oc_group_1");
    expect(requireRecord(peers[0], "peer").id).toBe("ou_1");
  });

  it("accepts plus-signed channel-list limits", async () => {
    listFeishuDirectoryGroupsLiveMock.mockResolvedValueOnce([{ kind: "group", id: "oc_group_1" }]);

    await feishuPlugin.actions?.handleAction?.({
      action: "channel-list",
      params: { query: "eng", limit: "+05", scope: "groups" },
      cfg,
      accountId: undefined,
    } as never);

    expect(listFeishuDirectoryGroupsLiveMock).toHaveBeenCalledWith({
      cfg,
      query: "eng",
      limit: 5,
      accountId: undefined,
      fallbackToStatic: false,
      filter: expect.any(Function),
    });
  });

  it("ignores malformed channel-list limits", async () => {
    listFeishuDirectoryGroupsLiveMock.mockResolvedValueOnce([{ kind: "group", id: "oc_group_1" }]);

    await feishuPlugin.actions?.handleAction?.({
      action: "channel-list",
      params: { query: "eng", limit: "-1", scope: "groups" },
      cfg,
      accountId: undefined,
    } as never);

    expect(listFeishuDirectoryGroupsLiveMock).toHaveBeenCalledWith({
      cfg,
      query: "eng",
      limit: undefined,
      accountId: undefined,
      fallbackToStatic: false,
      filter: expect.any(Function),
    });
  });

  it("ignores non-decimal Feishu action page sizes", async () => {
    getChatMembersMock.mockResolvedValueOnce({
      chat_id: "oc_group_1",
      members: [],
      has_more: false,
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { chatId: "oc_group_1", pageSize: "0x10" },
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

  it("adds a reaction after authorizing the direct operator's ID-only target", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_msg1",
      chatId: "oc_group_1",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "react",
      params: { messageId: "om_msg1", emoji: "THUMBSUP" },
      cfg,
      accountId: undefined,
      conversationReadOrigin: "direct-operator",
    } as never);

    expect(addReactionFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_msg1",
      emojiType: "THUMBSUP",
      accountId: undefined,
    });
    expect(resultDetails(result)).toMatchObject({ ok: true, added: "THUMBSUP" });
  });

  it("allows explicit clearAll=true when removing all bot reactions", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_msg1",
      chatId: "oc_group_1",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });
    listReactionsFeishuMock.mockResolvedValueOnce([
      { reactionId: "r1", operatorType: "app", operatorId: "cli_main" },
      { reactionId: "r2", operatorType: "app", operatorId: "cli_main" },
      { reactionId: "r-other-app", operatorType: "app", operatorId: "cli_other" },
      { reactionId: "r-user", operatorType: "user", operatorId: "ou_user" },
    ]);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "react",
      params: { messageId: "om_msg1", chatId: "oc_group_1", clearAll: true },
      cfg,
      accountId: undefined,
    } as never);

    expect(listReactionsFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_msg1",
      accountId: undefined,
    });
    expect(removeReactionFeishuMock).toHaveBeenCalledTimes(2);
    expect(removeReactionFeishuMock).toHaveBeenNthCalledWith(1, {
      cfg,
      messageId: "om_msg1",
      reactionId: "r1",
      accountId: undefined,
    });
    expect(removeReactionFeishuMock).toHaveBeenNthCalledWith(2, {
      cfg,
      messageId: "om_msg1",
      reactionId: "r2",
      accountId: undefined,
    });
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.removed).toBe(2);
  });

  it("removes an own reaction from an authorized Feishu message", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_msg1",
      chatId: "oc_group_1",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });
    listReactionsFeishuMock.mockResolvedValueOnce([
      { reactionId: "r-other", operatorType: "app", operatorId: "cli_other" },
      { reactionId: "r1", operatorType: "app", operatorId: "cli_main" },
    ]);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "react",
      params: {
        messageId: "om_msg1",
        chatId: "oc_group_1",
        emoji: "THUMBSUP",
        remove: true,
      },
      cfg,
      accountId: undefined,
    } as never);

    expect(removeReactionFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_msg1",
      reactionId: "r1",
      accountId: undefined,
    });
    expect(resultDetails(result)).toMatchObject({ ok: true, removed: "THUMBSUP" });
  });

  it("does not remove another app's matching reaction", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_msg1",
      chatId: "oc_group_1",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });
    listReactionsFeishuMock.mockResolvedValueOnce([
      { reactionId: "r-other", operatorType: "app", operatorId: "cli_other" },
      { reactionId: "r-user", operatorType: "user", operatorId: "ou_user" },
    ]);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "react",
      params: {
        messageId: "om_msg1",
        chatId: "oc_group_1",
        emoji: "THUMBSUP",
        remove: true,
      },
      cfg,
      accountId: undefined,
    } as never);

    expect(removeReactionFeishuMock).not.toHaveBeenCalled();
    expect(resultDetails(result)).toMatchObject({ ok: true, removed: null });
  });

  it("lists reactions from an authorized Feishu message", async () => {
    const reactions = [{ reactionId: "r1", operatorType: "app", operatorId: "cli_main" }];
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_msg1",
      chatId: "oc_group_1",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });
    listReactionsFeishuMock.mockResolvedValueOnce(reactions);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "reactions",
      params: { messageId: "om_msg1", chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
    } as never);

    expect(listReactionsFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_msg1",
      accountId: undefined,
    });
    expect(resultDetails(result)).toMatchObject({ ok: true, reactions });
  });

  it("resolves an omitted message chat type before clearing group reactions", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_msg1",
      chatId: "oc_group_1",
      content: "hello",
      contentType: "text",
    });
    listReactionsFeishuMock.mockResolvedValueOnce([]);

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "react",
        params: { messageId: "om_msg1", clearAll: true },
        cfg: {
          channels: {
            feishu: {
              appId: "cli_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              dmPolicy: "pairing",
              actions: { reactions: true },
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "feishu",
          currentChannelId: "oc_group_1",
          currentChatType: "group",
        },
      } as never),
    ).resolves.toMatchObject({
      details: {
        ok: true,
        removed: 0,
      },
    });
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
  });

  it.each([
    {
      name: "message reads",
      action: "read",
      params: { messageId: "om_blocked", chatId: "oc_blocked" },
    },
    {
      name: "message edits",
      action: "edit",
      params: { messageId: "om_blocked", chatId: "oc_blocked", text: "blocked" },
    },
    {
      name: "reaction addition",
      action: "react",
      params: { messageId: "om_blocked", chatId: "oc_blocked", emoji: "THUMBSUP" },
    },
    {
      name: "reaction removal",
      action: "react",
      params: {
        messageId: "om_blocked",
        chatId: "oc_blocked",
        emoji: "THUMBSUP",
        remove: true,
      },
    },
    {
      name: "reaction clearing",
      action: "react",
      params: { messageId: "om_blocked", chatId: "oc_blocked", clearAll: true },
    },
    {
      name: "reaction lookup",
      action: "reactions",
      params: { messageId: "om_blocked", chatId: "oc_blocked" },
    },
    {
      name: "pin creation",
      action: "pin",
      params: { messageId: "om_blocked", chatId: "oc_blocked" },
    },
    {
      name: "pin removal",
      action: "unpin",
      params: { messageId: "om_blocked", chatId: "oc_blocked" },
    },
    {
      name: "pin lookup",
      action: "list-pins",
      params: { chatId: "oc_blocked" },
    },
    {
      name: "channel info",
      action: "channel-info",
      params: { chatId: "oc_blocked" },
    },
    {
      name: "member info",
      action: "member-info",
      params: { chatId: "oc_blocked", memberId: "ou_blocked" },
    },
  ])("rejects blocked Feishu $name before provider content reads", async ({ action, params }) => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action,
        params,
        cfg: {
          channels: {
            feishu: {
              appId: "cli_main",
              appSecret: "secret_main",
              groupPolicy: "allowlist",
              groups: { oc_allowed: {} },
              actions: { reactions: true },
            },
          },
        } as OpenClawConfig,
      } as never),
    ).rejects.toThrow("Feishu read target is not allowed.");
    expect(getChatInfoMock).not.toHaveBeenCalled();
    expect(getMessageFeishuMock).not.toHaveBeenCalled();
    expect(listReactionsFeishuMock).not.toHaveBeenCalled();
    expect(addReactionFeishuMock).not.toHaveBeenCalled();
    expect(removeReactionFeishuMock).not.toHaveBeenCalled();
    expect(editMessageFeishuMock).not.toHaveBeenCalled();
    expect(createPinFeishuMock).not.toHaveBeenCalled();
    expect(removePinFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "message reads",
      action: "read",
      params: { messageId: "om_unknown", chatId: "oc_unknown" },
    },
    {
      name: "pin lookup",
      action: "list-pins",
      params: { chatId: "oc_unknown" },
    },
    {
      name: "channel info",
      action: "channel-info",
      params: { chatId: "oc_unknown" },
    },
    {
      name: "member info",
      action: "member-info",
      params: { chatId: "oc_unknown", memberId: "ou_unknown" },
    },
  ])(
    "does not expose failed metadata lookup details for ambiguous Feishu $name",
    async ({ action, params }) => {
      getChatInfoMock.mockRejectedValueOnce(new Error("chat not found"));

      await expect(
        feishuPlugin.actions?.handleAction?.({
          action,
          params,
          cfg: {
            channels: {
              feishu: {
                appId: "cli_main",
                appSecret: "secret_main",
                groupPolicy: "open",
                dmPolicy: "pairing",
              },
            },
          } as OpenClawConfig,
        } as never),
      ).rejects.toThrow("Feishu read target is not allowed.");

      expect(getChatInfoMock).toHaveBeenCalledOnce();
      expect(getMessageFeishuMock).not.toHaveBeenCalled();
      expect(listPinsFeishuMock).not.toHaveBeenCalled();
      expect(getChatMembersMock).not.toHaveBeenCalled();
      expect(assertFeishuChatMemberMock).not.toHaveBeenCalled();
      expect(getFeishuMemberInfoMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a Feishu message returned from a different chat than the authorized target", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_other",
      chatId: "oc_other",
      chatType: "group",
      content: "hidden",
      contentType: "text",
    });

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "reactions",
        params: { messageId: "om_other", chatId: "oc_allowed" },
        cfg: {
          channels: {
            feishu: {
              appId: "cli_main",
              appSecret: "secret_main",
              groupPolicy: "allowlist",
              groups: { oc_allowed: {} },
              actions: { reactions: true },
            },
          },
        } as OpenClawConfig,
      } as never),
    ).rejects.toThrow("Feishu message target is not allowed.");
    expect(getMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(listReactionsFeishuMock).not.toHaveBeenCalled();
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

    const mediaArgs = requireRecord(
      mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
      "media args",
    );
    expect(mediaArgs.to).toBe("chat:oc_group_1");
    expect(mediaArgs.mediaUrl).toBe("https://example.com/image.png");
    expect(resultDetails(result).messageId).toBe("om_media_only");
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

describe("feishuPlugin.threading.buildToolContext", () => {
  it("preserves the native chat id separately from the routable user target", () => {
    const build = feishuPlugin.threading?.buildToolContext;
    if (!build) {
      throw new Error("Feishu threading.buildToolContext unavailable");
    }

    expect(
      build({
        cfg: {} as OpenClawConfig,
        context: {
          To: "user:ou_sender",
          NativeChannelId: "oc_direct_chat",
          ChatType: "direct",
        },
      }),
    ).toMatchObject({
      currentChannelId: "oc_direct_chat",
      currentChatType: "direct",
      currentMessagingTarget: "user:ou_sender",
    });
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
