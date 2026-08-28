// Control UI Chat page owns slash command metadata loading.
import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { peekChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  getRemoteCommandEntries,
  replaceSlashCommands,
  type SlashCommandDef,
} from "../../lib/chat/commands.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  scopedAgentIdForSession,
  visibleSessionMatches,
  type SessionCapability,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { executeSlashCommand } from "./chat-command-executor.ts";
import { clearChatHistory } from "./chat-history.ts";
import { enqueuePendingRunMessage } from "./chat-queue.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import type { ChatExportResult } from "./export.ts";
import { handleAbortChat } from "./run-lifecycle.ts";
import { scheduleChatScroll, type ChatScrollHost } from "./scroll.ts";

let refreshSeq = 0;
const REMOTE_SLASH_COMMAND_CACHE_TTL_MS = 60_000;

type RemoteSlashCommandCacheEntry = {
  commands?: SlashCommandDef[];
  expiresAt: number;
  inFlight?: Promise<SlashCommandDef[]>;
};

const remoteSlashCommandCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, RemoteSlashCommandCacheEntry>
>();

export type ChatCommandResetOptions = {
  previousDraft?: string;
  restoreDraft?: boolean;
  target?: ChatCommandTarget;
};

type ChatCommandSendOptions = ChatCommandResetOptions & {
  sendResetMessage: (message: string, opts: ChatCommandResetOptions) => Promise<void>;
};

type ChatCommandDispatchResult = "completed" | "failed" | "uncertain" | "cancelled" | "deferred";

export type ChatCommandTarget = {
  client: GatewayBrowserClient;
  connectionEpoch: number;
  sessionKey: string;
  agentId?: string;
};

export type ChatCommandHost = Parameters<typeof handleAbortChat>[0] &
  Parameters<typeof clearChatHistory>[0] & {
    sessions: SessionCapability;
    chatQueue: ChatQueueItem[];
    chatModelCatalog: ModelCatalogEntry[];
    sessionsResult?: SessionsListResult | null;
    sessionsResultAgentId?: string | null;
    createChatSession?: () => Promise<boolean>;
    confirmConversationReset?: () => Promise<boolean>;
    exportCurrentChat?: () => Promise<ChatExportResult> | ChatExportResult;
    refreshCurrentSessionTools?: () => Promise<void>;
    refreshCurrentChat?: () => Promise<void>;
  } & UiSessionDefaultsHost &
  ChatScrollHost;

function setChatCommandError(
  host: { lastError?: string | null; chatError?: string | null },
  error: string | null,
) {
  const message = error === null ? null : formatUiError(error);
  host.lastError = message;
  host.chatError = message;
}

function currentSessionAccessSnapshot(
  host: ChatCommandHost,
): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  return {
    client: host.client ?? null,
    hello: host.hello ?? null,
    phase: host.connected ? "connected" : "offline",
  };
}

export function requireChatSessionAction(
  host: ChatCommandHost,
  action: "abort" | "compact" | "reset",
): boolean {
  const access = readChatSessionActionAccess(
    currentSessionAccessSnapshot(host),
    Boolean(host.chatRunId),
  )[action];
  if (access.allowed) {
    return true;
  }
  setChatCommandError(host, access.reason);
  return false;
}

export function captureChatCommandTarget(host: ChatCommandHost): ChatCommandTarget | null {
  if (!host.client || !host.connected) {
    return null;
  }
  return {
    client: host.client,
    connectionEpoch: host.connectionEpoch,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
  };
}

function isChatCommandConnectionCurrent(host: ChatCommandHost, target: ChatCommandTarget): boolean {
  return (
    host.connected &&
    host.client === target.client &&
    host.connectionEpoch === target.connectionEpoch
  );
}

function isChatCommandTargetCurrent(host: ChatCommandHost, target: ChatCommandTarget): boolean {
  return (
    isChatCommandConnectionCurrent(host, target) &&
    visibleSessionMatches(host, target.sessionKey, target.agentId)
  );
}

function isChatCommandModelCacheOwnerCurrent(
  host: ChatCommandHost,
  target: ChatCommandTarget,
): boolean {
  if (!isChatCommandConnectionCurrent(host, target)) {
    return false;
  }
  // The selected-agent global session shares one UI cache key across agents.
  // Keep delayed results out when that selection changes on the same Gateway.
  return (
    !isUiSelectedGlobalSessionKey(host, target.sessionKey) ||
    resolveUiSelectedGlobalAgentId(host) === target.agentId
  );
}

export function readChatResetTargetAccess(
  host: ChatCommandHost,
  target: ChatCommandTarget,
): { allowed: true } | { allowed: false; reason: string } {
  if (!isChatCommandTargetCurrent(host, target)) {
    return { allowed: false, reason: "The Gateway connection changed. Retry the command." };
  }
  const access = readSessionMethodAccess(currentSessionAccessSnapshot(host), {
    method: "chat.send",
    requiredScope: "operator.admin",
  });
  return access.allowed ? { allowed: true } : access;
}

function requireChatResetTarget(host: ChatCommandHost, target: ChatCommandTarget): boolean {
  const access = readChatResetTargetAccess(host, target);
  if (access.allowed) {
    return true;
  }
  setChatCommandError(host, access.reason);
  return false;
}

function failStaleChatCommand(host: ChatCommandHost): ChatCommandDispatchResult {
  setChatCommandError(host, "The Gateway connection changed. Retry the command.");
  return "failed";
}

function remoteSlashCommandCacheKey(agentId: string | undefined): string {
  return agentId ?? "";
}

function getRemoteSlashCommandCache(
  client: GatewayBrowserClient,
): Map<string, RemoteSlashCommandCacheEntry> {
  let cache = remoteSlashCommandCache.get(client);
  if (!cache) {
    cache = new Map();
    remoteSlashCommandCache.set(client, cache);
  }
  return cache;
}

async function requestRemoteSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
  fallback: SlashCommandDef[] | undefined,
): Promise<SlashCommandDef[]> {
  try {
    const result = await client.request<CommandsListResult>("commands.list", {
      ...(agentId ? { agentId } : {}),
      includeArgs: true,
      scope: "text",
    });
    if (!Array.isArray(result?.commands)) {
      return buildFallbackSlashCommands();
    }
    const commands = buildSlashCommandsFromEntries(getRemoteCommandEntries(result));
    getRemoteSlashCommandCache(client).set(remoteSlashCommandCacheKey(agentId), {
      commands,
      expiresAt: Date.now() + REMOTE_SLASH_COMMAND_CACHE_TTL_MS,
    });
    return commands;
  } catch {
    return fallback ?? buildFallbackSlashCommands();
  }
}

function loadRemoteSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
): Promise<SlashCommandDef[]> {
  const metadata = peekChatMetadata(client, agentId);
  // Store-held metadata carries app-level invalidation on config changes and logical reconnects,
  // so no TTL applies here. The cache below owns only commands.list-derived entries.
  if (Array.isArray(metadata?.commands)) {
    return Promise.resolve(buildSlashCommandsFromEntries(getRemoteCommandEntries(metadata)));
  }
  const cache = getRemoteSlashCommandCache(client);
  const key = remoteSlashCommandCacheKey(agentId);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached?.commands && cached.expiresAt > now) {
    return Promise.resolve(cached.commands);
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }
  const inFlight = requestRemoteSlashCommands(client, agentId, cached?.commands).finally(() => {
    const latest = cache.get(key);
    if (latest?.inFlight === inFlight) {
      delete latest.inFlight;
    }
  });
  cache.set(key, {
    ...(cached?.commands ? { commands: cached.commands } : {}),
    expiresAt: cached?.expiresAt ?? 0,
    inFlight,
  });
  return inFlight;
}

export function applyRemoteSlashCommandsResult(params: {
  client: GatewayBrowserClient | null;
  agentId?: string | null;
  result: CommandsListResult | null | undefined;
}): boolean {
  if (!Array.isArray(params.result?.commands)) {
    return false;
  }
  const commands = buildSlashCommandsFromEntries(getRemoteCommandEntries(params.result));
  refreshSeq += 1;
  replaceSlashCommands(commands);
  return true;
}

export async function refreshSlashCommands(params: {
  client: GatewayBrowserClient | null;
  agentId?: string | null;
  shouldApply?: () => boolean;
}): Promise<void> {
  const seq = ++refreshSeq;
  const agentId = params.agentId?.trim();
  if (!params.client) {
    if (seq !== refreshSeq || params.shouldApply?.() === false) {
      return;
    }
    replaceSlashCommands(buildFallbackSlashCommands());
    return;
  }
  const commands = await loadRemoteSlashCommands(params.client, agentId);
  if (seq !== refreshSeq || params.shouldApply?.() === false) {
    return;
  }
  replaceSlashCommands(commands);
}

export function shouldQueueLocalSlashCommand(name: string): boolean {
  return !["stop", "export-session", "steer", "redirect", "new"].includes(name);
}

export async function confirmConversationResetForCurrentSession(
  host: ChatCommandHost,
  target?: { sessionKey: string; agentId?: string },
): Promise<"confirmed" | "cancelled" | "deferred"> {
  const resetSessionKey = target?.sessionKey ?? host.sessionKey;
  const targetIsCurrent = target
    ? () => visibleSessionMatches(host, target.sessionKey, target.agentId)
    : () =>
        host.sessionKey === resetSessionKey ||
        areUiSessionKeysEquivalent(host.sessionKey, resetSessionKey);
  if (!targetIsCurrent()) {
    return "deferred";
  }
  if (!host.confirmConversationReset) {
    return "confirmed";
  }
  const confirmed = await host.confirmConversationReset();
  if (!targetIsCurrent()) {
    return target ? "deferred" : "cancelled";
  }
  if (!confirmed) {
    return "cancelled";
  }
  return host.chatRunId ? "deferred" : "confirmed";
}

export async function dispatchChatSlashCommand(
  host: ChatCommandHost,
  name: string,
  args: string,
  opts: ChatCommandSendOptions,
): Promise<ChatCommandDispatchResult> {
  switch (name) {
    case "stop":
      if (!requireChatSessionAction(host, "abort")) {
        return "failed";
      }
      await handleAbortChat(host);
      return "completed";
    case "new":
      if (!host.createChatSession) {
        setChatCommandError(host, "New Chat is unavailable.");
        return "failed";
      }
      return (await host.createChatSession()) ? "completed" : "cancelled";
    case "reset": {
      const target = captureChatCommandTarget(host);
      if (!target || !requireChatResetTarget(host, target)) {
        return "failed";
      }
      const confirmation = await confirmConversationResetForCurrentSession(host);
      if (confirmation !== "confirmed") {
        return confirmation;
      }
      if (!requireChatResetTarget(host, target)) {
        return "failed";
      }
      await opts.sendResetMessage(args ? `/reset ${args}` : "/reset", {
        previousDraft: opts.previousDraft,
        restoreDraft: opts.restoreDraft,
        target,
      });
      return "completed";
    }
    case "clear": {
      if (!requireChatSessionAction(host, "reset")) {
        return "failed";
      }
      const target = captureChatCommandTarget(host);
      if (!target) {
        return "failed";
      }
      const confirmation = await confirmConversationResetForCurrentSession(host);
      if (confirmation !== "confirmed") {
        return confirmation;
      }
      if (!isChatCommandTargetCurrent(host, target)) {
        return failStaleChatCommand(host);
      }
      if (!requireChatSessionAction(host, "reset")) {
        return "failed";
      }
      return await clearChatHistory(host);
    }
    case "compact":
      if (!requireChatSessionAction(host, "compact")) {
        return "failed";
      }
      break;
    case "export-session":
      if ((await host.exportCurrentChat?.()) === "empty") {
        injectCommandResult(host, t("chat.commandResults.emptyExport"));
        scheduleChatScroll(host, false, false, { contentChanged: true });
      }
      return "completed";
  }

  if (!host.client || !host.connected) {
    setChatCommandError(host, "Gateway not connected");
    injectCommandResult(
      host,
      `Cannot run \`/${name}\`: Control UI is not connected to the Gateway.`,
    );
    scheduleChatScroll(host, false, false, {
      contentChanged: true,
    });
    return "failed";
  }

  const target = captureChatCommandTarget(host);
  if (!target) {
    return "failed";
  }
  const targetIsCurrent = () => isChatCommandTargetCurrent(host, target);
  let result: Awaited<ReturnType<typeof executeSlashCommand>>;
  try {
    result = await executeSlashCommand(target.client, target.sessionKey, name, args, {
      sessions: host.sessions,
      sessionAccessSnapshot: currentSessionAccessSnapshot(host),
      readSessionAccessSnapshot: () => currentSessionAccessSnapshot(host),
      isCurrent: targetIsCurrent,
      chatModelCatalog: host.chatModelCatalog,
      sessionsResult: host.sessionsResult,
      sessionsResultAgentId: host.sessionsResultAgentId,
      defaultAgentId: resolveUiDefaultAgentId(host),
      agentId: target.agentId,
      ownsModelOverride: () => isChatCommandModelCacheOwnerCurrent(host, target),
    });
  } catch (err) {
    if (targetIsCurrent()) {
      setChatCommandError(host, formatUiError(err));
      injectCommandResult(host, `Command \`/${name}\` failed unexpectedly.`);
      scheduleChatScroll(host, false, false, {
        contentChanged: true,
      });
    }
    return "failed";
  }

  if (result.content && targetIsCurrent()) {
    injectCommandResult(host, result.content);
  }
  if (result.failed) {
    if (targetIsCurrent()) {
      setChatCommandError(host, result.content || `Command /${name} failed.`);
      scheduleChatScroll(host, false, false, {
        contentChanged: Boolean(result.content),
      });
    }
    return "failed";
  }

  if (result.trackRunId && targetIsCurrent()) {
    host.chatRunId = result.trackRunId;
    host.chatStream = "";
    host.chatSending = false;
  }

  if (result.pendingCurrentRun && host.chatRunId && targetIsCurrent()) {
    enqueuePendingRunMessage(
      host,
      `/${name} ${args}`.trim(),
      host.chatRunId,
      undefined,
      resolveCurrentUserIdentity(host.hello, host.client?.instanceId) ?? undefined,
    );
  }

  if (result.modelChanged) {
    if (targetIsCurrent()) {
      await host.refreshCurrentSessionTools?.();
    }
  }

  if (result.action === "refresh" && targetIsCurrent()) {
    await host.refreshCurrentChat?.();
  }

  if (targetIsCurrent()) {
    scheduleChatScroll(host, false, false, {
      contentChanged: Boolean(result.content),
    });
  }
  return "completed";
}

function injectCommandResult(host: ChatCommandHost, content: string) {
  host.chatMessages = [
    ...host.chatMessages,
    {
      role: "system",
      content,
      timestamp: Date.now(),
    },
  ];
}
