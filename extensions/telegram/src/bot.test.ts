import { rm } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { loadSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramInteractiveHandlerContext } from "./interactive-dispatch.js";
const {
  answerCallbackQuerySpy,
  commandSpy,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  enqueueSystemEventSpy,
  getFileSpy,
  getChatSpy,
  getLoadConfigMock,
  getLoadWebMediaMock,
  getReadChannelAllowFromStoreMock,
  getOnHandler,
  listSkillCommandsForAgents,
  onSpy,
  replySpy,
  resolveExecApprovalSpy,
  sendMessageSpy,
  setMyCommandsSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
  wasSentByBot,
} = await import("./bot.create-telegram-bot.test-harness.js");

let createTelegramBotBase: typeof import("./bot-core.js").createTelegramBotCore;
let setTelegramBotRuntimeForTest: typeof import("./bot-core.js").setTelegramBotRuntimeForTest;
let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();
const loadWebMedia = getLoadWebMediaMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const PUZZLE_EMOJI = "\u{1F9E9}";
const INFO_EMOJI = "\u{2139}\u{FE0F}";
const CHECK_MARK_EMOJI = "\u{2705}";
const THUMBS_UP_EMOJI = "\u{1F44D}";
const FIRE_EMOJI = "\u{1F525}";
const PARTY_EMOJI = "\u{1F389}";
const EYES_EMOJI = "\u{1F440}";
const HEART_EMOJI = "\u{2764}\u{FE0F}";

function createSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function waitForReplyCalls(count: number) {
  const done = createSignal();
  let seen = 0;
  replySpy.mockImplementation(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    seen += 1;
    if (seen >= count) {
      done.resolve();
    }
    return undefined;
  });
  return done.promise;
}

async function loadEnvelopeTimestampHelpers() {
  return await import("openclaw/plugin-sdk/channel-test-helpers");
}

async function loadInboundContextContract() {
  return await import("./test-support/inbound-context-contract.js");
}

const ORIGINAL_TZ = process.env.TZ;
describe("createTelegramBot", () => {
  beforeAll(async () => {
    ({ createTelegramBotCore: createTelegramBotBase, setTelegramBotRuntimeForTest } =
      await import("./bot-core.js"));
  });
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  beforeEach(() => {
    setMyCommandsSpy.mockClear();
    clearPluginInteractiveHandlers();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  it("blocks callback_query when inline buttons are allowlist-only and sender not authorized", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-2",
        data: "cmd:option_b",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 11,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-2");
  });

  it("blocks DM model-selection callbacks for unpaired users when inline buttons are DM-scoped", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-callback-authz-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "dm" },
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      readChannelAllowFromStore.mockResolvedValueOnce([]);

      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-authz-bypass-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 19,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({});
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-authz-bypass-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("blocks group model-selection callbacks for senders who are not authorized for /models", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-group-model-authz-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        commands: {
          allowFrom: {
            telegram: ["9"],
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            capabilities: { inlineButtons: "group" },
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-group-model-authz-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: -100999, type: "supergroup", title: "Test Group" },
            date: 1736380800,
            message_id: 21,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({});
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-model-authz-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("recomputes group model-selection callback auth from runtime command config", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-group-model-authz-runtime-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      let currentConfig = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        commands: {
          allowFrom: {
            telegram: ["999"],
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            capabilities: { inlineButtons: "group" },
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockImplementation(() => currentConfig);
      createTelegramBot({
        token: "tok",
        config: currentConfig,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      currentConfig = {
        ...currentConfig,
        commands: {
          allowFrom: {
            telegram: ["9"],
          },
        },
      };

      await callbackHandler({
        callbackQuery: {
          id: "cbq-group-model-authz-runtime-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: -100999, type: "supergroup", title: "Test Group" },
            date: 1736380800,
            message_id: 22,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({});
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-model-authz-runtime-1");
    } finally {
      loadConfig.mockReset();
      loadConfig.mockReturnValue({
        agents: {
          defaults: {
            envelopeTimezone: "utc",
          },
        },
        channels: {
          telegram: { dmPolicy: "open", allowFrom: ["*"] },
        },
      });
      await rm(storePath, { force: true });
    }
  });

  it("allows callback_query in groups when group policy authorizes the sender", async () => {
    onSpy.mockClear();
    editMessageTextSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-group-1",
        data: "commands_page_2",
        from: { id: 42, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: -100999, type: "supergroup", title: "Test Group" },
          date: 1736380800,
          message_id: 20,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    // The callback should be processed (not silently blocked)
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-1");
  });

  it("clears approval buttons without re-editing callback message text", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-style",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 21,
          text: [
            `${PUZZLE_EMOJI} Yep-needs approval again.`,
            "",
            "Run:",
            "/approve 138e9b8c allow-once",
            "",
            "Pending command:",
            "```shell",
            "npm view diver name version description",
            "```",
          ].join("\n"),
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    const [chatId, messageId, replyMarkup] = editMessageReplyMarkupSpy.mock.calls[0] ?? [];
    expect(chatId).toBe(1234);
    expect(messageId).toBe(21);
    expect(replyMarkup).toEqual({ reply_markup: { inline_keyboard: [] } });
    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          telegram: expect.objectContaining({
            execApprovals: expect.objectContaining({
              enabled: true,
              approvers: ["9"],
              target: "dm",
            }),
          }),
        }),
      }),
      approvalId: "138e9b8c",
      decision: "allow-once",
      allowPluginFallback: true,
      senderId: "9",
    });
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-style");
  });

  it("allows approval callbacks when exec approvals are enabled even without generic inlineButtons capability", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
          dmPolicy: "open",
          allowFrom: ["*"],
          capabilities: ["vision"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-capability-free",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 23,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-capability-free");
  });

  it("resolves plugin approval callbacks through the shared approval resolver", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-plugin-approve",
        data: "/approve plugin:138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 24,
          text: "Plugin approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          telegram: expect.objectContaining({
            execApprovals: expect.objectContaining({
              enabled: true,
              approvers: ["9"],
              target: "dm",
            }),
          }),
        }),
      }),
      approvalId: "plugin:138e9b8c",
      decision: "allow-once",
      allowPluginFallback: true,
      senderId: "9",
    });
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-approve");
  });

  it("blocks approval callbacks from telegram users who are not exec approvers", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["999"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-blocked",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 22,
          text: "Run: /approve 138e9b8c allow-once",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(resolveExecApprovalSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-blocked");
  });

  it("keeps approval callback resolution failures out of Telegram chat before retry", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("gateway secret detail"));

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await expect(
      callbackHandler({
        callbackQuery: {
          id: "cbq-approve-error",
          data: "/approve 138e9b8c allow-once",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 25,
            text: "Approval required.",
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      }),
    ).rejects.toThrow("gateway secret detail");

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-error");
  });

  it("allows exec approval callbacks from target-only Telegram recipients", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-target",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 23,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        approvals: expect.objectContaining({
          exec: expect.objectContaining({
            enabled: true,
            mode: "targets",
          }),
        }),
      }),
      approvalId: "138e9b8c",
      decision: "allow-once",
      allowPluginFallback: false,
      senderId: "9",
    });
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-target");
  });

  it("keeps legacy plugin fallback approval failures retryable for target-only recipients", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("unknown or expired approval id"));

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await expect(
      callbackHandler({
        callbackQuery: {
          id: "cbq-legacy-plugin-fallback-blocked",
          data: "/approve 138e9b8c allow-once",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 25,
            text: "Legacy plugin approval required.",
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      }),
    ).rejects.toThrow("unknown or expired approval id");

    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        approvals: expect.objectContaining({
          exec: expect.objectContaining({
            enabled: true,
            mode: "targets",
          }),
        }),
      }),
      approvalId: "138e9b8c",
      decision: "allow-once",
      allowPluginFallback: false,
      senderId: "9",
    });
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-legacy-plugin-fallback-blocked");
  });

  it("keeps plugin approval callback buttons for target-only recipients", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          capabilities: ["vision"],
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-plugin-approve-blocked",
        data: "/approve plugin:138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 24,
          text: "Plugin approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-approve-blocked");
  });

  it("edits commands list for pagination callbacks", async () => {
    onSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-3",
        data: "commands_page_2:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 12,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentIds: ["main"],
    });
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text, params] = editMessageTextSpy.mock.calls[0] ?? [];
    expect(chatId).toBe(1234);
    expect(messageId).toBe(12);
    expect(String(text)).toContain(`${INFO_EMOJI} Commands (2/`);
    expect(params).toEqual({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "◀ Prev", callback_data: "commands_page_1:main" },
            { text: "2/6", callback_data: "commands_page_noop:main" },
            { text: "Next ▶", callback_data: "commands_page_3:main" },
          ],
        ],
      },
    });
  });

  it("falls back to default agent for pagination callbacks without agent suffix", async () => {
    onSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-no-suffix",
        data: "commands_page_2",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 14,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentIds: ["main"],
    });
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks pagination callbacks when allowlist rejects sender", async () => {
    onSpy.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-4",
        data: "commands_page_2",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 13,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-4");
  });

  it("routes compact model callbacks by inferring provider", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const modelId = "us.anthropic.claude-3-5-sonnet-20240620-v1:0";
    const storePath = `/tmp/openclaw-telegram-model-compact-${process.pid}-${Date.now()}.json`;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: `bedrock/${modelId}`,
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-compact-1",
          data: `mdl_sel/${modelId}`,
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 14,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
        `${CHECK_MARK_EMOJI} Model reset to default`,
      );

      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("renders model callback lists with configured display names", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const buildModelsProviderDataMock =
      telegramBotDepsForTest.buildModelsProviderData as unknown as ReturnType<typeof vi.fn>;
    buildModelsProviderDataMock.mockResolvedValueOnce({
      byProvider: new Map<string, Set<string>>([["openai", new Set(["gpt-5", "gpt-4.1"])]]),
      providers: ["openai"],
      resolvedDefault: { provider: "openai", model: "gpt-5" },
      modelNames: new Map<string, string>([
        ["openai/gpt-4.1", "GPT 4.1 Bridge"],
        ["openai/gpt-5", "GPT Five Bridge"],
      ]),
    });

    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5",
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    loadConfig.mockReturnValue(config);
    createTelegramBot({
      token: "tok",
      config,
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-model-display-names-1",
        data: "mdl_list_openai_1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 23,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const [, , , params] = editMessageTextSpy.mock.calls[0] ?? [];
    const buttons = (
      params as {
        reply_markup?: {
          inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
        };
      }
    ).reply_markup?.inline_keyboard?.flat();

    expect(buttons).toContainEqual({
      text: "GPT 4.1 Bridge",
      callback_data: "mdl_sel_openai/gpt-4.1",
    });
    const gpt5Button = buttons?.find((button) => button.callback_data === "mdl_sel_openai/gpt-5");
    expect(gpt5Button?.text?.replace(" ✓", "")).toBe("GPT Five Bridge");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-display-names-1");
  });

  it("resets overrides when selecting the configured default model", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-default-${process.pid}-${Date.now()}.json`;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "claude-opus-4-6",
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    };

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-default-1",
          data: "mdl_sel_anthropic/claude-opus-4-6",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 16,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
        `${CHECK_MARK_EMOJI} Model reset to default`,
      );

      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-default-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("formats non-default model selection confirmations with Telegram HTML parse mode", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-html-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-html-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 17,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy).toHaveBeenCalledWith(
        1234,
        17,
        `${CHECK_MARK_EMOJI} Model changed to <b>openai/gpt-5.4</b>\n\nThis model will be used for your next message.`,
        expect.objectContaining({ parse_mode: "HTML" }),
      );

      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBe("openai");
      expect(entry?.modelOverride).toBe("gpt-5.4");
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-html-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("persists non-default model override using fresh config, not stale startup snapshot", async () => {
    // Regression: the callback handler used the startup `cfg` snapshot for
    // store path and default-model resolution.  If the config was reloaded
    // (e.g. default model changed) the override could be written to the wrong
    // store or incorrectly cleared because `isDefaultSelection` was wrong.
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-fresh-cfg-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      // Startup config: default is openai/gpt-5.4
      const startupConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            models: {
              "openai/gpt-5.4": {},
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      // Fresh config: default changed to anthropic/claude-opus-4-6
      const freshConfig = {
        ...startupConfig,
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "openai/gpt-5.4": {},
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
      };

      // Bot created with startup config; loadConfig now returns fresh config
      loadConfig.mockReturnValue(freshConfig);
      createTelegramBot({
        token: "tok",
        config: startupConfig,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      // User selects openai/gpt-5.4 — was default at startup but NOT default
      // in fresh config.  The override must be persisted.
      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-fresh-cfg-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 20,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      // Override must be persisted (not cleared) because openai/gpt-5.4 is
      // NOT the default in the fresh config.
      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBe("openai");
      expect(entry?.modelOverride).toBe("gpt-5.4");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("rejects ambiguous compact model callbacks and returns provider list", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        agents: {
          defaults: {
            model: "anthropic/shared-model",
            models: {
              "anthropic/shared-model": {},
              "openai/shared-model": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-model-compact-2",
        data: "mdl_sel/shared-model",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 15,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
      'Could not resolve model "shared-model".',
    );
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-2");
  });

  it("includes sender identity in group envelope headers", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
        message_id: 2,
        from: {
          id: 99,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    const { expectChannelInboundContextContract: expectInboundContextContract } =
      await loadInboundContextContract();
    const { escapeRegExp, formatEnvelopeTimestamp } = await loadEnvelopeTimestampHelpers();
    expectInboundContextContract(payload);
    const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
    const timestampPattern = escapeRegExp(expectedTimestamp);
    expect(payload.Body).toMatch(
      new RegExp(`^\\[Telegram Ops id:42 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
    );
    expect(payload.SenderName).toBe("Ada Lovelace");
    expect(payload.SenderId).toBe("99");
    expect(payload.SenderUsername).toBe("ada");
  });

  it("uses quote text when a Telegram partial reply is received", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        reply_to_message: {
          message_id: 9001,
          text: "Can you summarize this?",
          from: { first_name: "Ada" },
        },
        quote: {
          text: " summarize this\n",
          position: 8,
          entities: [{ type: "bold", offset: 1, length: 9 }],
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting Ada id:9001]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
    const telegramPayload = payload as Record<string, unknown>;
    expect(telegramPayload.ReplyToQuoteText).toBe(" summarize this\n");
    expect(telegramPayload.ReplyToQuotePosition).toBe(8);
    expect(telegramPayload.ReplyToQuoteEntities).toEqual([{ type: "bold", offset: 1, length: 9 }]);
    expect(telegramPayload.ReplyToQuoteSourceText).toBe("Can you summarize this?");
  });

  it("keeps reply linkage while omitting filtered binary reply captions", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        reply_to_message: {
          message_id: 9001,
          caption: "PK\x00\x03\x04binary",
          from: { first_name: "Ada" },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Replying to Ada id:9001]");
    expect(payload.Body).not.toContain("PK");
    expect(payload.Body).not.toContain("unsafe reply text omitted");
    expect(payload.ReplyToBody).toBeUndefined();
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("includes replied image media in inbound context for text replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    loadWebMedia.mockResolvedValueOnce({ path: "/tmp/reply-photo.png", contentType: "image/png" });

    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      createTelegramBot({
        token: "tok",
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "what is in this image?",
          date: 1736380800,
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
    } finally {
      ssrfMock.mockRestore();
    }

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0] as {
      MediaPath?: string;
      MediaPaths?: string[];
      ReplyToBody?: string;
    };
    expect(payload.ReplyToBody).toBe("<media:image>");
    expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1");
    expect(loadWebMedia).not.toHaveBeenCalled();
    expect(mediaFetch).toHaveBeenCalledTimes(1);
  });

  it("does not fetch reply media for unauthorized DM replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    sendMessageSpy.mockClear();
    readChannelAllowFromStore.mockResolvedValue([]);
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "hey",
        date: 1736380800,
        from: { id: 999, first_name: "Eve" },
        reply_to_message: {
          message_id: 9001,
          photo: [{ file_id: "reply-photo-1" }],
          from: { first_name: "Ada" },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    expect(getFileSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("defers reply media download until debounce flush", async () => {
    const DEBOUNCE_MS = 4321;
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      messages: {
        inbound: {
          debounceMs: DEBOUNCE_MS,
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const ssrfMock = mockPinnedHostnameResolution();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const replyDelivered = waitForReplyCalls(1);
      createTelegramBot({
        token: "tok",
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "first",
          date: 1736380800,
          message_id: 101,
          from: { id: 42, first_name: "Ada" },
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "second",
          date: 1736380801,
          message_id: 102,
          from: { id: 42, first_name: "Ada" },
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(getFileSpy).not.toHaveBeenCalled();

      const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === DEBOUNCE_MS,
      );
      const flushTimer =
        flushTimerCallIndex >= 0
          ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
          : undefined;
      if (flushTimerCallIndex >= 0) {
        clearTimeout(
          setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
        );
      }
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();
      await replyDelivered;

      expect(getFileSpy).toHaveBeenCalledTimes(1);
      expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1");
      expect(mediaFetch).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      ssrfMock.mockRestore();
    }
  });

  it("handles quote-only replies without reply metadata", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        quote: {
          text: "summarize this",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting unknown sender]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBeUndefined();
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("unknown sender");
  });

  it("uses top-level quote text for external partial replies", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        quote: {
          text: "summarize this",
        },
        external_reply: {
          message_id: 9002,
          text: "Can you summarize this?",
          from: { first_name: "Ada" },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting Ada id:9002]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9002");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
    expect((payload as Record<string, unknown>).ReplyToIsExternal).toBe(true);
  });

  it("propagates forwarded origin from external_reply targets", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Thoughts?",
        date: 1736380800,
        external_reply: {
          message_id: 9003,
          text: "forwarded text",
          from: { first_name: "Ada" },
          quote: {
            text: "forwarded snippet",
          },
          forward_origin: {
            type: "user",
            sender_user: {
              id: 999,
              first_name: "Bob",
              last_name: "Smith",
              username: "bobsmith",
              is_bot: false,
            },
            date: 500,
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.ReplyToForwardedFrom).toBe("Bob Smith (@bobsmith)");
    expect(payload.ReplyToForwardedFromType).toBe("user");
    expect(payload.ReplyToForwardedFromId).toBe("999");
    expect(payload.ReplyToForwardedFromUsername).toBe("bobsmith");
    expect(payload.ReplyToForwardedFromTitle).toBe("Bob Smith");
    expect(payload.ReplyToForwardedDate).toBe(500000);
    expect(payload.Body).toContain(
      "[Forwarded from Bob Smith (@bobsmith) at 1970-01-01T00:08:20.000Z]",
    );
  });

  it("redacts forwarded origin inside reply targets when context visibility is allowlist", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          contextVisibility: "allowlist",
          groups: {
            "-1007": {
              requireMention: false,
              allowFrom: ["1"],
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        message_id: 9004,
        chat: { id: -1007, type: "group", title: "Ops" },
        text: "Thoughts?",
        date: 1736380800,
        from: { id: 1, first_name: "Ada", username: "ada", is_bot: false },
        reply_to_message: {
          message_id: 9003,
          text: "forwarded text",
          from: { id: 1, first_name: "Ada", username: "ada", is_bot: false },
          forward_origin: {
            type: "user",
            sender_user: {
              id: 999,
              first_name: "Bob",
              last_name: "Smith",
              username: "bobsmith",
              is_bot: false,
            },
            date: 500,
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.ReplyToId).toBe("9003");
    expect(payload.ReplyToBody).toBe("forwarded text");
    expect(payload.ReplyToSender).toBe("Ada");
    expect(payload.ReplyToForwardedFrom).toBeUndefined();
    expect(payload.ReplyToForwardedFromType).toBeUndefined();
    expect(payload.ReplyToForwardedFromId).toBeUndefined();
    expect(payload.ReplyToForwardedFromUsername).toBeUndefined();
    expect(payload.ReplyToForwardedDate).toBeUndefined();
    expect(payload.Body).not.toContain("[Forwarded from Bob Smith (@bobsmith)");
  });

  it("accepts group replies to the bot without explicit mention when requireMention is enabled", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: { groups: { "*": { requireMention: true } } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 456, type: "group", title: "Ops Chat" },
        text: "following up",
        date: 1736380800,
        reply_to_message: {
          message_id: 42,
          text: "original reply",
          from: { id: 999, first_name: "OpenClaw" },
        },
      },
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.WasMentioned).toBe(true);
  });

  it("inherits group allowlist + requireMention in topics", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              requireMention: false,
              allowFrom: ["123456789"],
              topics: {
                "99": {},
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("prefers topic allowFrom over group allowFrom", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              allowFrom: ["123456789"],
              topics: {
                "99": { allowFrom: ["999999999"] },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(0);
  });

  it("allows group messages for per-group groupPolicy open override (global groupPolicy allowlist)", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("blocks control commands from unauthorized senders in per-group open groups", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "/status",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("routes plugin-owned callback namespaces before synthetic command fallback", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();
    sendMessageSpy.mockClear();
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: (async ({ respond, callback }: TelegramInteractiveHandlerContext) => {
        await respond.editMessage({
          text: `Handled ${callback.payload}`,
        });
        return { handled: true };
      }) as never,
    });

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-codex-1",
        data: "codexapp:resume:thread-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 11,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).toHaveBeenCalledWith(1234, 11, "Handled resume:thread-1", undefined);
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("routes Telegram #General callback payloads as topic 1 when Telegram omits topic metadata", async () => {
    onSpy.mockClear();
    getChatSpy.mockResolvedValue({ id: -100123456789, type: "supergroup", is_forum: true });
    const handler = vi.fn(
      async ({ respond, conversationId, threadId }: TelegramInteractiveHandlerContext) => {
        expect(conversationId).toBe("-100123456789:topic:1");
        expect(threadId).toBe(1);
        await respond.editMessage({
          text: `Handled ${conversationId}`,
        });
        return { handled: true };
      },
    );
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: handler as never,
    });

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-codex-general",
        data: "codexapp:resume:thread-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: -100123456789, type: "supergroup", title: "Forum Group" },
          date: 1736380800,
          message_id: 11,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(getChatSpy).toHaveBeenCalledWith(-100123456789);
    expect(handler).toHaveBeenCalledOnce();
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      -100123456789,
      11,
      "Handled -100123456789:topic:1",
      undefined,
    );
  });
  it("sets command target session key for dm topic commands", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.CommandTargetSessionKey).toBe("agent:main:main:thread:12345:99");
  });

  it("allows native DM commands for paired users", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(
      sendMessageSpy.mock.calls.some(
        (call) => call[1] === "You are not authorized to use this command.",
      ),
    ).toBe(false);
  });

  it("keeps native DM commands on the startup-resolved config when fresh reads contain SecretRefs", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    const startupConfig = {
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing" as const,
          botToken: "resolved-token",
        },
      },
    };

    createTelegramBot({
      token: "tok",
      config: startupConfig,
    });
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("blocks native DM commands for unpaired users", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce([]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      12345,
      "You are not authorized to use this command.",
      {},
    );
  });

  it("registers message_reaction handler", () => {
    onSpy.mockClear();
    createTelegramBot({ token: "tok" });
    const reactionHandler = onSpy.mock.calls.find((call) => call[0] === "message_reaction");
    expect(reactionHandler).toBeDefined();
  });

  it("enqueues system event for reaction", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 500 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada", username: "ada_bot" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada (@ada_bot) on msg 42`,
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:add:1234:42:9"),
      }),
    );
  });

  it.each([
    {
      name: "blocks reaction when dmPolicy is disabled",
      updateId: 510,
      channelConfig: { dmPolicy: "disabled", reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "blocks reaction in pairing mode for non-paired sender (default dmPolicy)",
      updateId: 514,
      channelConfig: { dmPolicy: "pairing", reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "blocks reaction in allowlist mode for unauthorized direct sender",
      updateId: 511,
      channelConfig: {
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        reactionNotifications: "all",
      },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "allows reaction in allowlist mode for authorized direct sender",
      updateId: 512,
      channelConfig: { dmPolicy: "allowlist", allowFrom: ["9"], reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 1,
    },
    {
      name: "blocks reaction in group allowlist mode for unauthorized sender",
      updateId: 513,
      channelConfig: {
        dmPolicy: "open",
        groupPolicy: "allowlist",
        groupAllowFrom: ["12345"],
        reactionNotifications: "all",
      },
      reaction: {
        chat: { id: 9999, type: "supergroup" },
        message_id: 77,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
  ])("$name", async ({ updateId, channelConfig, reaction, expectedEnqueueCalls }) => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: channelConfig,
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: updateId },
      messageReaction: reaction,
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(expectedEnqueueCalls);
  });

  it("skips reaction when reactionNotifications is off", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "off" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 501 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("defaults reactionNotifications to own", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 502 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 43,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("allows reaction in all mode regardless of message sender", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 99`,
      expect.any(Object),
    );
  });

  it("skips reaction in own mode when message is not sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("allows reaction in own mode when message is sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("skips reaction from bot users", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Bot", is_bot: true },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("skips reaction removal (only processes added reactions)", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
        new_reaction: [],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("enqueues one event per added emoji reaction", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 505 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
        new_reaction: [
          { type: "emoji", emoji: THUMBS_UP_EMOJI },
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSystemEventSpy.mock.calls.map((call) => call[0])).toEqual([
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 42`,
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 42`,
    ]);
  });

  it("routes forum group reactions to the general topic (thread id not available on reactions)", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    // MessageReactionUpdated does not include message_thread_id in the Bot API,
    // so forum reactions always route to the general topic (1).
    await handler({
      update: { update_id: 505 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 100,
        user: { id: 10, first_name: "Bob", username: "bob_user" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Bob (@bob_user) on msg 100`,
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
        contextKey: expect.stringContaining("telegram:reaction:add:5678:100:10"),
      }),
    );
  });

  it("uses correct session key for forum group reactions in general topic", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 506 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 101,
        // No message_thread_id - should default to general topic (1)
        user: { id: 10, first_name: "Bob" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: EYES_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${EYES_EMOJI} by Bob on msg 101`,
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
        contextKey: expect.stringContaining("telegram:reaction:add:5678:101:10"),
      }),
    );
  });

  it("uses correct session key for regular group reactions without topic", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 507 },
      messageReaction: {
        chat: { id: 9999, type: "group" },
        message_id: 200,
        user: { id: 11, first_name: "Charlie" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Charlie on msg 200`,
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:9999"),
        contextKey: expect.stringContaining("telegram:reaction:add:9999:200:11"),
      }),
    );
    // Verify session key does NOT contain :topic:
    const eventOptions = enqueueSystemEventSpy.mock.calls[0]?.[1] as {
      sessionKey?: string;
    };
    const sessionKey = eventOptions.sessionKey ?? "";
    expect(sessionKey).not.toContain(":topic:");
  });

  it("blocks reaction in own mode when cache is warm and message not sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 601 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });
});
