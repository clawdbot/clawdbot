// Feishu tests cover channel plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuPlugin } from "./channel.js";
import { FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER } from "./outbound.js";
import { looksLikeFeishuId, normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";

describe("feishu target classification", () => {
  it("distinguishes users from chats", () => {
    expect(feishuPlugin.messaging?.inferTargetChatType?.({ to: "ou_owner" })).toBe("direct");
    expect(feishuPlugin.messaging?.inferTargetChatType?.({ to: "oc_group" })).toBe("group");
  });
});

const probeFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const addReactionFeishuMock = vi.hoisted(() => vi.fn());
const listReactionsFeishuMock = vi.hoisted(() => vi.fn());
const removeReactionFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendStickerFeishuMock = vi.hoisted(() => vi.fn());
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
const feishuOutboundSendTextMock = vi.hoisted(() => vi.fn());
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
    sendStickerFeishu: sendStickerFeishuMock,
    feishuOutbound: {
      sendText: feishuOutboundSendTextMock,
      sendMedia: feishuOutboundSendMediaMock,
      sendPayload: feishuOutboundSendPayloadMock,
    },
  },
}));

function describeFeishuMessageTool(cfg: OpenClawConfig, accountId?: string) {
  return feishuPlugin.actions?.describeMessageTool?.({ cfg, accountId });
}

function getDescribedActions(cfg: OpenClawConfig, accountId?: string): string[] {
  return [...(describeFeishuMessageTool(cfg, accountId)?.actions ?? [])];
}

type FeishuSecretProviderConfig = NonNullable<
  NonNullable<OpenClawConfig["secrets"]>["providers"]
>[string];

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

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

function mockFeishuOutboundTextDelivery(messageId: string, chatId = "oc_group_1") {
  feishuOutboundSendTextMock.mockResolvedValueOnce({
    channel: "feishu",
    messageId,
    target: { kind: "chat", id: chatId },
  });
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

describe("feishuPlugin config", () => {
  it.each([
    {
      accountId: "default",
      expected: { enabled: false },
    },
    {
      accountId: "ops",
      expected: { accounts: { ops: { enabled: false } } },
    },
  ])(
    "writes $accountId account enablement in the shared hybrid shape",
    ({ accountId, expected }) => {
      const setAccountEnabled = feishuPlugin.config.setAccountEnabled;
      if (!setAccountEnabled) {
        throw new Error("Feishu setAccountEnabled unavailable");
      }

      expect(setAccountEnabled({ cfg: {}, accountId, enabled: false }).channels?.feishu).toEqual(
        expected,
      );
    },
  );
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

  it.each([
    {
      name: "selected env default shadows file provider",
      provider: { source: "file", path: "/unused" },
      allowed: true,
    },
    {
      name: "non-default file provider",
      provider: { source: "file", path: "/unused" },
      defaultEnv: "other-env",
      allowed: false,
    },
    {
      name: "default provider allowlist exclusion",
      provider: { source: "env", allowlist: ["OTHER_FEISHU_SECRET"] },
      allowed: false,
    },
    {
      name: "allowlisted default env provider",
      provider: { source: "env", allowlist: ["FEISHU_DISCOVERY_SECRET"] },
      allowed: true,
    },
  ] satisfies Array<{
    name: string;
    provider: FeishuSecretProviderConfig;
    defaultEnv?: string;
    allowed: boolean;
  }>)(
    "enforces root SecretRef policy during discovery: $name",
    ({ provider, defaultEnv = "corp-env", allowed }) => {
      vi.stubEnv("FEISHU_DISCOVERY_SECRET", "ambient-secret");
      try {
        const discovery = describeFeishuMessageTool({
          secrets: {
            defaults: { env: defaultEnv },
            providers: { "corp-env": provider },
          },
          channels: {
            feishu: {
              enabled: true,
              appId: "cli_main",
              appSecret: { source: "env", provider: "corp-env", id: "FEISHU_DISCOVERY_SECRET" },
            },
          },
        });

        expect(discovery?.capabilities).toEqual(allowed ? ["presentation"] : []);
        if (allowed) {
          expect(discovery?.actions).toContain("send");
        } else {
          expect(discovery?.actions).toEqual([]);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("declares native chat IDs as delivery targets for guarded message mutations", () => {
    for (const action of ["edit", "pin", "unpin"] as const) {
      expect(feishuPlugin.actions?.messageActionTargetAliases?.[action]).toEqual({
        aliases: ["messageId", "chatId", "chat_id", "channel_id"],
        deliveryTargetAliases: ["chatId", "chat_id", "channel_id"],
      });
    }
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
    mockFeishuOutboundTextDelivery("om_sent");

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", message: "hello" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(feishuOutboundSendTextMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "hello",
      accountId: undefined,
      mediaLocalRoots: undefined,
      replyToId: undefined,
    });
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.messageId).toBe("om_sent");
    expect(details.chatId).toBe("oc_group_1");
  });

  it("advertises stickers only for enabled, configured accounts that opt in", async () => {
    const stickerCfg = {
      channels: {
        feishu: {
          actions: { sticker: true },
          accounts: {
            work: { appId: "cli_work", appSecret: "secret_work" },
            off: { appId: "cli_off", appSecret: "secret_off", actions: { sticker: false } },
            disabled: { appId: "cli_disabled", appSecret: "secret_disabled", enabled: false },
            unconfigured: {},
          },
        },
      },
    } satisfies OpenClawConfig;
    expect(getDescribedActions(cfg)).not.toContain("sticker");
    expect(getDescribedActions(stickerCfg)).toContain("sticker");
    expect(getDescribedActions(stickerCfg, "work")).toContain("sticker");
    expect(
      feishuPlugin.agentPrompt
        ?.messageToolHints?.({ cfg: stickerCfg, accountId: "work" })
        ?.join("\n"),
    ).toContain("fileId");
    for (const accountId of ["off", "disabled", "unconfigured"]) {
      expect(getDescribedActions(stickerCfg, accountId)).not.toContain("sticker");
      expect(
        feishuPlugin.agentPrompt?.messageToolHints?.({ cfg: stickerCfg, accountId })?.join("\n"),
      ).not.toContain("fileId");
      await expect(
        feishuPlugin.actions!.handleAction!({
          channel: "feishu",
          action: "sticker",
          params: { to: "oc_group_1", fileId: "file_sticker" },
          cfg: stickerCfg,
          accountId,
        }),
      ).rejects.toThrow("actions.sticker");
    }
    expect(sendStickerFeishuMock).not.toHaveBeenCalled();
  });

  describe("sticker-search", () => {
    const catalog = {
      file_work: ["Thumbs Up", "赞👍", "thumbs up again"],
      file_wave: ["Wave.*", "你好👋"],
    };
    const stickerCfg = {
      channels: {
        feishu: {
          defaultAccount: "work",
          actions: { sticker: true },
          stickerSets: {
            bot_work: catalog,
            bot_other: { file_other: ["赞👍"] },
          },
          accounts: {
            work: { appId: "bot_work", appSecret: "secret_work" },
            renamed: { appId: "bot_work", appSecret: "rotated_secret" },
            other: { appId: "bot_other", appSecret: "secret_other" },
            missing: { appId: "bot_missing", appSecret: "secret_missing" },
            off: { appId: "bot_work", appSecret: "secret_work", actions: { sticker: false } },
            replaced: { appId: "bot_work", appSecret: "secret_work", actions: { reactions: true } },
            disabled: { appId: "bot_work", appSecret: "secret_work", enabled: false },
            unconfigured: { appId: "bot_work" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const search = (
      params: Record<string, unknown>,
      accountId?: string,
      config: OpenClawConfig = stickerCfg,
    ) =>
      feishuPlugin.actions!.handleAction!({
        channel: "feishu",
        action: "sticker-search",
        cfg: config,
        accountId,
        params,
      });

    it("advertises configured keyword lookup only for an enabled selected bot", async () => {
      expect(getDescribedActions(stickerCfg, "work")).toContain("sticker-search");
      const hints = feishuPlugin.agentPrompt
        ?.messageToolHints?.({ cfg: stickerCfg, accountId: "work" })
        ?.join("\n");
      expect(hints).toContain("sticker-search");
      expect(hints).toContain("configured keyword");
      for (const accountId of ["off", "replaced", "disabled", "unconfigured"]) {
        expect(getDescribedActions(stickerCfg, accountId)).not.toContain("sticker-search");
        expect(
          feishuPlugin.agentPrompt?.messageToolHints?.({ cfg: stickerCfg, accountId })?.join("\n"),
        ).not.toContain("sticker-search");
        await expect(search({ query: "赞" }, accountId)).rejects.toThrow("actions.sticker");
      }
      const disabled = { channels: { feishu: { ...stickerCfg.channels.feishu, enabled: false } } };
      expect(getDescribedActions(disabled, "work")).not.toContain("sticker-search");
      await expect(search({ query: "赞" }, "work", disabled)).rejects.toThrow("actions.sticker");
      expect(createFeishuClientMock).not.toHaveBeenCalled();
    });

    it.each([undefined, {}, { bot_work: {} }, { bot_other: catalog }])(
      "rejects missing or empty matching catalogs: %j",
      async (stickerSets) => {
        const config = { channels: { feishu: { ...stickerCfg.channels.feishu, stickerSets } } };
        expect(getDescribedActions(config, "work")).not.toContain("sticker-search");
        expect(getDescribedActions(config)).not.toContain("sticker-search");
        await expect(search({ query: "赞" }, "work", config)).rejects.toThrow("stickerSets");
      },
    );

    it("does not inherit another bot catalog or prototype property", async () => {
      const config = {
        channels: {
          feishu: {
            ...stickerCfg.channels.feishu,
            stickerSets: Object.create({ bot_work: catalog }),
          },
        },
      };
      expect(getDescribedActions(config, "work")).not.toContain("sticker-search");
      await expect(search({ query: "赞" }, "work", config)).rejects.toThrow("stickerSets");
      await expect(search({ query: "赞" }, "missing")).rejects.toThrow("stickerSets");
    });

    it.each([
      [" thUMbs ", [{ fileId: "file_work", keyword: "Thumbs Up" }]],
      ["赞", [{ fileId: "file_work", keyword: "赞👍" }]],
      ["👋", [{ fileId: "file_wave", keyword: "你好👋" }]],
      [".*", [{ fileId: "file_wave", keyword: "Wave.*" }]],
      ["not present", []],
      ["x".repeat(128), []],
      ["👍".repeat(128), []],
    ])("matches literal operator keywords for %s", async (query, stickers) => {
      expect(resultDetails(await search({ query }))).toEqual({ stickers, truncated: false });
      expect(createFeishuClientMock).not.toHaveBeenCalled();
    });

    it("binds catalogs to bot identity across account rename, secret rotation, and bot replacement", async () => {
      for (const accountId of ["work", "renamed"]) {
        expect(resultDetails(await search({ query: "赞" }, accountId)).stickers).toEqual([
          { fileId: "file_work", keyword: "赞👍" },
        ]);
      }
      expect(resultDetails(await search({ query: "赞" }, "other")).stickers).toEqual([
        { fileId: "file_other", keyword: "赞👍" },
      ]);
      const config = {
        channels: {
          feishu: {
            ...stickerCfg.channels.feishu,
            accounts: { work: { appId: "replacement", appSecret: "secret_new" } },
          },
        },
      };
      expect(getDescribedActions(config)).not.toContain("sticker-search");
      await expect(search({ query: "赞" }, "work", config)).rejects.toThrow("stickerSets");
    });

    it.each([
      {},
      { query: "" },
      { query: "  " },
      { query: 1 },
      { query: null },
      { query: "x".repeat(129) },
      { query: "👍".repeat(129) },
      { query: "e" + "\u0301".repeat(128) },
      { query: "\ud800" },
    ])("rejects invalid query %j", async (params) => {
      await expect(search(params)).rejects.toThrow("query");
    });

    it.each([null, "", "5", "2junk", 0, -1, 1.5, 11, Number.NaN, Infinity, true])(
      "rejects invalid limit %j",
      async (limit) => {
        await expect(search({ query: "赞", limit })).rejects.toThrow("limit");
      },
    );

    it.each([undefined, 1, 10])(
      "preserves configured order and reports limit truncation for %j",
      async (limit) => {
        const entries = Array.from({ length: 11 }, (_, index) => ({
          fileKey: `file_${index}`,
          keywords: ["match"],
        }));
        const config = {
          channels: {
            feishu: {
              ...stickerCfg.channels.feishu,
              stickerSets: {
                bot_work: Object.fromEntries(
                  entries.map(({ fileKey, keywords }) => [fileKey, keywords]),
                ),
              },
            },
          },
        };
        const details = resultDetails(await search({ query: "match", limit }, "work", config));
        expect(details).toEqual({
          stickers: entries
            .slice(0, limit ?? 5)
            .map((entry) => ({ fileId: entry.fileKey, keyword: "match" })),
          truncated: true,
        });
      },
    );

    it.each([
      { unit: "👍", keyword: "👍".repeat(64) },
      { unit: "界", keyword: "赞".repeat(64) },
      { unit: "e\u0301", keyword: "e\u0301".repeat(32) },
      { unit: "👍", keyword: "\u0001".repeat(64) },
    ])("keeps maximum scalar matches within 3KiB: %j", async ({ unit, keyword }) => {
      const entries = Array.from(
        { length: 8 },
        (_, index) =>
          [
            Array.from(unit.repeat(512)).slice(0, 511).join("") +
              String.fromCodePoint(0x1f600 + index),
            [keyword],
          ] as const,
      );
      for (const count of [1, 8]) {
        const config = {
          channels: {
            feishu: {
              ...stickerCfg.channels.feishu,
              stickerSets: { bot_work: Object.fromEntries(entries.slice(0, count)) },
            },
          },
        };
        const result = await search({ query: keyword, limit: 10 }, "work", config);
        const details = resultDetails(result);
        const stickers = requireArray(details.stickers, "stickers");
        expect(stickers.length).toBeGreaterThan(0);
        expect(stickers).toEqual(
          entries.slice(0, stickers.length).map(([fileId]) => ({ fileId, keyword })),
        );
        expect(details.truncated).toBe(count > 1);
        if (count > 1) {
          expect(stickers.length).toBeLessThan(count);
        }
        expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(3072);
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details) }]);
      }
    });

    it("passes a search result directly into sticker dispatch on the same account", async () => {
      const details = resultDetails(await search({ query: "赞" }, "renamed"));
      const match = requireRecord(requireArray(details.stickers, "stickers")[0], "sticker");
      sendStickerFeishuMock.mockResolvedValueOnce({
        messageId: "om_sticker",
        chatId: "oc_group_1",
      });
      await feishuPlugin.actions!.handleAction!({
        channel: "feishu",
        action: "sticker",
        cfg: stickerCfg,
        accountId: "renamed",
        params: { ...match, to: "oc_group_1" },
      });
      expect(sendStickerFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({ fileKey: "file_work", accountId: "renamed", to: "oc_group_1" }),
      );
    });
  });

  it.each([
    { params: { fileId: " file_sticker " }, replyToMessageId: undefined, replyInThread: false },
    {
      params: { stickerId: ["file_sticker", "file_other"] },
      replyToMessageId: undefined,
      replyInThread: false,
    },
    {
      params: { fileId: "file_sticker", replyTo: "om_parent" },
      replyToMessageId: "om_parent",
      replyInThread: false,
    },
    {
      params: { fileId: "file_sticker", threadId: "om_thread", topLevel: true },
      replyToMessageId: "om_thread",
      replyInThread: true,
    },
    {
      params: { fileId: "file_sticker", replyTo: "om_parent" },
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
      replyToMessageId: "om_parent",
      replyInThread: false,
    },
    {
      params: { fileId: "file_sticker" },
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
      replyToMessageId: "om_inbound",
      replyInThread: true,
    },
  ])(
    "sends received sticker keys with account and reply routing: %j",
    async ({ params, sessionKey, replyToMessageId, replyInThread }) => {
      const stickerCfg = {
        channels: {
          feishu: {
            accounts: {
              work: {
                appId: "cli_work",
                appSecret: "secret_work",
                actions: { sticker: true },
              },
            },
          },
        },
      } satisfies OpenClawConfig;
      sendStickerFeishuMock.mockResolvedValueOnce({
        messageId: "om_sticker",
        chatId: "oc_group_1",
      });
      const result = await feishuPlugin.actions!.handleAction!({
        channel: "feishu",
        action: "sticker",
        params,
        cfg: stickerCfg,
        accountId: "work",
        sessionKey,
        toolContext: { currentChannelId: "oc_group_1", currentMessageId: "om_inbound" },
      });
      expect(sendStickerFeishuMock).toHaveBeenCalledWith({
        cfg: stickerCfg,
        to: "oc_group_1",
        fileKey: "file_sticker",
        accountId: "work",
        replyToMessageId,
        replyInThread,
      });
      expect(resultDetails(result)).toMatchObject({
        ok: true,
        action: "sticker",
        messageId: "om_sticker",
      });
    },
  );

  it.each([{}, { fileId: "../bad" }, { stickerId: [] }])(
    "rejects a missing or invalid sticker key before dispatch: %j",
    async (params) => {
      const stickerCfg = {
        channels: {
          feishu: {
            appId: "cli_main",
            appSecret: "secret_main",
            actions: { sticker: true },
          },
        },
      } satisfies OpenClawConfig;
      await expect(
        feishuPlugin.actions!.handleAction!({
          channel: "feishu",
          action: "sticker",
          params: { to: "oc_group_1", ...params },
          cfg: stickerCfg,
        }),
      ).rejects.toThrow("previously received");
      expect(sendStickerFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "over-limit rich posts",
      action: "send",
      text: "明".repeat(11_000),
      renderMode: "raw",
    },
    {
      name: "configured card rendering",
      action: "send",
      text: "Render this as a card",
      renderMode: "card",
    },
    {
      name: "thread-preserving rich-post fanout",
      action: "thread-reply",
      text: "明".repeat(11_000),
      renderMode: "raw",
    },
  ] as const)("uses canonical outbound text delivery for $name", async (scenario) => {
    const actionCfg = {
      ...cfg,
      channels: {
        ...cfg.channels,
        feishu: { ...cfg.channels?.feishu, renderMode: scenario.renderMode },
      },
    } as OpenClawConfig;
    feishuOutboundSendTextMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_outbound",
      target: { kind: "chat", id: "oc_provider_authoritative" },
    });
    if (scenario.renderMode === "raw") {
      sendMessageFeishuMock.mockImplementationOnce(async (params) => {
        const { sendMessageFeishu } =
          await vi.importActual<typeof import("./send.js")>("./send.js");
        return await sendMessageFeishu(params);
      });
    } else {
      sendMessageFeishuMock.mockResolvedValueOnce({
        messageId: "om_bypassed_owner",
        chatId: "oc_group_1",
      });
    }

    const result = await feishuPlugin.actions?.handleAction?.({
      action: scenario.action,
      params: {
        to: "chat:oc_requested_alias",
        text: scenario.text,
        ...(scenario.action === "thread-reply" ? { messageId: "om_parent" } : {}),
      },
      cfg: actionCfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(feishuOutboundSendTextMock).toHaveBeenCalledWith({
      cfg: actionCfg,
      to: "chat:oc_requested_alias",
      text: scenario.text,
      accountId: undefined,
      mediaLocalRoots: undefined,
      ...(scenario.action === "thread-reply"
        ? { threadId: "om_parent" }
        : { replyToId: undefined }),
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(resultDetails(result)).toMatchObject({
      ok: true,
      action: scenario.action,
      messageId: "om_outbound",
      chatId: "oc_provider_authoritative",
    });
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
        channels: undefined,
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
    mockFeishuOutboundTextDelivery("om_sent");
    const message = JSON.stringify({ ok: true, elements: "not-a-card" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", message },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendTextMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: message,
      accountId: undefined,
      mediaLocalRoots: undefined,
      replyToId: undefined,
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
    const trustedReadFile = vi.fn(async () => Buffer.from("approved image"));
    const legacyReadFile = vi.fn(async () => Buffer.from("legacy image"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile: trustedReadFile,
    };
    const forgedMediaAccess = {
      localRoots: ["/forged/workspace"],
      workspaceDir: "/forged/workspace",
    };
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
        media: "pipeline.png",
        mediaAccess: forgedMediaAccess,
        mediaLocalRoots: ["/forged/workspace"],
        mediaReadFile: vi.fn(),
      },
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          feishu: { ...cfg.channels?.feishu, responsePrefix: "[Nexus]" },
        },
      },
      accountId: undefined,
      toolContext: {},
      mediaAccess,
      mediaLocalRoots: ["/legacy/workspace"],
      mediaReadFile: legacyReadFile,
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
    expect(fallbackPayload.mediaUrl).toBe("pipeline.png");
    expect(fallbackPayload.text).toBeUndefined();
    expect(fallbackArgs.text).toBe("");
    expect(fallbackArgs.mediaAccess).toBe(mediaAccess);
    expect(fallbackArgs.mediaAccess).not.toBe(forgedMediaAccess);
    expect(fallbackArgs.mediaLocalRoots).toEqual(["/legacy/workspace"]);
    expect(fallbackArgs.mediaReadFile).toBe(legacyReadFile);
  });

  // Regression for #112244 (third-review P1): when a direct `send` attachment
  // routes through the presentation-fallback path (card falls back to text),
  // an upload failure must still surface as a visible error instead of an
  // `ok:true` receipt for a text-only fallback. The action stamps the
  // propagate marker on channelData.feishu so sendFeishuFallbackPayload
  // re-throws; here we verify the marker is stamped and the failure rejects.
  it("propagates a media-upload failure on the send presentation-fallback path instead of returning ok:true", async () => {
    feishuOutboundSendPayloadMock.mockRejectedValueOnce(new Error("upload failed"));
    const trustedReadFile = vi.fn(async () => Buffer.from("approved image"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile: trustedReadFile,
    };
    // An oversized table falls outside the Feishu card envelope, so
    // `presentationFellBack` is true and the direct send routes the attachment
    // through sendPayload instead of the normal sendMedia branch.
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

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "send",
        params: {
          to: "chat:oc_group_1",
          message: `[Nexus] ${rawCardText}`,
          presentation,
          media: "pipeline.png",
        },
        cfg: {
          ...cfg,
          channels: {
            ...cfg.channels,
            feishu: { ...cfg.channels?.feishu, responsePrefix: "[Nexus]" },
          },
        },
        accountId: undefined,
        toolContext: {},
        mediaAccess,
        mediaLocalRoots: ["/approved/workspace"],
        mediaReadFile: trustedReadFile,
      } as never),
    ).rejects.toThrow("upload failed");

    expect(feishuOutboundSendPayloadMock).toHaveBeenCalledTimes(1);
    const fallbackArgs = requireRecord(
      mockCallArg(feishuOutboundSendPayloadMock, 0, 0, "feishuOutbound.sendPayload"),
      "fallback args",
    );
    const fallbackPayload = requireRecord(fallbackArgs.payload, "fallback payload");
    const feishuChannelData = requireRecord(
      requireRecord(fallbackPayload.channelData, "fallback channelData").feishu,
      "fallback channelData.feishu",
    );
    expect(feishuChannelData[FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER]).toBe(true);
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

  it.each(
    ["send", "thread-reply"].flatMap((action) =>
      ["alone", "with text", "with native buttons"].map((layout) => ({ action, layout })),
    ),
  )("preserves unsupported button labels $layout on $action", async ({ action, layout }) => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action,
      params: {
        to: "chat:oc_group_1",
        ...(action === "thread-reply" ? { messageId: "om_root" } : {}),
        ...(layout === "with text" ? { text: "Choose an action" } : {}),
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Inspect", action: { type: "callback", value: "inspect:123" } },
                ...(layout === "with native buttons"
                  ? [
                      { label: "Help", action: { type: "command", command: "/help" } },
                      {
                        label: "Details <one> & more",
                        action: { type: "callback", value: "/opaque-details" },
                      },
                      { label: "Docs", action: { type: "url", url: "https://example.com" } },
                    ]
                  : []),
              ],
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
      ...(layout === "with text" ? [{ tag: "markdown", content: "Choose an action" }] : []),
      { tag: "markdown", content: "- Inspect" },
      ...(layout === "with native buttons"
        ? [
            expect.objectContaining({
              tag: "button",
              text: { tag: "plain_text", content: "Help" },
              behaviors: [
                {
                  type: "callback",
                  value: { oc: "ocf1", k: "quick", a: "feishu.payload.button", q: "/help" },
                },
              ],
            }),
            { tag: "markdown", content: "- Details &lt;one&gt; &amp; more" },
            expect.objectContaining({
              tag: "button",
              text: { tag: "plain_text", content: "Docs" },
              behaviors: [{ type: "open_url", default_url: "https://example.com" }],
            }),
          ]
        : []),
    ]);
  });

  it.each(["send", "thread-reply"])(
    "keeps disabled command and link buttons non-interactive on %s",
    async (action) => {
      sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });
      await feishuPlugin.actions?.handleAction?.({
        action,
        params: {
          to: "chat:oc_group_1",
          ...(action === "thread-reply" ? { messageId: "om_root" } : {}),
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Unavailable [command](https://example.com/label)",
                    disabled: true,
                    action: { type: "command", command: "/help" },
                  },
                  {
                    label: "Unavailable link",
                    disabled: true,
                    action: { type: "url", url: "https://example.com" },
                  },
                ],
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
          content: "- Unavailable \\[command\\]\\(https://example.com/label\\)",
        },
        { tag: "markdown", content: "- Unavailable link" },
      ]);
    },
  );

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

  it.each(["send", "thread-reply"] as const)(
    "preserves select commands in the %s card fallback without exposing callback values",
    async (action) => {
      sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

      await feishuPlugin.actions?.handleAction?.({
        action,
        params: {
          to: "chat:oc_group_1",
          ...(action === "thread-reply" ? { messageId: "om_root" } : {}),
          presentation: {
            blocks: [
              {
                type: "select",
                placeholder: "Pick <one> & continue",
                options: [
                  { label: "Status <one>", action: { type: "command", command: "/status" } },
                  { label: "Callback", action: { type: "callback", value: "/opaque-callback" } },
                  { label: "Legacy", value: "/opaque-legacy" },
                ],
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
          content:
            "Pick &lt;one&gt; &amp; continue:\n- Status &lt;one&gt;: `/status`\n- Callback\n- Legacy",
        },
      ]);
    },
  );

  it.each(
    [
      { alias: "media", media: { media: "/tmp/media.png" }, expected: "/tmp/media.png" },
      { alias: "mediaUrl", media: { mediaUrl: "/tmp/media.png" }, expected: "/tmp/media.png" },
      { alias: "path", media: { path: "/tmp/script.py" }, expected: "/tmp/script.py" },
      { alias: "filePath", media: { filePath: "/tmp/script.py" }, expected: "/tmp/script.py" },
      {
        alias: "fileUrl",
        media: { fileUrl: "file:///tmp/script.py" },
        expected: "file:///tmp/script.py",
      },
      { alias: "image", media: { image: "/tmp/image.png" }, expected: "/tmp/image.png" },
      {
        alias: "mediaUrls",
        media: { mediaUrls: ["/tmp/media.png"] },
        expected: "/tmp/media.png",
      },
      { alias: "media_url", media: { media_url: "/tmp/media.png" }, expected: "/tmp/media.png" },
      { alias: "file_path", media: { file_path: "/tmp/script.py" }, expected: "/tmp/script.py" },
      {
        alias: "file_url",
        media: { file_url: "file:///tmp/script.py" },
        expected: "file:///tmp/script.py",
      },
      {
        alias: "media_urls",
        media: { media_urls: ["/tmp/media.png"] },
        expected: "/tmp/media.png",
      },
      {
        alias: "attachments[].filePath",
        media: { attachments: [{ filePath: "/tmp/script.py" }] },
        expected: "/tmp/script.py",
      },
      {
        alias: "attachments[].media_urls",
        media: { attachments: [{ media_urls: ["/tmp/media.png"] }] },
        expected: "/tmp/media.png",
      },
    ].flatMap((attachment) =>
      (["send", "thread-reply"] as const).map((action) => Object.assign({ action }, attachment)),
    ),
  )(
    "$action promotes attachment alias $alias to sendMedia",
    async ({ action, media, expected }) => {
      feishuOutboundSendMediaMock.mockResolvedValueOnce({
        channel: "feishu",
        messageId: "om_media",
        details: { messageId: "om_media", chatId: "oc_group_1" },
      });

      await feishuPlugin.actions?.handleAction?.({
        action,
        params: {
          to: "chat:oc_group_1",
          message: "see attached",
          ...(action === "thread-reply" ? { messageId: "om_parent" } : {}),
          ...media,
        },
        cfg,
        accountId: undefined,
        toolContext: {},
        mediaLocalRoots: ["/tmp"],
      } as never);

      expect(feishuOutboundSendMediaMock).toHaveBeenCalledOnce();
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      const mediaArgs = requireRecord(
        mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
        "outbound args",
      );
      expect(mediaArgs.mediaUrl).toBe(expected);
      expect(mediaArgs.threadId).toBe(action === "thread-reply" ? "om_parent" : undefined);
      expect(mediaArgs.propagateMediaUploadFailure).toBe(action === "send" ? true : undefined);
    },
  );

  it.each(["send", "thread-reply"] as const)(
    "rejects unsupported buffer payload on %s instead of text-only success",
    async (action) => {
      await expect(
        feishuPlugin.actions?.handleAction?.({
          action,
          params: {
            to: "chat:oc_group_1",
            message: "see attached",
            ...(action === "thread-reply" ? { messageId: "om_parent" } : {}),
            buffer: "aGVsbG8=",
          },
          cfg,
          accountId: undefined,
          toolContext: {},
          mediaLocalRoots: ["/tmp"],
        } as never),
      ).rejects.toThrow(
        "Feishu send supports media attachments through media, mediaUrl, path, filePath, fileUrl, image, mediaUrls, or attachments[] with one of those fields; buffer/base64 payloads are not supported.",
      );

      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
    },
  );

  it.each(["send", "thread-reply"] as const)(
    "rejects multiple media attachments on %s rather than dropping all but the first",
    async (action) => {
      await expect(
        feishuPlugin.actions?.handleAction?.({
          action,
          params: {
            to: "chat:oc_group_1",
            message: "see attached",
            ...(action === "thread-reply" ? { messageId: "om_parent" } : {}),
            mediaUrls: ["/tmp/first.png", "/tmp/second.png"],
          },
          cfg,
          accountId: undefined,
          toolContext: {},
          mediaLocalRoots: ["/tmp"],
        } as never),
      ).rejects.toThrow("Feishu send supports a single media attachment.");

      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["file_path", "/tmp/script.py"],
    ["media_url", "/tmp/media.png"],
    ["file_url", "file:///tmp/script.py"],
  ] as const)("promotes snake_case send attachment alias %s to sendMedia", async (key, value) => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_media",
      details: { messageId: "om_media", chatId: "oc_group_1" },
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "see attached",
        [key]: value,
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    const mediaArgs = requireRecord(
      mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
      "outbound args",
    );
    expect(mediaArgs.mediaUrl).toBe(value);
  });

  it("promotes media_urls snake_case array alias to sendMedia", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_media",
      details: { messageId: "om_media", chatId: "oc_group_1" },
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "see attached",
        media_urls: ["/tmp/report.md"],
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    const mediaArgs = requireRecord(
      mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
      "outbound args",
    );
    expect(mediaArgs.mediaUrl).toBe("/tmp/report.md");
  });

  it("accepts a single string mediaUrls value instead of dropping it", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_media",
      details: { messageId: "om_media", chatId: "oc_group_1" },
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "see attached",
        mediaUrls: "/tmp/single.png",
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    const mediaArgs = requireRecord(
      mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
      "outbound args",
    );
    expect(mediaArgs.mediaUrl).toBe("/tmp/single.png");
  });

  // Regression for #112244 (ClawSweeper P1): a valid nested
  // `attachments[].mediaUrls` string list must be collected as a media
  // candidate, not just validated for malformed entries. Without this the
  // request would fall through to a text-only `ok:true` — the silent drop the
  // PR removes.
  it("accepts a nested attachments[].mediaUrls list instead of dropping it", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_media",
      details: { messageId: "om_media", chatId: "oc_group_1" },
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "see attached",
        attachments: [{ mediaUrls: ["/tmp/nested.png"] }],
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    const mediaArgs = requireRecord(
      mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
      "outbound args",
    );
    expect(mediaArgs.mediaUrl).toBe("/tmp/nested.png");
  });

  // `attachments[].image` must be collected as a media candidate just like the
  // top-level `image` alias. Without this the request would fall through to a
  // text-only `ok:true` — the silent drop the PR removes.
  it("accepts a nested attachments[].image alias instead of dropping it", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_media_image",
      details: { messageId: "om_media_image", chatId: "oc_group_1" },
    });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "see attached image",
        attachments: [{ image: "/tmp/nested-image.png" }],
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    const mediaArgs = requireRecord(
      mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
      "outbound args",
    );
    expect(mediaArgs.mediaUrl).toBe("/tmp/nested-image.png");
  });

  it.each(["buffer", "base64"] as const)(
    "rejects nested %s attachment payload on send instead of text-only success",
    async (field) => {
      await expect(
        feishuPlugin.actions?.handleAction?.({
          action: "send",
          params: {
            to: "chat:oc_group_1",
            message: "see attached",
            attachments: [{ [field]: "aGVsbG8=", filename: "report.md" }],
          },
          cfg,
          accountId: undefined,
          toolContext: {},
          mediaLocalRoots: ["/tmp"],
        } as never),
      ).rejects.toThrow("buffer/base64 payloads are not supported");

      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
    },
  );

  it("rejects mixed supported and nested unsupported attachment payloads on send", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "send",
        params: {
          to: "chat:oc_group_1",
          message: "see attached",
          attachments: [
            { filePath: "/tmp/report.md" },
            { buffer: "aGVsbG8=", filename: "report-copy.md" },
          ],
        },
        cfg,
        accountId: undefined,
        toolContext: {},
        mediaLocalRoots: ["/tmp"],
      } as never),
    ).rejects.toThrow("buffer/base64 payloads are not supported");

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
  });

  // The linked issue's literal reproduction is `{ message, file: "/path" }`.
  // `file` is an attachment-intent key the Feishu send path does not map to a
  // media source, so it must fail visibly instead of returning ok:true on a
  // text-only send (issue #112244 expected behavior).
  it.each([
    { location: "top-level", params: { file: "/tmp/script.py", filename: "script.py" } },
    { location: "nested", params: { attachments: [{ file: "/tmp/script.py" }] } },
  ])(
    "rejects $location `file` attachment intent on send instead of text-only success",
    async ({ params }) => {
      await expect(
        feishuPlugin.actions?.handleAction?.({
          action: "send",
          params: {
            to: "chat:oc_group_1",
            message: "here is the script",
            ...params,
          },
          cfg,
          accountId: undefined,
          toolContext: {},
          mediaLocalRoots: ["/tmp"],
        } as never),
      ).rejects.toThrow("`file` attachment-intent parameter is not supported");

      // No text-only send slips through with a false ok:true.
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
    },
  );

  // Regression for the eighteenth-review P1 finding: a present NON-string value
  // for an unsupported attachment-intent key (`file`/`buffer`/`base64`) used to
  // be silently skipped (readFeishuStringParam returns undefined for objects),
  // leaving no candidate and falling through to a text-only ok:true — the exact
  // silent-drop this PR removes. Post-fix the resolver rejects the malformed
  // intent before the text branch, at both the top level and inside attachments[].
  it.each([
    {
      label: "top-level `file: {}`",
      params: { file: {} },
      expectedError: "`file` attachment-intent parameter is not supported",
    },
    {
      label: "top-level `buffer: {}`",
      params: { buffer: {} },
      expectedError: "buffer/base64 payloads are not supported",
    },
    {
      label: "top-level `base64: {}`",
      params: { base64: {} },
      expectedError: "buffer/base64 payloads are not supported",
    },
    {
      label: "top-level `file: 42`",
      params: { file: 42 },
      expectedError: "`file` attachment-intent parameter is not supported",
    },
    {
      label: "nested `attachments: [{ file: {} }]`",
      params: { attachments: [{ file: {} }] },
      expectedError: "`file` attachment-intent parameter is not supported",
    },
    {
      label: "nested `attachments: [{ buffer: {} }]`",
      params: { attachments: [{ buffer: {} }] },
      expectedError: "buffer/base64 payloads are not supported",
    },
  ])(
    "rejects malformed (non-string) $label attachment intent on send instead of text-only success",
    async ({ params, expectedError }) => {
      await expect(
        feishuPlugin.actions?.handleAction?.({
          action: "send",
          params: {
            to: "chat:oc_group_1",
            message: "see attached",
            ...params,
          },
          cfg,
          accountId: undefined,
          toolContext: {},
          mediaLocalRoots: ["/tmp"],
        } as never),
      ).rejects.toThrow(expectedError);

      // No text-only send slips through with a false ok:true.
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
    },
  );

  it("ignores a blank `file` attachment intent field on send", async () => {
    mockFeishuOutboundTextDelivery("om_plain");

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "plain text",
        file: "   ",
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    // A blank `file` is not an attachment-intent signal; with no media alias
    // the send still takes the text-only success branch (unchanged).
    expect(feishuOutboundSendTextMock).toHaveBeenCalledOnce();
    expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
  });

  // Regression for the second-review P1 finding: a declared media source whose
  // value is present but malformed (e.g. `media: {}` or `mediaUrls: [{}]`)
  // expresses attachment intent the Feishu send path cannot represent. Treating
  // such a value as absent recreates the silent text-only `ok:true` success this
  // PR removes, so it must fail visibly before the text branch instead.
  it.each(
    [
      { location: "top-level scalar `media`", params: { media: {} } },
      { location: "top-level scalar `filePath`", params: { filePath: 42 } },
      { location: "top-level `mediaUrls` object", params: { mediaUrls: {} } },
      {
        location: "top-level `mediaUrls` array with non-string entry",
        params: { mediaUrls: [{}] },
      },
      {
        location: "top-level `mediaUrls` array with number entry",
        params: { mediaUrls: ["/tmp/a.png", 7] },
      },
      { location: "nested scalar `media`", params: { attachments: [{ media: {} }] } },
      {
        location: "nested `mediaUrls` with non-string entry",
        params: { attachments: [{ mediaUrls: [{}] }] },
      },
      // A declared `attachments` field that is not an array (an object container
      // whose nested media source is not a top-level alias) is an attachment
      // intent the resolver cannot promote; treating it as absent recreates the
      // silent text-only `ok:true` drop this PR removes (issue #112244, ClawSweeper P1).
      {
        location: "object `attachments` container",
        params: { attachments: { media: "/tmp/a.png" } },
      },
      // A non-record array entry is a declared attachment intent the resolver
      // cannot promote; skipping it silently would fall through to a text-only
      // success (issue #112244, ClawSweeper P1).
      { location: "`attachments` array with null entry", params: { attachments: [null] } },
      { location: "`attachments` array with non-record entry", params: { attachments: [42] } },
    ].flatMap((scenario) =>
      (["send", "thread-reply"] as const).map((action) => Object.assign({ action }, scenario)),
    ),
  )(
    "rejects $location malformed media source on $action instead of text-only success",
    async ({ action, params }) => {
      await expect(
        feishuPlugin.actions?.handleAction?.({
          action,
          params: {
            to: "chat:oc_group_1",
            message: "see attached",
            ...(action === "thread-reply" ? { messageId: "om_parent" } : {}),
            ...params,
          },
          cfg,
          accountId: undefined,
          toolContext: {},
          mediaLocalRoots: ["/tmp"],
        } as never),
      ).rejects.toThrow("a present malformed media source value is not supported");

      // No text-only send slips through with a false ok:true.
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { location: "blank scalar `media`", params: { media: "   " } },
    { location: "blank `mediaUrls` array entry", params: { mediaUrls: ["   "] } },
    {
      location: "blank nested `media`",
      params: { attachments: [{ media: "   " }] },
    },
  ])("ignores blank $location media source on send (not malformed)", async ({ params }) => {
    mockFeishuOutboundTextDelivery("om_plain");

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "plain text",
        ...params,
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    // A blank string is a string, not malformed; with no usable media it
    // still takes the text-only success branch (unchanged).
    expect(feishuOutboundSendTextMock).toHaveBeenCalledOnce();
    expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
  });

  it.each([
    { location: "top-level", params: { buffer: "", base64: "  " } },
    {
      location: "nested",
      params: { attachments: [{ buffer: "", base64: "  " }] },
    },
  ])("ignores blank $location attachment payload fields on send", async ({ params }) => {
    mockFeishuOutboundTextDelivery("om_plain");

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "plain text",
        ...params,
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    // Blank buffer/base64 is not an unsupported payload intent; with no media
    // alias the send still takes the text-only success branch (unchanged).
    expect(feishuOutboundSendTextMock).toHaveBeenCalledOnce();
    expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
  });

  it.each([
    { action: "send", kind: "media" },
    { action: "thread-reply", kind: "media" },
    { action: "send", kind: "text" },
    { action: "thread-reply", kind: "text" },
  ] as const)(
    "preserves only trusted workspace media access for $action $kind actions",
    async ({ action, kind }) => {
      const outboundSender =
        kind === "media" ? feishuOutboundSendMediaMock : feishuOutboundSendTextMock;
      outboundSender.mockResolvedValueOnce({
        channel: "feishu",
        messageId: "om_delivered",
        target: { kind: "chat", id: "oc_group_1" },
      });
      const trustedReadFile = vi.fn(async () => Buffer.from("approved image"));
      const legacyReadFile = vi.fn(async () => Buffer.from("legacy image"));
      const mediaAccess = {
        localRoots: ["/approved/workspace"],
        workspaceDir: "/approved/workspace",
        readFile: trustedReadFile,
      };
      const forgedMediaAccess = {
        localRoots: ["/forged/workspace"],
        workspaceDir: "/forged/workspace",
      };

      const result = await feishuPlugin.actions?.handleAction?.({
        action,
        params: {
          to: "chat:oc_group_1",
          message: "test",
          ...(kind === "media" ? { mediaUrl: "image.png" } : {}),
          mediaAccess: forgedMediaAccess,
          mediaLocalRoots: ["/forged/workspace"],
          mediaReadFile: vi.fn(),
          ...(action === "thread-reply" ? { messageId: "om_parent" } : {}),
        },
        cfg,
        accountId: undefined,
        toolContext: {},
        mediaAccess,
        mediaLocalRoots: ["/legacy/workspace"],
        mediaReadFile: legacyReadFile,
      } as never);

      expect(outboundSender).toHaveBeenCalledWith({
        cfg,
        to: "chat:oc_group_1",
        text: "test",
        ...(kind === "media" ? { mediaUrl: "image.png" } : {}),
        accountId: undefined,
        mediaAccess,
        mediaLocalRoots: ["/legacy/workspace"],
        mediaReadFile: legacyReadFile,
        ...(action === "thread-reply" ? { threadId: "om_parent" } : { replyToId: undefined }),
        // Only the direct `send` action propagates media-upload failures;
        // thread-reply keeps its existing fallback-text behavior for
        // compatibility (issue #112244).
        ...(action === "send" && kind === "media" ? { propagateMediaUploadFailure: true } : {}),
      });
      const outboundArgs = requireRecord(
        mockCallArg(
          outboundSender,
          0,
          0,
          `feishuOutbound.send${kind === "media" ? "Media" : "Text"}`,
        ),
        "outbound args",
      );
      expect(outboundArgs.mediaAccess).toBe(mediaAccess);
      expect(outboundArgs.mediaAccess).not.toBe(forgedMediaAccess);
      expect(resultDetails(result).messageId).toBe("om_delivered");
    },
  );

  // Regression for #112244 (round-5 P1): upload-failure propagation is scoped
  // to `send` only; a thread-reply whose media upload fails must keep its
  // existing fallback-text behavior (no throw), preserving compatibility.
  it("does not propagate media-upload failure for thread-reply (keeps fallback)", async () => {
    // sendMedia resolves to a text fallback result (the fallback path lives in
    // the outbound adapter; here we verify the action does not throw and does
    // not pass propagateMediaUploadFailure for thread-reply).
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_thread_fallback",
      details: { messageId: "om_thread_fallback", chatId: "oc_group_1" },
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "thread-reply",
      params: {
        to: "chat:oc_group_1",
        message: "thread reply",
        messageId: "om_parent",
        media: "/tmp/script.py",
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    const outboundArgs = requireRecord(
      mockCallArg(feishuOutboundSendMediaMock, 0, 0, "feishuOutbound.sendMedia"),
      "outbound args",
    );
    expect(outboundArgs.propagateMediaUploadFailure).toBeUndefined();
    expect(resultDetails(result).messageId).toBe("om_thread_fallback");
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
    mockFeishuOutboundTextDelivery("om_reply");

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "thread-reply",
      params: { to: "chat:oc_group_1", messageId: "om_parent", text: "reply body" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(feishuOutboundSendTextMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "reply body",
      accountId: undefined,
      mediaLocalRoots: undefined,
      threadId: "om_parent",
    });
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.action).toBe("thread-reply");
    expect(details.messageId).toBe("om_reply");
  });

  it("auto-threads `send` text against the inbound trigger in group_topic sessions", async () => {
    mockFeishuOutboundTextDelivery("om_topic");

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", text: "topic reply" },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
      toolContext: { currentMessageId: "om_inbound", currentChannelId: "oc_group_1" },
    } as never);

    expect(feishuOutboundSendTextMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "topic reply",
      accountId: undefined,
      mediaLocalRoots: undefined,
      threadId: "om_inbound",
    });
  });

  it.each(["implicit", "explicit"] as const)(
    "preserves topic routing with a prepared %s reply",
    async (source) => {
      mockFeishuOutboundTextDelivery("om_reply");
      await feishuPlugin.actions!.handleAction!({
        channel: "feishu",
        action: "send",
        cfg,
        params: { to: "chat:oc_group_1", text: "reply", replyTo: "om_inbound" },
        sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
        toolContext: { currentChannelId: "oc_group_1", currentMessageId: "om_inbound" },
        reply:
          source === "explicit"
            ? { source, replyToId: "om_inbound" }
            : { source, replyToId: "om_inbound", mode: "all" },
      });
      expect(feishuOutboundSendTextMock).toHaveBeenCalledWith(
        expect.objectContaining(
          source === "implicit" ? { threadId: "om_inbound" } : { replyToId: "om_inbound" },
        ),
      );
    },
  );

  it.each([
    { name: "destination changes", params: { to: "chat:oc_other" } },
    { name: "top-level send requested", params: { to: "chat:oc_group_1", topLevel: true } },
    { name: "thread inheritance suppressed", params: { to: "chat:oc_group_1", threadId: null } },
    {
      name: "requesting account differs",
      params: { to: "chat:oc_group_1" },
      requesterAccountId: "other",
    },
  ])("does not inherit the source topic when $name", async ({ params, requesterAccountId }) => {
    const stickerCfg = {
      channels: {
        feishu: {
          appId: "cli_main",
          appSecret: "secret_main",
          actions: { sticker: true },
        },
      },
    } satisfies OpenClawConfig;
    for (const action of ["send", "sticker"] as const) {
      if (action === "send") {
        mockFeishuOutboundTextDelivery("om_sent");
      } else {
        sendStickerFeishuMock.mockResolvedValueOnce({ messageId: "om_sent", chatId: "oc_group_1" });
      }
      await feishuPlugin.actions!.handleAction!({
        channel: "feishu",
        action,
        cfg: stickerCfg,
        requesterAccountId,
        params: { ...params, text: "hello", fileId: "file_sticker" },
        sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
        toolContext: { currentMessageId: "om_inbound", currentChannelId: "oc_group_1" },
      });
      if (action === "sticker") {
        expect(sendStickerFeishuMock).toHaveBeenCalledWith(
          expect.objectContaining({
            to: params.to,
            replyToMessageId: undefined,
            replyInThread: false,
          }),
        );
      } else {
        expect(feishuOutboundSendTextMock).toHaveBeenCalledWith(
          expect.objectContaining({
            to: params.to,
            replyToId: undefined,
          }),
        );
        expect(feishuOutboundSendTextMock.mock.calls[0]?.[0]).not.toHaveProperty("threadId");
      }
    }
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
      toolContext: { currentMessageId: "om_inbound", currentChannelId: "oc_group_1" },
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
      toolContext: { currentMessageId: "om_inbound", currentChannelId: "oc_group_1" },
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
    mockFeishuOutboundTextDelivery("om_topic");

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", text: "topic reply" },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound:sender:ou_user",
      toolContext: { currentMessageId: "om_inbound", currentChannelId: "oc_group_1" },
    } as never);

    const sendArgs = requireRecord(
      mockCallArg(feishuOutboundSendTextMock, 0, 0, "feishuOutbound.sendText"),
      "send args",
    );
    expect(sendArgs.threadId).toBe("om_inbound");
    expect("replyToId" in sendArgs).toBe(false);
  });

  it("does not auto-thread `send` in plain group sessions (no topic)", async () => {
    mockFeishuOutboundTextDelivery("om_plain");

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", text: "plain group reply" },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1",
      toolContext: { currentMessageId: "om_inbound" },
    } as never);

    expect(feishuOutboundSendTextMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "plain group reply",
      accountId: undefined,
      mediaLocalRoots: undefined,
      replyToId: undefined,
    });
  });

  it("does not auto-thread `send` in group_topic when no inbound currentMessageId is available", async () => {
    mockFeishuOutboundTextDelivery("om_topic");

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", text: "topic reply" },
      cfg,
      accountId: undefined,
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
      toolContext: {},
    } as never);

    expect(feishuOutboundSendTextMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "topic reply",
      accountId: undefined,
      mediaLocalRoots: undefined,
      replyToId: undefined,
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
