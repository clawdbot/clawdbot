import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  buildOutboundMediaLoadOptions,
  isGifMedia,
  kindFromMime,
  normalizePollInput,
} from "openclaw/plugin-sdk/media-runtime";
import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, vi } from "vitest";

const { botApi, botConfigUseSpy, botCtorSpy } = vi.hoisted(() => ({
  botConfigUseSpy: vi.fn(),
  botApi: {
    deleteMessage: vi.fn(),
    editForumTopic: vi.fn(),
    editMessageText: vi.fn(),
    editMessageReplyMarkup: vi.fn(),
    pinChatMessage: vi.fn(),
    sendChatAction: vi.fn(),
    sendMessage: vi.fn(),
    sendPoll: vi.fn(),
    sendPhoto: vi.fn(),
    sendVoice: vi.fn(),
    sendAudio: vi.fn(),
    sendVideo: vi.fn(),
    sendVideoNote: vi.fn(),
    sendAnimation: vi.fn(),
    setMessageReaction: vi.fn(),
    sendSticker: vi.fn(),
    unpinChatMessage: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

const { imageMetadata } = vi.hoisted(() => ({
  imageMetadata: {
    width: 1200 as number | undefined,
    height: 800 as number | undefined,
  },
}));

const { probeVideoDimensions } = vi.hoisted(() => ({
  probeVideoDimensions: vi.fn(),
}));

const { loadConfig, resolveStorePath } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveStorePath: vi.fn(
    (storePath?: string) => storePath ?? "/tmp/openclaw-telegram-send-tests.json",
  ),
}));

const { maybePersistResolvedTelegramTarget } = vi.hoisted(() => ({
  maybePersistResolvedTelegramTarget: vi.fn(async () => {}),
}));

const {
  undiciFetch,
  undiciSetGlobalDispatcher,
  undiciAgentCtor,
  undiciEnvHttpProxyAgentCtor,
  undiciProxyAgentCtor,
} = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
  undiciSetGlobalDispatcher: vi.fn(),
  undiciAgentCtor: vi.fn(function MockAgent(
    this: { options?: Record<string, unknown> },
    options?: Record<string, unknown>,
  ) {
    this.options = options;
  }),
  undiciEnvHttpProxyAgentCtor: vi.fn(function MockEnvHttpProxyAgent(
    this: { options?: Record<string, unknown> },
    options?: Record<string, unknown>,
  ) {
    this.options = options;
  }),
  undiciProxyAgentCtor: vi.fn(function MockProxyAgent(
    this: { options?: Record<string, unknown> | string },
    options?: Record<string, unknown> | string,
  ) {
    this.options = options;
  }),
}));

type TelegramSendTestMocks = {
  botApi: typeof botApi;
  botConfigUseSpy: MockFn;
  botCtorSpy: MockFn;
  loadConfig: MockFn;
  resolveStorePath: MockFn;
  loadWebMedia: MockFn;
  maybePersistResolvedTelegramTarget: MockFn;
  imageMetadata: { width: number | undefined; height: number | undefined };
  probeVideoDimensions: MockFn;
};

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia,
}));

vi.mock("grammy", () => ({
  API_CONSTANTS: {
    DEFAULT_UPDATE_TYPES: ["message"],
    ALL_UPDATE_TYPES: ["message"],
  },
  Bot: class {
    api = {
      ...botApi,
      config: {
        use: botConfigUseSpy,
      },
    };
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: {
        client?: { fetch?: typeof fetch; timeoutSeconds?: number };
      },
    ) {
      botCtorSpy(token, options);
    }
  },
  HttpError: class HttpError extends Error {
    constructor(
      message = "HttpError",
      public error?: unknown,
    ) {
      super(message);
    }
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
  InputFile: function InputFile() {},
}));

vi.mock("undici", () => ({
  Agent: undiciAgentCtor,
  EnvHttpProxyAgent: undiciEnvHttpProxyAgentCtor,
  ProxyAgent: undiciProxyAgentCtor,
  fetch: undiciFetch,
  setGlobalDispatcher: undiciSetGlobalDispatcher,
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: vi.fn((cfg: unknown) => cfg ?? loadConfig()),
  };
});

vi.mock("./send.runtime.js", () => ({
  buildOutboundMediaLoadOptions,
  getImageMetadata: vi.fn(async () => ({ ...imageMetadata })),
  isGifMedia,
  kindFromMime,
  loadConfig,
  loadWebMedia,
  normalizePollInput,
  probeVideoDimensions,
  requireRuntimeConfig: vi.fn((cfg: unknown) => cfg ?? loadConfig()),
  resolveMarkdownTableMode,
  resolveStorePath,
}));

vi.mock("./target-writeback.js", () => ({
  maybePersistResolvedTelegramTarget,
}));

export function getTelegramSendTestMocks(): TelegramSendTestMocks {
  return {
    botApi,
    botConfigUseSpy,
    botCtorSpy,
    loadConfig,
    resolveStorePath,
    loadWebMedia,
    maybePersistResolvedTelegramTarget,
    imageMetadata,
    probeVideoDimensions,
  };
}

export function installTelegramSendTestHooks() {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    resolveStorePath.mockReturnValue("/tmp/openclaw-telegram-send-tests.json");
    loadWebMedia.mockReset();
    probeVideoDimensions.mockReset();
    probeVideoDimensions.mockResolvedValue(undefined);
    imageMetadata.width = 1200;
    imageMetadata.height = 800;
    maybePersistResolvedTelegramTarget.mockReset();
    maybePersistResolvedTelegramTarget.mockResolvedValue(undefined);
    undiciFetch.mockReset();
    undiciSetGlobalDispatcher.mockReset();
    undiciAgentCtor.mockClear();
    undiciEnvHttpProxyAgentCtor.mockClear();
    undiciProxyAgentCtor.mockClear();
    botCtorSpy.mockReset();
    botConfigUseSpy.mockReset();
    for (const fn of Object.values(botApi)) {
      fn.mockReset();
    }
  });
}

export async function importTelegramSendModule() {
  vi.resetModules();
  return await import("./send.js");
}
