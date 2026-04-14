import type { BuildTelegramMessageContextParams, TelegramMediaRef } from "./bot-message-context.js";

export const baseTelegramMessageContextConfig = {
  agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
  channels: { telegram: {} },
  messages: { groupChat: { mentionPatterns: [] } },
} as never;

type TelegramTestSessionRuntime = NonNullable<BuildTelegramMessageContextParams["sessionRuntime"]>;
const finalizeInboundContextForTest = ((ctx) => {
  const next = ctx as Record<string, unknown>;
  const body = typeof next.Body === "string" ? next.Body : "";
  next.Body = body;
  next.BodyForAgent =
    typeof next.BodyForAgent === "string"
      ? next.BodyForAgent
      : typeof next.RawBody === "string"
        ? next.RawBody
        : body;
  next.BodyForCommands =
    typeof next.BodyForCommands === "string"
      ? next.BodyForCommands
      : typeof next.CommandBody === "string"
        ? next.CommandBody
        : typeof next.RawBody === "string"
          ? next.RawBody
          : body;
  next.CommandAuthorized = Boolean(next.CommandAuthorized);
  return next;
}) as NonNullable<TelegramTestSessionRuntime["finalizeInboundContext"]>;

type BuildTelegramMessageContextForTestParams = {
  message: Record<string, unknown>;
  allMedia?: TelegramMediaRef[];
  options?: BuildTelegramMessageContextParams["options"];
  cfg?: Record<string, unknown>;
  accountId?: string;
  runtime?: BuildTelegramMessageContextParams["runtime"];
  sessionRuntime?: BuildTelegramMessageContextParams["sessionRuntime"] | null;
  resolveGroupActivation?: BuildTelegramMessageContextParams["resolveGroupActivation"];
  resolveGroupRequireMention?: BuildTelegramMessageContextParams["resolveGroupRequireMention"];
  resolveTelegramGroupConfig?: BuildTelegramMessageContextParams["resolveTelegramGroupConfig"];
};

const telegramMessageContextSessionRuntimeForTest = {
  finalizeInboundContext: finalizeInboundContextForTest,
  readSessionUpdatedAt: () => undefined,
  recordInboundSession: async () => undefined,
  resolveInboundLastRouteSessionKey: ({ route, sessionKey }) =>
    route.lastRoutePolicy === "main" ? route.mainSessionKey : sessionKey,
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  resolveStorePath: () => "/tmp/openclaw/session-store.json",
} satisfies NonNullable<BuildTelegramMessageContextParams["sessionRuntime"]>;

export async function buildTelegramMessageContextForTest(
  params: BuildTelegramMessageContextForTestParams,
): Promise<
  Awaited<ReturnType<typeof import("./bot-message-context.js").buildTelegramMessageContext>>
> {
  const { vi } = await loadVitestModule();
  const buildTelegramMessageContext = await loadBuildTelegramMessageContext();
  const sessionRuntime =
    params.sessionRuntime === null
      ? undefined
      : {
          ...telegramMessageContextSessionRuntimeForTest,
          ...params.sessionRuntime,
        };
  return await buildTelegramMessageContext({
    primaryCtx: {
      message: {
        message_id: 1,
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
        ...params.message,
      },
      me: { id: 7, username: "bot" },
    } as never,
    allMedia: params.allMedia ?? [],
    storeAllowFrom: [],
    options: params.options ?? {},
    bot: {
      api: {
        sendChatAction: vi.fn(),
        setMessageReaction: vi.fn(),
      },
    } as never,
    cfg: (params.cfg ?? baseTelegramMessageContextConfig) as never,
    loadFreshConfig: () => (params.cfg ?? baseTelegramMessageContextConfig) as never,
    runtime: {
      recordChannelActivity: () => undefined,
      ...params.runtime,
    },
    sessionRuntime,
    account: { accountId: params.accountId ?? "default" } as never,
    historyLimit: 0,
    groupHistories: new Map(),
    dmPolicy: "open",
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "off",
    logger: { info: vi.fn() },
    resolveGroupActivation: params.resolveGroupActivation ?? (() => undefined),
    resolveGroupRequireMention: params.resolveGroupRequireMention ?? (() => false),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      (() => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      })),
    sendChatActionHandler: { sendChatAction: vi.fn() } as never,
  });
}

let buildTelegramMessageContextLoader:
  | typeof import("./bot-message-context.js").buildTelegramMessageContext
  | undefined;
let vitestModuleLoader: Promise<typeof import("vitest")> | undefined;
let messageContextMocksInstalled = false;

async function loadBuildTelegramMessageContext() {
  await installMessageContextTestMocks();
  if (!buildTelegramMessageContextLoader) {
    ({ buildTelegramMessageContext: buildTelegramMessageContextLoader } =
      await import("./bot-message-context.js"));
  }
  return buildTelegramMessageContextLoader;
}

async function loadVitestModule() {
  vitestModuleLoader ??= import("vitest");
  return await vitestModuleLoader;
}

async function installMessageContextTestMocks() {
  if (messageContextMocksInstalled) {
    return;
  }
  messageContextMocksInstalled = true;
}
