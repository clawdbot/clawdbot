import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { vi } from "vitest";
import { formatEnvelopeTimestamp } from "../../../test/helpers/envelope-timestamp.js";
import type { MockBaileysSocket } from "../../../test/mocks/baileys.js";
import { createMockBaileys } from "../../../test/mocks/baileys.js";

// Use globalThis to store the mock config so it survives vi.mock hoisting
const CONFIG_KEY = Symbol.for("openclaw:testConfigMock");
const SOURCE_CONFIG_KEY = Symbol.for("openclaw:testSourceConfigMock");
const DEFAULT_CONFIG = {
  channels: {
    whatsapp: {
      // Tests can override; default remains open to avoid surprising fixtures
      allowFrom: ["*"],
    },
  },
  messages: {
    messagePrefix: undefined,
    responsePrefix: undefined,
  },
};

// Initialize default if not set
if (!(globalThis as Record<symbol, unknown>)[CONFIG_KEY]) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
}
if (!(globalThis as Record<symbol, unknown>)[SOURCE_CONFIG_KEY]) {
  (globalThis as Record<symbol, unknown>)[SOURCE_CONFIG_KEY] = () => loadConfigMock();
}

export function setLoadConfigMock(fn: unknown) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = typeof fn === "function" ? fn : () => fn;
}

export function setRuntimeConfigSourceSnapshotMock(fn: unknown) {
  (globalThis as Record<symbol, unknown>)[SOURCE_CONFIG_KEY] =
    typeof fn === "function" ? fn : () => fn;
}

export function resetLoadConfigMock() {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
  (globalThis as Record<symbol, unknown>)[SOURCE_CONFIG_KEY] = () => loadConfigMock();
}

function resolveStorePathFallback(store?: string, opts?: { agentId?: string }) {
  if (!store) {
    const agentId = normalizeLowercaseStringOrEmpty(opts?.agentId?.trim() || "main");
    return path.join(
      process.env.HOME ?? "/tmp",
      ".openclaw",
      "agents",
      agentId,
      "sessions",
      "sessions.json",
    );
  }
  return path.resolve(store.replaceAll("{agentId}", opts?.agentId?.trim() || "main"));
}

function loadConfigMock() {
  const getter = (globalThis as Record<symbol, unknown>)[CONFIG_KEY];
  if (typeof getter === "function") {
    return getter();
  }
  return DEFAULT_CONFIG;
}

function loadRuntimeConfigSourceSnapshotMock() {
  const getter = (globalThis as Record<symbol, unknown>)[SOURCE_CONFIG_KEY];
  if (typeof getter === "function") {
    return getter();
  }
  return loadConfigMock();
}

async function updateLastRouteMock(params: {
  storePath: string;
  sessionKey: string;
  deliveryContext: { channel: string; to: string; accountId?: string };
}) {
  const raw = await fs.readFile(params.storePath, "utf8").catch(() => "{}");
  const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  const current = store[params.sessionKey] ?? {};
  store[params.sessionKey] = {
    ...current,
    lastChannel: params.deliveryContext.channel,
    lastTo: params.deliveryContext.to,
    lastAccountId: params.deliveryContext.accountId,
  };
  await fs.writeFile(params.storePath, JSON.stringify(store));
}

function loadSessionStoreMock(storePath: string) {
  try {
    return JSON.parse(fsSync.readFileSync(storePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type BufferedDispatchReplyParams = {
  ctx: Record<string, unknown>;
  replyResolver: (
    ctx: Record<string, unknown>,
    opts?: BufferedReplyOptions,
  ) => Promise<Record<string, unknown> | undefined>;
  replyOptions?: BufferedReplyOptions;
  dispatcherOptions: {
    deliver: (
      payload: Record<string, unknown>,
      info: { kind: "tool" | "block" | "final" },
    ) => Promise<void>;
    onReplyStart?: (() => Promise<void>) | (() => void);
  };
};

type MockTypingController = {
  markDispatchIdle?: () => void;
  markRunComplete?: () => void;
};

type BufferedReplyOptions = Record<string, unknown> & {
  onTypingController?: (typing: MockTypingController) => void;
};

type TestEnvelopeOptions = {
  timezone?: string;
  includeTimestamp?: boolean;
  includeElapsed?: boolean;
  userTimezone?: string;
};

type TestInboundEnvelopeParams = {
  channel?: string;
  from?: string;
  body: string;
  timestamp?: number | Date;
  chatType?: string;
  senderLabel?: string;
  sender?: { name?: string; e164?: string; id?: string };
  previousTimestamp?: number | Date;
  envelope?: TestEnvelopeOptions;
  fromMe?: boolean;
};

function sanitizeEnvelopeHeaderPart(value: string) {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveEnvelopeOptionsMock(cfg?: {
  agents?: {
    defaults?: {
      envelopeTimezone?: string;
      envelopeTimestamp?: "on" | "off";
      envelopeElapsed?: "on" | "off";
      userTimezone?: string;
    };
  };
}): TestEnvelopeOptions {
  const defaults = cfg?.agents?.defaults;
  return {
    timezone: defaults?.envelopeTimezone,
    includeTimestamp: defaults?.envelopeTimestamp !== "off",
    includeElapsed: defaults?.envelopeElapsed !== "off",
    userTimezone: defaults?.userTimezone,
  };
}

function resolveEnvelopeTimestampMock(
  timestamp: number | Date | undefined,
  envelope?: TestEnvelopeOptions,
) {
  if (!timestamp || envelope?.includeTimestamp === false) {
    return undefined;
  }
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const zone = envelope?.timezone?.trim();
  if (zone === "user") {
    return formatEnvelopeTimestamp(date, envelope?.userTimezone?.trim() || "local");
  }
  return formatEnvelopeTimestamp(date, zone || "local");
}

function resolveSenderLabelMock(sender?: TestInboundEnvelopeParams["sender"]) {
  const display = sender?.name?.trim();
  const idPart = sender?.e164?.trim() || sender?.id?.trim();
  if (display && idPart && display !== idPart) {
    return `${display} (${idPart})`;
  }
  return display || idPart || undefined;
}

function formatInboundEnvelopeMock(params: TestInboundEnvelopeParams) {
  const chatType = normalizeLowercaseStringOrEmpty(params.chatType);
  const isDirect = !chatType || chatType === "direct";
  const sender = params.senderLabel?.trim() || resolveSenderLabelMock(params.sender);
  const body =
    isDirect && params.fromMe
      ? `(self): ${params.body}`
      : !isDirect && sender
        ? `${sanitizeEnvelopeHeaderPart(sender)}: ${params.body}`
        : params.body;
  const parts = [sanitizeEnvelopeHeaderPart(params.channel?.trim() || "Channel")];
  const from = params.from?.trim();
  if (from) {
    parts.push(sanitizeEnvelopeHeaderPart(from));
  }
  const timestamp = resolveEnvelopeTimestampMock(params.timestamp, params.envelope);
  if (timestamp) {
    parts.push(timestamp);
  }
  return `[${parts.join(" ")}] ${body}`;
}

function createChannelReplyPipelineMock() {
  return {
    onModelSelected: undefined,
    responsePrefix: undefined,
  };
}

function normalizePhoneLikeToE164(value: string) {
  const digits = value.replace(/\D+/g, "");
  return digits ? `+${digits}` : null;
}

function resolveIdentityNamePrefixMock(
  cfg: { messages?: { responsePrefix?: string } },
  _agentId: string,
) {
  return cfg.messages?.responsePrefix;
}

function resolveSendableOutboundReplyPartsMock(payload: Record<string, unknown>) {
  return {
    text: typeof payload.text === "string" ? payload.text : "",
    hasMedia:
      typeof payload.mediaUrl === "string" ||
      typeof payload.mediaPath === "string" ||
      typeof payload.fileUrl === "string",
  };
}

function toLocationContextMock(location: unknown) {
  return { Location: location };
}

function createBufferedDispatchReplyMock() {
  return vi.fn(async (params: BufferedDispatchReplyParams) => {
    let typingController: MockTypingController | undefined;
    const replyOptions: BufferedReplyOptions = {
      ...params.replyOptions,
      onTypingController: (typing) => {
        typingController = typing;
        params.replyOptions?.onTypingController?.(typing);
      },
    };
    await params.dispatcherOptions.onReplyStart?.();
    try {
      const payload = await params.replyResolver(params.ctx, replyOptions);
      if (!payload || typeof payload !== "object") {
        return {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
      }
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const hasMedia =
        typeof payload.mediaUrl === "string" ||
        typeof payload.mediaPath === "string" ||
        typeof payload.fileUrl === "string";
      if (!text && !hasMedia) {
        return {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
      }
      await params.dispatcherOptions.deliver(payload, { kind: "final" });
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    } finally {
      typingController?.markRunComplete?.();
      typingController?.markDispatchIdle?.();
    }
  });
}

function resolveChannelContextVisibilityModeMock(params: {
  cfg: {
    channels?: Record<
      string,
      { contextVisibility?: string; accounts?: Record<string, { contextVisibility?: string }> }
    >;
  };
  channel: string;
  accountId?: string | null;
  configuredContextVisibility?: string;
}) {
  if (params.configuredContextVisibility) {
    return params.configuredContextVisibility;
  }
  const channelConfig = params.cfg.channels?.[params.channel];
  const accountMode =
    (params.accountId
      ? channelConfig?.accounts?.[params.accountId]?.contextVisibility
      : undefined) ?? channelConfig?.accounts?.main?.contextVisibility;
  return accountMode ?? channelConfig?.contextVisibility ?? "all";
}

function resolveGroupSessionKeyMock(ctx: { From?: string; ChatType?: string; Provider?: string }) {
  const from = ctx.From?.trim() ?? "";
  const chatType = normalizeLowercaseStringOrEmpty(ctx.ChatType);
  const normalizedFrom = normalizeLowercaseStringOrEmpty(from);
  if (!from) {
    return null;
  }
  const isGroup =
    chatType === "group" ||
    chatType === "channel" ||
    from.includes(":group:") ||
    from.endsWith("@g.us");
  if (!isGroup) {
    return null;
  }
  return {
    key: `whatsapp:group:${normalizedFrom}`,
    channel: normalizeLowercaseStringOrEmpty(ctx.Provider) || "whatsapp",
    id: normalizedFrom,
    chatType: chatType === "channel" ? "channel" : "group",
  };
}

function resolveChannelGroupPolicyMock(params: {
  cfg: {
    channels?: {
      whatsapp?: {
        groups?: Record<string, Record<string, unknown>>;
        groupPolicy?: string;
        allowFrom?: string[];
        groupAllowFrom?: string[];
      };
    };
  };
  groupId?: string | null;
  hasGroupAllowFrom?: boolean;
}) {
  const whatsappCfg = params.cfg.channels?.whatsapp;
  const groups = whatsappCfg?.groups;
  const groupConfig = params.groupId ? groups?.[params.groupId] : undefined;
  const defaultConfig = groups?.["*"];
  const hasGroups = Boolean(groups && Object.keys(groups).length > 0);
  const allowAll = Boolean(defaultConfig);
  const groupPolicy = whatsappCfg?.groupPolicy ?? "disabled";
  const senderFilterBypass =
    groupPolicy === "allowlist" && !hasGroups && Boolean(params.hasGroupAllowFrom);
  const allowed =
    groupPolicy === "disabled"
      ? false
      : groupPolicy !== "allowlist" || allowAll || Boolean(groupConfig) || senderFilterBypass;
  return {
    allowlistEnabled: groupPolicy === "allowlist" || hasGroups,
    allowed,
    groupConfig,
    defaultConfig,
  };
}

function resolveChannelGroupRequireMentionMock(params: {
  cfg: {
    channels?: {
      whatsapp?: {
        groups?: Record<string, { requireMention?: boolean }>;
      };
    };
  };
  groupId?: string | null;
  requireMentionOverride?: boolean;
}) {
  const groups = params.cfg.channels?.whatsapp?.groups;
  const groupConfig = params.groupId ? groups?.[params.groupId] : undefined;
  const defaultConfig = groups?.["*"];
  if (typeof groupConfig?.requireMention === "boolean") {
    return groupConfig.requireMention;
  }
  if (typeof defaultConfig?.requireMention === "boolean") {
    return defaultConfig.requireMention;
  }
  if (typeof params.requireMentionOverride === "boolean") {
    return params.requireMentionOverride;
  }
  return true;
}

vi.mock("./auto-reply/config.runtime.js", () => ({
  getRuntimeConfigSourceSnapshot: loadRuntimeConfigSourceSnapshotMock,
  loadConfig: loadConfigMock,
  updateLastRoute: updateLastRouteMock,
  loadSessionStore: loadSessionStoreMock,
  recordSessionMetaFromInbound: async () => undefined,
  resolveStorePath: resolveStorePathFallback,
  evaluateSessionFreshness: () => ({ fresh: false }),
  resolveChannelContextVisibilityMode: resolveChannelContextVisibilityModeMock,
  resolveChannelGroupPolicy: resolveChannelGroupPolicyMock,
  resolveChannelGroupRequireMention: resolveChannelGroupRequireMentionMock,
  resolveChannelResetConfig: () => undefined,
  resolveGroupSessionKey: resolveGroupSessionKeyMock,
  resolveSessionKey: (_scope: string, msg: { From?: string }, mainKey?: string) =>
    msg.From?.trim() || mainKey || "main",
  resolveSessionResetPolicy: () => undefined,
  resolveSessionResetType: () => "message",
  resolveThreadFlag: () => false,
}));

vi.mock("./inbound/runtime-api.js", () => ({
  DisconnectReason: { loggedOut: 401 },
  isJidGroup: (jid: string) => typeof jid === "string" && jid.endsWith("@g.us"),
  normalizeMessageContent: (message: unknown) => message,
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("img")),
  saveMediaBuffer: vi.fn().mockImplementation(async (_buf: Buffer, contentType?: string) => ({
    id: "mid",
    path: "/tmp/mid",
    size: _buf.length,
    contentType,
  })),
}));

vi.mock("./auto-reply/monitor/inbound-dispatch.runtime.js", () => ({
  createChannelReplyPipeline: createChannelReplyPipelineMock,
  dispatchReplyWithBufferedBlockDispatcher: createBufferedDispatchReplyMock(),
  finalizeInboundContext: <T>(ctx: T) => ctx,
  getAgentScopedMediaLocalRoots: () => [] as string[],
  jidToE164: normalizePhoneLikeToE164,
  logVerbose: (_msg: string) => undefined,
  resolveChunkMode: () => undefined,
  resolveIdentityNamePrefix: resolveIdentityNamePrefixMock,
  resolveInboundLastRouteSessionKey: (params: { sessionKey: string }) => params.sessionKey,
  resolveMarkdownTableMode: () => undefined,
  resolveSendableOutboundReplyParts: resolveSendableOutboundReplyPartsMock,
  resolveTextChunkLimit: () => 64_000,
  shouldLogVerbose: () => false,
  toLocationContext: toLocationContextMock,
}));

vi.mock("./auto-reply/monitor/runtime-api.js", () => ({
  buildHistoryContextFromEntries: (params: {
    entries: Array<{ sender?: string; body: string; timestamp?: number }>;
    currentMessage: string;
    formatEntry?: (entry: { sender?: string; body: string; timestamp?: number }) => string;
  }) => {
    const rendered = params.entries
      .map((entry) => params.formatEntry?.(entry) ?? `${entry.sender ?? "Unknown"}: ${entry.body}`)
      .join("\n");
    return rendered
      ? `Chat messages since your last reply:\n${rendered}\n\n${params.currentMessage}`
      : params.currentMessage;
  },
  createChannelReplyPipeline: createChannelReplyPipelineMock,
  dispatchReplyWithBufferedBlockDispatcher: createBufferedDispatchReplyMock(),
  finalizeInboundContext: <T>(ctx: T) => ctx,
  formatInboundEnvelope: formatInboundEnvelopeMock,
  getAgentScopedMediaLocalRoots: () => [] as string[],
  jidToE164: normalizePhoneLikeToE164,
  logVerbose: (_msg: string) => undefined,
  normalizeE164: normalizePhoneLikeToE164,
  readStoreAllowFromForDmPolicy: async () => [] as string[],
  recordSessionMetaFromInbound: async () => undefined,
  resolveChannelContextVisibilityMode: resolveChannelContextVisibilityModeMock,
  resolveChunkMode: () => undefined,
  resolveIdentityNamePrefix: resolveIdentityNamePrefixMock,
  resolveInboundLastRouteSessionKey: (params: { sessionKey: string }) => params.sessionKey,
  resolveInboundSessionEnvelopeContext: (params: {
    cfg: { session?: { store?: string } } & Parameters<typeof resolveEnvelopeOptionsMock>[0];
    agentId: string;
  }) => ({
    storePath: resolveStorePathFallback(params.cfg.session?.store, { agentId: params.agentId }),
    envelopeOptions: resolveEnvelopeOptionsMock(params.cfg),
    previousTimestamp: undefined,
  }),
  resolveMarkdownTableMode: () => undefined,
  resolvePinnedMainDmOwnerFromAllowlist: (params: {
    allowFrom?: string[];
    normalizeEntry: (entry: string) => string | null;
  }) => {
    const first = params.allowFrom?.[0];
    return first ? params.normalizeEntry(first) : null;
  },
  resolveDmGroupAccessWithCommandGate: () => ({ commandAuthorized: true }),
  resolveSendableOutboundReplyParts: resolveSendableOutboundReplyPartsMock,
  resolveTextChunkLimit: () => 64_000,
  shouldComputeCommandAuthorized: () => false,
  shouldLogVerbose: () => false,
  toLocationContext: toLocationContextMock,
}));

vi.mock("./auto-reply/monitor/group-gating.runtime.js", () => ({
  hasControlCommand: (body: string) => body.trim().startsWith("/"),
  implicitMentionKindWhen: (kind: string, enabled: boolean) => (enabled ? [kind] : []),
  normalizeE164: normalizePhoneLikeToE164,
  parseActivationCommand: (body: string) => ({
    hasCommand: body.trim().startsWith("/"),
  }),
  recordPendingHistoryEntryIfEnabled: (params: {
    historyMap: Map<string, unknown[]>;
    historyKey: string;
    limit: number;
    entry: unknown;
  }) => {
    const current = params.historyMap.get(params.historyKey) ?? [];
    const next = [...current, params.entry].slice(-params.limit);
    params.historyMap.set(params.historyKey, next);
  },
  resolveInboundMentionDecision: (params: {
    facts?: {
      canDetectMention: boolean;
      wasMentioned: boolean;
      implicitMentionKinds?: string[];
    };
    policy?: {
      isGroup: boolean;
      requireMention: boolean;
      allowTextCommands: boolean;
      hasControlCommand: boolean;
      commandAuthorized: boolean;
    };
    isGroup?: boolean;
    requireMention?: boolean;
    canDetectMention?: boolean;
    wasMentioned?: boolean;
    implicitMentionKinds?: string[];
    allowTextCommands?: boolean;
    hasControlCommand?: boolean;
    commandAuthorized?: boolean;
  }) => {
    const facts =
      "facts" in params && params.facts
        ? params.facts
        : {
            canDetectMention: Boolean(params.canDetectMention),
            wasMentioned: Boolean(params.wasMentioned),
            implicitMentionKinds: params.implicitMentionKinds,
          };
    const policy =
      "policy" in params && params.policy
        ? params.policy
        : {
            isGroup: Boolean(params.isGroup),
            requireMention: Boolean(params.requireMention),
            allowTextCommands: Boolean(params.allowTextCommands),
            hasControlCommand: Boolean(params.hasControlCommand),
            commandAuthorized: Boolean(params.commandAuthorized),
          };
    const effectiveWasMentioned = facts.wasMentioned || Boolean(facts.implicitMentionKinds?.length);
    return {
      effectiveWasMentioned,
      shouldSkip:
        policy.isGroup && policy.requireMention && facts.canDetectMention && !effectiveWasMentioned,
      shouldBypassMention: false,
      implicitMention: Boolean(facts.implicitMentionKinds?.length),
      matchedImplicitMentionKinds: facts.implicitMentionKinds ?? [],
    };
  },
}));

vi.mock("./auto-reply/monitor/group-activation.runtime.js", () => ({
  normalizeGroupActivation: (value: unknown) =>
    value === "always" || value === "mention" ? value : undefined,
}));

vi.mock("./auto-reply/monitor/message-line.runtime.js", () => ({
  formatInboundEnvelope: formatInboundEnvelopeMock,
  resolveMessagePrefix: (
    cfg: {
      channels?: { whatsapp?: { messagePrefix?: string; allowFrom?: string[] } };
      messages?: { messagePrefix?: string };
    },
    _agentId: string,
    params?: { configured?: string; hasAllowFrom?: boolean },
  ) => {
    const configured = params?.configured ?? cfg.messages?.messagePrefix;
    if (configured !== undefined) {
      return configured;
    }
    return params?.hasAllowFrom === true ? "" : "[openclaw]";
  },
}));

vi.mock("./auth-store.runtime.js", () => ({
  resolveOAuthDir: () => "/tmp/openclaw-oauth",
}));

vi.mock("./session.runtime.js", () => {
  const created = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    created.lastSocket;
  return {
    ...created.mod,
  };
});

vi.mock("./qr-terminal.js", () => ({
  renderQrTerminal: vi.fn(async () => "ASCII-QR"),
}));

export const baileys = await import("./session.runtime.js");

function resetMockExport<T extends (...args: never[]) => unknown>(params: {
  current: T;
  implementation: T;
}) {
  if (!("mockReset" in params.current) || typeof params.current.mockReset !== "function") {
    return;
  }
  params.current.mockReset();
  if (
    "mockImplementation" in params.current &&
    typeof params.current.mockImplementation === "function"
  ) {
    params.current.mockImplementation(params.implementation);
  }
}

export function resetBaileysMocks() {
  const recreated = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    recreated.lastSocket;

  const makeWASocket = vi.mocked(baileys.makeWASocket);
  const makeWASocketImpl: typeof baileys.makeWASocket = (...args) =>
    (recreated.mod.makeWASocket as unknown as typeof baileys.makeWASocket)(...args);
  resetMockExport({
    current: makeWASocket,
    implementation: makeWASocketImpl,
  });

  const useMultiFileAuthState = vi.mocked(baileys.useMultiFileAuthState);
  const useMultiFileAuthStateImpl: typeof baileys.useMultiFileAuthState = (...args) =>
    (recreated.mod.useMultiFileAuthState as unknown as typeof baileys.useMultiFileAuthState)(
      ...args,
    );
  resetMockExport({
    current: useMultiFileAuthState,
    implementation: useMultiFileAuthStateImpl,
  });

  const fetchLatestBaileysVersion = vi.mocked(baileys.fetchLatestBaileysVersion);
  const fetchLatestBaileysVersionImpl: typeof baileys.fetchLatestBaileysVersion = (...args) =>
    (
      recreated.mod.fetchLatestBaileysVersion as unknown as typeof baileys.fetchLatestBaileysVersion
    )(...args);
  resetMockExport({
    current: fetchLatestBaileysVersion,
    implementation: fetchLatestBaileysVersionImpl,
  });

  const makeCacheableSignalKeyStore = vi.mocked(baileys.makeCacheableSignalKeyStore);
  const makeCacheableSignalKeyStoreImpl: typeof baileys.makeCacheableSignalKeyStore = (...args) =>
    (
      recreated.mod
        .makeCacheableSignalKeyStore as unknown as typeof baileys.makeCacheableSignalKeyStore
    )(...args);
  resetMockExport({
    current: makeCacheableSignalKeyStore,
    implementation: makeCacheableSignalKeyStoreImpl,
  });
}

export function getLastSocket(): MockBaileysSocket {
  const getter = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")];
  if (typeof getter === "function") {
    return (getter as () => MockBaileysSocket)();
  }
  if (!getter) {
    throw new Error("Baileys mock not initialized");
  }
  throw new Error("Invalid Baileys socket getter");
}
