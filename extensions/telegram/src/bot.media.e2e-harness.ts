import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, vi, type Mock } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";

type TelegramBotRuntimeForTest = NonNullable<
  Parameters<typeof import("./bot.js").setTelegramBotRuntimeForTest>[0]
>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyHarnessParams = Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];
type ReadRemoteMediaBufferFn =
  typeof import("openclaw/plugin-sdk/media-runtime").readRemoteMediaBuffer;

const useSpy: Mock = vi.fn();
const middlewareUseSpy: Mock = vi.fn();
export const onSpy: Mock = vi.fn();
const stopSpy: Mock = vi.fn();
export const sendChatActionSpy: Mock = vi.fn();

function defaultUndiciFetch(input: RequestInfo | URL, init?: RequestInit) {
  return globalThis.fetch(input, init);
}

export const undiciFetchSpy: Mock = vi.fn(defaultUndiciFetch);

function resetUndiciFetchMock() {
  undiciFetchSpy.mockReset();
  undiciFetchSpy.mockImplementation(defaultUndiciFetch);
}

async function defaultReadRemoteMediaBuffer(
  params: Parameters<ReadRemoteMediaBufferFn>[0],
): ReturnType<ReadRemoteMediaBufferFn> {
  if (!params.fetchImpl) {
    throw new Error(`Missing fetchImpl for ${params.url}`);
  }
  const response = await params.fetchImpl(params.url, { redirect: "manual" });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch media from ${params.url}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") ?? undefined,
    fileName: params.filePathHint ? path.basename(params.filePathHint) : undefined,
  } as Awaited<ReturnType<ReadRemoteMediaBufferFn>>;
}

export const readRemoteMediaBufferSpy: Mock = vi.fn(defaultReadRemoteMediaBuffer);

export function resetReadRemoteMediaBufferMock() {
  readRemoteMediaBufferSpy.mockReset();
  readRemoteMediaBufferSpy.mockImplementation(defaultReadRemoteMediaBuffer);
}

async function defaultSaveMediaBuffer(buffer: Buffer, contentType?: string) {
  return {
    id: "media",
    path: "/tmp/telegram-media",
    size: buffer.byteLength,
    contentType: contentType ?? "application/octet-stream",
  };
}

const saveMediaBufferSpy: Mock = vi.fn(defaultSaveMediaBuffer);

export function setNextSavedMediaPath(params: {
  path: string;
  id?: string;
  contentType?: string;
  size?: number;
}) {
  saveMediaBufferSpy.mockImplementationOnce(
    async (buffer: Buffer, detectedContentType?: string) => ({
      id: params.id ?? "media",
      path: params.path,
      size: params.size ?? buffer.byteLength,
      contentType: params.contentType ?? detectedContentType ?? "application/octet-stream",
    }),
  );
}

function resetSaveMediaBufferMock() {
  saveMediaBufferSpy.mockReset();
  saveMediaBufferSpy.mockImplementation(defaultSaveMediaBuffer);
}

type ApiStub = {
  config: { use: (arg: unknown) => void };
  getChat: Mock;
  sendChatAction: Mock;
  sendMessage: Mock;
  setMyCommands: (commands: Array<{ command: string; description: string }>) => Promise<void>;
};

const apiStub: ApiStub = {
  config: { use: useSpy },
  getChat: vi.fn(async () => undefined),
  sendChatAction: sendChatActionSpy,
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  setMyCommands: vi.fn(async () => undefined),
};

const throttlerSpy = vi.fn(() => "throttler");

export const telegramBotRuntimeForTest: TelegramBotRuntimeForTest = {
  Bot: class {
    api = apiStub;
    use = middlewareUseSpy;
    on = onSpy;
    command = vi.fn();
    stop = stopSpy;
    catch = vi.fn();
    constructor(public token: string) {}
  } as unknown as TelegramBotRuntimeForTest["Bot"],
  sequentialize: (() => vi.fn()) as TelegramBotRuntimeForTest["sequentialize"],
  apiThrottler: (() => throttlerSpy()) as unknown as TelegramBotRuntimeForTest["apiThrottler"],
};

const mediaHarnessReplySpy = vi.hoisted(() =>
  vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
    await opts?.onReplyStart?.();
    return undefined;
  }),
);
export { mediaHarnessReplySpy };

const mediaHarnessDispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() =>
  vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(async (params: DispatchReplyHarnessParams) => {
    await params.dispatcherOptions.typingCallbacks?.onReplyStart?.();
    const reply = await mediaHarnessReplySpy(params.ctx, params.replyOptions);
    const payloads = reply === undefined ? [] : Array.isArray(reply) ? reply : [reply];
    for (const payload of payloads) {
      await params.dispatcherOptions?.deliver?.(payload, { kind: "final" });
    }
    return {
      queuedFinal: payloads.length > 0,
      counts: { block: 0, final: payloads.length, tool: 0 },
    };
  }),
);

export const telegramBotDepsForTest: TelegramBotDeps = {
  getRuntimeConfig: (() =>
    ({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    }) as OpenClawConfig) as TelegramBotDeps["getRuntimeConfig"],
  resolveStorePath: vi.fn(
    (storePath?: string) => storePath ?? "/tmp/telegram-media-sessions.json",
  ) as TelegramBotDeps["resolveStorePath"],
  readChannelAllowFromStore: vi.fn(async () => []) as TelegramBotDeps["readChannelAllowFromStore"],
  upsertChannelPairingRequest: vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })) as TelegramBotDeps["upsertChannelPairingRequest"],
  enqueueSystemEvent: vi.fn() as TelegramBotDeps["enqueueSystemEvent"],
  dispatchReplyWithBufferedBlockDispatcher: mediaHarnessDispatchReplyWithBufferedBlockDispatcher,
  buildModelsProviderData: vi.fn(async () => ({
    byProvider: new Map<string, Set<string>>(),
    providers: [],
    resolvedDefault: { provider: "openai", model: "gpt-4.1" },
    modelNames: new Map<string, string>(),
  })) as TelegramBotDeps["buildModelsProviderData"],
  listSkillCommandsForAgents: vi.fn(() => []) as TelegramBotDeps["listSkillCommandsForAgents"],
  wasSentByBot: vi.fn(() => false) as TelegramBotDeps["wasSentByBot"],
};

beforeEach(() => {
  resetInboundDedupe();
  resetSaveMediaBufferMock();
  resetUndiciFetchMock();
  resetReadRemoteMediaBufferMock();
});

vi.doMock("./bot.runtime.js", () => ({
  ...telegramBotRuntimeForTest,
}));

vi.mock("undici", () => ({
  Agent: vi.fn(function MockAgent(this: { options?: unknown }, options?: unknown) {
    this.options = options;
  }),
  EnvHttpProxyAgent: vi.fn(function MockEnvHttpProxyAgent(
    this: { options?: unknown },
    options?: unknown,
  ) {
    this.options = options;
  }),
  ProxyAgent: vi.fn(function MockProxyAgent(this: { options?: unknown }, options?: unknown) {
    this.options = options;
  }),
  fetch: (...args: Parameters<typeof undiciFetchSpy>) => undiciFetchSpy(...args),
  setGlobalDispatcher: vi.fn(),
}));

vi.mock("./telegram-media.runtime.js", () => ({
  readRemoteMediaBuffer: (...args: Parameters<typeof readRemoteMediaBufferSpy>) =>
    readRemoteMediaBufferSpy(...args),
  getAgentScopedMediaLocalRoots: vi.fn(() => []),
  saveMediaBuffer: (...args: Parameters<typeof saveMediaBufferSpy>) => saveMediaBufferSpy(...args),
  saveRemoteMedia: async (...args: Parameters<typeof readRemoteMediaBufferSpy>) => {
    const fetched = (await readRemoteMediaBufferSpy(...args)) as {
      buffer: Buffer;
      contentType?: string;
      fileName?: string;
    };
    return await saveMediaBufferSpy(
      fetched.buffer,
      fetched.contentType,
      "inbound",
      args[0]?.maxBytes,
      args[0]?.originalFilename ?? fetched.fileName ?? args[0]?.filePathHint,
    );
  },
}));

vi.doMock("./bot-message-context.session.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./bot-message-context.session.runtime.js")>(
    "./bot-message-context.session.runtime.js",
  );
  return {
    ...actual,
    readSessionUpdatedAt: () => undefined,
    resolveStorePath: (storePath?: string) => storePath ?? "/tmp/sessions.json",
  };
});

vi.mock("./bot.agent.runtime.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "default"),
}));

vi.mock("./bot-handlers.agent.runtime.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveDefaultAgentId: vi.fn(() => "default"),
  resolveDefaultModelForAgent: vi.fn(() => ({
    provider: "openai",
    model: "gpt-test",
  })),
}));

vi.mock("./bot-message-dispatch.agent.runtime.js", () => ({
  findModelInCatalog: vi.fn(() => undefined),
  loadModelCatalog: vi.fn(async () => []),
  modelSupportsVision: vi.fn(() => false),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveDefaultModelForAgent: vi.fn(() => ({
    provider: "openai",
    model: "gpt-test",
  })),
}));
