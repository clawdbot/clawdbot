// Control UI Chat page owns slash command metadata loading.
import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  getRemoteCommandEntries,
  replaceSlashCommands,
  type SlashCommandDef,
} from "../../lib/chat/commands.ts";
import {
  scopedAgentIdForSession,
  visibleSessionMatches,
  type SessionCapability,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiDefaultAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { executeSlashCommand } from "./chat-command-executor.ts";
import { clearChatHistory } from "./chat-history.ts";
import { enqueuePendingRunMessage } from "./chat-queue.ts";
import { handleAbortChat } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

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
};

type ChatCommandSendOptions = ChatCommandResetOptions & {
  sendResetMessage: (message: string, opts: ChatCommandResetOptions) => Promise<void>;
};

type ChatCommandDispatchResult = "completed" | "failed" | "uncertain" | "cancelled" | "deferred";

export type ChatCommandHost = Parameters<typeof handleAbortChat>[0] &
  Parameters<typeof clearChatHistory>[0] & {
    sessions: SessionCapability;
    chatQueue: ChatQueueItem[];
    chatModelCatalog: ModelCatalogEntry[];
    sessionsResult?: SessionsListResult | null;
    sessionsResultAgentId?: string | null;
    createChatSession?: () => Promise<boolean>;
    confirmConversationReset?: () => Promise<boolean>;
    exportCurrentChat?: () => Promise<void> | void;
    refreshCurrentSessionTools?: () => Promise<void>;
    refreshCurrentChat?: () => Promise<void>;
  } & UiSessionDefaultsHost;

function setChatCommandError(
  host: { lastError?: string | null; chatError?: string | null },
  error: string | null,
) {
  host.lastError = error;
  host.chatError = error;
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

function storeRemoteSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
  commands: SlashCommandDef[],
) {
  getRemoteSlashCommandCache(client).set(remoteSlashCommandCacheKey(agentId), {
    commands,
    expiresAt: Date.now() + REMOTE_SLASH_COMMAND_CACHE_TTL_MS,
  });
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
    storeRemoteSlashCommands(client, agentId, commands);
    return commands;
  } catch {
    return fallback ?? buildFallbackSlashCommands();
  }
}

function loadRemoteSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
): Promise<SlashCommandDef[]> {
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
  const agentId = params.agentId?.trim();
  const commands = buildSlashCommandsFromEntries(getRemoteCommandEntries(params.result));
  if (params.client) {
    storeRemoteSlashCommands(params.client, agentId, commands);
  }
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

async function confirmConversationResetForCurrentSession(
  host: ChatCommandHost,
): Promise<"confirmed" | "cancelled" | "deferred"> {
  if (!host.confirmConversationReset) {
    return "confirmed";
  }
  const resetSessionKey = host.sessionKey;
  if (!(await host.confirmConversationReset())) {
    return "cancelled";
  }
  if (!areUiSessionKeysEquivalent(host.sessionKey, resetSessionKey)) {
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
      await handleAbortChat(host);
      return "completed";
    case "new":
      if (!host.createChatSession) {
        setChatCommandError(host, "New Chat is unavailable.");
        return "failed";
      }
      return (await host.createChatSession()) ? "completed" : "cancelled";
    case "reset": {
      const confirmation = await confirmConversationResetForCurrentSession(host);
      if (confirmation !== "confirmed") {
        return confirmation;
      }
      await opts.sendResetMessage(args ? `/reset ${args}` : "/reset", opts);
      return "completed";
    }
    case "clear": {
      const confirmation = await confirmConversationResetForCurrentSession(host);
      if (confirmation !== "confirmed") {
        return confirmation;
      }
      return await clearChatHistory(host);
    }
    case "export-session":
      await host.exportCurrentChat?.();
      return "completed";
  }

  if (!host.client || !host.connected) {
    setChatCommandError(host, "Gateway not connected");
    injectCommandResult(
      host,
      `Cannot run \`/${name}\`: Control UI is not connected to the Gateway.`,
    );
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], false, false, {
      contentChanged: true,
    });
    return "failed";
  }

  const targetClient = host.client;
  const targetConnectionEpoch = host.connectionEpoch;
  const targetSessionKey = host.sessionKey;
  const targetAgentId = scopedAgentIdForSession(host, targetSessionKey);
  const targetIsCurrent = () =>
    host.connected &&
    host.client === targetClient &&
    host.connectionEpoch === targetConnectionEpoch &&
    visibleSessionMatches(host, targetSessionKey, targetAgentId);
  let result: Awaited<ReturnType<typeof executeSlashCommand>>;
  try {
    result = await executeSlashCommand(targetClient, targetSessionKey, name, args, {
      sessions: host.sessions,
      chatModelCatalog: host.chatModelCatalog,
      sessionsResult: host.sessionsResult,
      sessionsResultAgentId: host.sessionsResultAgentId,
      defaultAgentId: resolveUiDefaultAgentId(host),
      agentId: targetAgentId,
    });
  } catch (err) {
    if (targetIsCurrent()) {
      setChatCommandError(host, String(err));
      injectCommandResult(host, `Command \`/${name}\` failed unexpectedly.`);
      scheduleChatScroll(
        host as unknown as Parameters<typeof scheduleChatScroll>[0],
        false,
        false,
        {
          contentChanged: true,
        },
      );
    }
    return "failed";
  }

  if (result.content && targetIsCurrent()) {
    injectCommandResult(host, result.content);
  }
  if (result.failed) {
    if (targetIsCurrent()) {
      setChatCommandError(host, result.content || `Command /${name} failed.`);
      scheduleChatScroll(
        host as unknown as Parameters<typeof scheduleChatScroll>[0],
        false,
        false,
        {
          contentChanged: Boolean(result.content),
        },
      );
    }
    return "failed";
  }

  if (result.trackRunId && targetIsCurrent()) {
    host.chatRunId = result.trackRunId;
    host.chatStream = "";
    host.chatSending = false;
  }

  if (result.pendingCurrentRun && host.chatRunId && targetIsCurrent()) {
    enqueuePendingRunMessage(host, `/${name} ${args}`.trim(), host.chatRunId);
  }

  if (result.sessionPatch && "modelOverride" in result.sessionPatch) {
    host.sessions.setModelOverride(
      targetSessionKey,
      result.sessionPatch.modelOverride?.value ?? null,
    );
    if (targetIsCurrent()) {
      await host.refreshCurrentSessionTools?.();
    }
  }

  if (result.action === "refresh" && targetIsCurrent()) {
    await host.refreshCurrentChat?.();
  }

  if (targetIsCurrent()) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], false, false, {
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
