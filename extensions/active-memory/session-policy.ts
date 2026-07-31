import crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRememberAcrossConversations } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  normalizePluginsConfig,
  resolvePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey, parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import { asOptionalRecord as asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCanonicalSessionKeyFromSessionId } from "./session.js";
import {
  DEFAULT_AGENT_ID,
  type ActiveMemoryChatType,
  type ActiveMemoryToggleEntry,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

function activeMemoryToggleKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

function openActiveMemoryToggleStore(api: OpenClawPluginApi) {
  return api.runtime.state.openKeyedStore<ActiveMemoryToggleEntry>({
    namespace: "session-toggles",
    maxEntries: 10_000,
  });
}

async function isSessionActiveMemoryDisabled(params: {
  api: OpenClawPluginApi;
  sessionKey?: string;
}): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  try {
    const store = openActiveMemoryToggleStore(params.api);
    const key = activeMemoryToggleKey(sessionKey);
    const stored = await store.lookup(key);
    if (stored?.disabled === true) {
      return true;
    }
    return false;
  } catch (error) {
    params.api.logger.debug?.(
      `active-memory: failed to read session toggle (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

async function setSessionActiveMemoryDisabled(params: {
  api: OpenClawPluginApi;
  sessionKey: string;
  disabled: boolean;
}): Promise<void> {
  const store = openActiveMemoryToggleStore(params.api);
  if (params.disabled) {
    await store.register(activeMemoryToggleKey(params.sessionKey), {
      sessionKey: params.sessionKey,
      disabled: true,
      updatedAt: Date.now(),
    });
  } else {
    await store.delete(activeMemoryToggleKey(params.sessionKey));
  }
}

function resolveCommandSessionKey(params: {
  api: OpenClawPluginApi;
  config: ResolvedActiveRecallPluginConfig;
  sessionKey?: string;
  sessionId?: string;
}): string | undefined {
  const explicit = params.sessionKey?.trim();
  if (explicit) {
    return explicit;
  }
  const configuredAgents =
    params.config.agents.length > 0 ? params.config.agents : [DEFAULT_AGENT_ID];
  for (const agentId of configuredAgents) {
    const sessionKey = resolveCanonicalSessionKeyFromSessionId({
      api: params.api,
      agentId,
      sessionId: params.sessionId,
    });
    if (sessionKey) {
      return sessionKey;
    }
  }
  return undefined;
}

function formatActiveMemoryCommandHelp(): string {
  return [
    "Active Memory session toggle:",
    "/active-memory status",
    "/active-memory on",
    "/active-memory off",
    "",
    "Global config toggle:",
    "/active-memory status --global",
    "/active-memory on --global",
    "/active-memory off --global",
  ].join("\n");
}

function isActiveMemoryGloballyEnabled(cfg: OpenClawConfig): boolean {
  const entry = asRecord(cfg.plugins?.entries?.["active-memory"]);
  if (entry?.enabled === false) {
    return false;
  }
  const pluginConfig = resolvePluginConfigObject(cfg, "active-memory");
  return pluginConfig?.enabled !== false;
}

function isActiveMemoryPluginEnabled(cfg: OpenClawConfig): boolean {
  const plugins = normalizePluginsConfig(cfg.plugins);
  if (!plugins.enabled || plugins.deny.includes("active-memory")) {
    return false;
  }
  if (plugins.allow.length > 0 && !plugins.allow.includes("active-memory")) {
    return false;
  }
  return plugins.entries["active-memory"]?.enabled !== false;
}

function hasRememberAcrossConversationsAgent(cfg: OpenClawConfig): boolean {
  const configuredAgentIds = cfg.agents?.list?.map((agent) => agent.id) ?? [];
  const agentIds = configuredAgentIds.length > 0 ? configuredAgentIds : ["main"];
  return agentIds.some((agentId) => resolveRememberAcrossConversations(cfg, agentId));
}

function shouldRememberAcrossConversations(cfg: OpenClawConfig, agentId: string): boolean {
  return resolveRememberAcrossConversations(cfg, agentId);
}

function updateActiveMemoryGlobalEnabledInConfig(
  cfg: OpenClawConfig,
  enabled: boolean,
): OpenClawConfig {
  const entries = { ...cfg.plugins?.entries };
  const existingEntry = asRecord(entries["active-memory"]) ?? {};
  const existingConfig = asRecord(existingEntry.config) ?? {};
  entries["active-memory"] = {
    ...existingEntry,
    enabled: true,
    config: {
      ...existingConfig,
      enabled,
    },
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
    },
  };
}

function lacksAdminToMutateActiveMemoryGlobal(params: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): boolean {
  if (Array.isArray(params.gatewayClientScopes)) {
    return !params.gatewayClientScopes.includes("operator.admin");
  }
  return params.senderIsOwner !== true;
}

const ACTIVE_MEMORY_GLOBAL_MUTATION_ADMIN_REQUIRED_TEXT =
  "⚠️ /active-memory global enable/disable changes require owner or operator.admin.";

function isEnabledForAgent(
  config: ResolvedActiveRecallPluginConfig,
  agentId: string | undefined,
): boolean {
  if (!config.enabled) {
    return false;
  }
  if (!agentId) {
    return false;
  }
  return config.agents.includes(agentId);
}

function isAgentHarnessSessionKey(sessionKey: string): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  const rest = parseAgentSessionKey(normalized)?.rest ?? normalized;
  return rest.startsWith("harness:");
}

function shouldSkipActiveMemoryForHarnessSession(params: {
  api: OpenClawPluginApi;
  agentId?: string;
  sessionKey?: string;
}): boolean {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  try {
    const entry = params.api.runtime.agent.session.getSessionEntry({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey,
      readConsistency: "latest",
    });
    // A missing reserved key must not synthesize work, while unlocked rows are
    // grandfathered user sessions from before the namespace was introduced.
    return (
      entry?.modelSelectionLocked === true ||
      (entry === undefined && isAgentHarnessSessionKey(sessionKey))
    );
  } catch {
    // Recall is optional. If durable ownership cannot be checked, do not risk
    // crossing a harness/model boundary with an independently selected model.
    return true;
  }
}

function isEligibleInteractiveSession(ctx: {
  trigger?: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
}): boolean {
  if (ctx.trigger !== "user") {
    return false;
  }
  // Exclude only canonical dreaming-narrative session keys (bare or agent-prefixed).
  // Canonical forms: "dreaming-narrative-<phase>-<hash>" or
  // "agent:<agentId>:dreaming-narrative-<phase>-<hash>".
  // A colon-delimited match would also exclude real chat session ids whose peer id
  // begins with a phased dreaming-narrative phrase (e.g.
  // "agent:main:feishu:group:dreaming-narrative-light-room").
  const sessionKey = ctx.sessionKey ?? "";
  if (
    /^dreaming-narrative-(light|rem|deep)-/i.test(sessionKey) ||
    /^agent:[^:]+:dreaming-narrative-(light|rem|deep)-/i.test(sessionKey)
  ) {
    return false;
  }
  if (!ctx.sessionKey && !ctx.sessionId) {
    return false;
  }
  const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
  if (provider === "webchat") {
    return true;
  }
  return Boolean(ctx.channelId && ctx.channelId.trim());
}

function resolveChatType(ctx: {
  sessionKey?: string;
  messageProvider?: string;
  channelId?: string;
  mainKey?: string;
}): ActiveMemoryChatType | undefined {
  const rawSessionKey = ctx.sessionKey?.trim();
  const { baseSessionKey } = parseThreadSessionSuffix(rawSessionKey);
  const sessionKey = (baseSessionKey ?? rawSessionKey)?.trim().toLowerCase();
  if (sessionKey) {
    if (sessionKey.startsWith("agent:") && sessionKey.split(":")[2] === "explicit") {
      return "explicit";
    }
    if (sessionKey.includes(":group:")) {
      return "group";
    }
    if (sessionKey.includes(":channel:")) {
      return "channel";
    }
    if (sessionKey.includes(":direct:") || sessionKey.includes(":dm:")) {
      return "direct";
    }
    const mainKey = ctx.mainKey?.trim().toLowerCase() || "main";
    const agentSessionParts = sessionKey.split(":");
    if (
      agentSessionParts.length === 3 &&
      agentSessionParts[0] === "agent" &&
      (agentSessionParts[2] === mainKey || agentSessionParts[2] === "main")
    ) {
      const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
      const channelId = (ctx.channelId ?? "").trim();
      if (provider && provider !== "webchat" && channelId) {
        return "direct";
      }
    }
  }
  const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
  if (provider === "webchat") {
    return "direct";
  }
  return undefined;
}

function isAllowedChatType(
  config: ResolvedActiveRecallPluginConfig,
  ctx: {
    sessionKey?: string;
    messageProvider?: string;
    channelId?: string;
    mainKey?: string;
  },
): boolean {
  const chatType = resolveChatType(ctx);
  if (!chatType) {
    return false;
  }
  return config.allowedChatTypes.includes(chatType);
}

function isPrivateRecallDestination(ctx: {
  sessionKey?: string;
  messageProvider?: string;
  channelId?: string;
  mainKey?: string;
}): boolean {
  const chatType = resolveChatType(ctx);
  return chatType === "direct" || chatType === "explicit";
}

/**
 * Best-effort extraction of the conversation id (peer id) embedded in an
 * agent-scoped session key, using shared session-key utilities so we
 * stay aligned with the canonical key shapes produced by
 * `buildAgentPeerSessionKey` / `resolveThreadSessionKeys`.
 *
 * Supported shapes (after stripping the optional `:thread:<id>` suffix):
 *   - agent:<agentId>:direct:<peerId>                         (dmScope=per-peer)
 *   - agent:<agentId>:<channel>:direct:<peerId>               (dmScope=per-channel-peer)
 *   - agent:<agentId>:<channel>:<accountId>:direct:<peerId>   (dmScope=per-account-channel-peer)
 *   - agent:<agentId>:<channel>:group:<peerId>                (group)
 *   - agent:<agentId>:<channel>:channel:<peerId>              (channel)
 *
 * The legacy `dm` token is also accepted for backwards compatibility.
 *
 * Returns undefined for sessions that do not embed a peer id (for
 * example dmScope=main `agent:<agentId>:<mainKey>` sessions, or any
 * non-canonical session key shape).
 */
function resolveConversationId(ctx: {
  sessionKey?: string;
  messageProvider?: string;
}): string | undefined {
  const rawSessionKey = ctx.sessionKey?.trim();
  if (!rawSessionKey) {
    return undefined;
  }
  // Strip generic `:thread:<id>` suffix first so threaded sessions match
  // the same conversation id as their non-threaded parent. Provider-
  // specific topic ids (e.g. Telegram/Feishu) that are baked into the
  // peer id by the channel adapter are preserved.
  const { baseSessionKey } = parseThreadSessionSuffix(rawSessionKey);
  const baseKey = (baseSessionKey ?? rawSessionKey).trim();
  if (!baseKey) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(baseKey);
  if (!parsed) {
    return undefined;
  }
  const restParts = parsed.rest.split(":").filter(Boolean);
  if (restParts.length < 2) {
    // `agent:<agentId>:<mainKey>` (dmScope=main) lands here — there is
    // no embedded peer id to filter against.
    return undefined;
  }
  // Walk left-to-right until we hit the first chat-type marker. Every
  // canonical peer key terminates with `<chatType>:<peerId...>`, so the
  // tail after the first marker is the conversation id we want.
  for (let index = 0; index < restParts.length - 1; index += 1) {
    const token = restParts[index];
    if (token === "direct" || token === "dm" || token === "group" || token === "channel") {
      const tail = restParts
        .slice(index + 1)
        .join(":")
        .trim();
      return tail || undefined;
    }
  }
  return undefined;
}

/**
 * Apply allowedChatIds / deniedChatIds filters after the chat type check
 * has already passed. Empty allowedChatIds means "no allowlist" and this
 * function returns true for any conversation. Empty deniedChatIds is also
 * a no-op.
 *
 * When allowedChatIds is non-empty but the session key does not expose a
 * conversation id (e.g. webchat default session), the session is skipped
 * to avoid accidentally running against an unknown conversation.
 */
function isAllowedChatId(
  config: ResolvedActiveRecallPluginConfig,
  ctx: {
    sessionKey?: string;
    messageProvider?: string;
    channelId?: string;
  },
): boolean {
  const hasAllowlist = config.allowedChatIds.length > 0;
  const hasDenylist = config.deniedChatIds.length > 0;
  if (!hasAllowlist && !hasDenylist) {
    return true;
  }
  // dmScope=main direct sessions omit the peer id from the key. Fall back to
  // the trusted hook chat id so allow/deny lists still apply.
  const conversationId =
    (resolveConversationId(ctx) ?? ctx.channelId?.trim())?.toLowerCase() || undefined;
  if (hasAllowlist) {
    if (!conversationId) {
      return false;
    }
    if (!config.allowedChatIds.includes(conversationId)) {
      return false;
    }
  }
  if (hasDenylist && conversationId && config.deniedChatIds.includes(conversationId)) {
    return false;
  }
  return true;
}

export {
  ACTIVE_MEMORY_GLOBAL_MUTATION_ADMIN_REQUIRED_TEXT,
  formatActiveMemoryCommandHelp,
  isActiveMemoryGloballyEnabled,
  isActiveMemoryPluginEnabled,
  isAllowedChatId,
  isAllowedChatType,
  isEligibleInteractiveSession,
  isEnabledForAgent,
  isPrivateRecallDestination,
  isSessionActiveMemoryDisabled,
  hasRememberAcrossConversationsAgent,
  lacksAdminToMutateActiveMemoryGlobal,
  resolveCommandSessionKey,
  setSessionActiveMemoryDisabled,
  shouldSkipActiveMemoryForHarnessSession,
  shouldRememberAcrossConversations,
  updateActiveMemoryGlobalEnabledInConfig,
};
