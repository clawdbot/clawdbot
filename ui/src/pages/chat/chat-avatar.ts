// Control UI chat module implements chat avatar behavior.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type TemplateResult } from "lit";
import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { resolveControlUiAuthHeader } from "../../app/control-ui-auth.ts";
import {
  resolveLocalUserAvatarText,
  resolveLocalUserAvatarUrl,
  resolveLocalUserName,
} from "../../app/user-identity.ts";
import { icons } from "../../components/icons.ts";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
  resolveIdentityAvatarView,
  type IdentityAvatarView,
} from "../../components/identity-avatar-view.ts";
import type { AssistantIdentity } from "../../lib/assistant-identity.ts";
import {
  assistantAvatarFallbackUrl,
  isRenderableControlUiAvatarUrl,
  resolveAssistantTextAvatar,
} from "../../lib/avatar.ts";
import {
  normalizeRoleForGrouping,
  readMessageSenderSession,
  resolveMessageRole,
} from "../../lib/chat/message-normalizer.ts";
import type { SenderIdentity } from "../../lib/chat/sender-label.ts";
import { formatSenderLabel } from "../../lib/chat/sender-label.ts";
import { resolveAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
import { resolveAvatarInitials } from "../../lib/identity-avatar.ts";
import {
  DEFAULT_AGENT_ID,
  isUiGlobalSessionKey,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";

export function renderChatAvatar(
  role: string,
  assistant?: Pick<AssistantIdentity, "name" | "avatar">,
  user?: { name?: string | null; avatar?: string | null },
  resourceBasePath?: string,
  authToken?: string | null,
  sender?: SenderIdentity | null,
) {
  const normalized = normalizeRoleForGrouping(role);
  // Attributed multi-user messages show the author's own avatar (profile
  // upload → gateway Gravatar proxy → initials), not the local viewer's.
  if (normalized === "user" && sender) {
    return renderUserAvatarSlot(resolveIdentityAvatarView(sender), formatSenderLabel(sender) ?? "");
  }
  if (normalized === "assistant") {
    const name = assistant?.name?.trim() || "Assistant";
    return renderAgentAvatar(
      name,
      assistant?.avatar,
      html`<img
        class="chat-avatar assistant chat-avatar--logo"
        src=${assistantAvatarFallbackUrl(resourceBasePath ?? "")}
        alt=${name}
      />`,
      authToken,
    );
  }
  const userName = resolveLocalUserName(user);
  const userAvatarUrl = resolveLocalUserAvatarUrl(user);
  const userAvatarText = resolveLocalUserAvatarText(user);
  const initial =
    normalized === "user"
      ? html`
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <circle cx="12" cy="8" r="4" />
            <path d="M20 21a8 8 0 1 0-16 0" />
          </svg>
        `
      : normalized === "tool"
        ? html`
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path
                d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53a7.76 7.76 0 0 0 .07-1 7.76 7.76 0 0 0-.07-.97l2.11-1.63a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.15 7.15 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65a7.15 7.15 0 0 0-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64L4.57 11a7.9 7.9 0 0 0 0 1.94l-2.11 1.69a.49.49 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.72 1.69.98l.38 2.65c.05.24.26.42.49.42h4c.23 0 .44-.18.49-.42l.38-2.65a7.15 7.15 0 0 0 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.49.49 0 0 0-.12-.64z"
              />
            </svg>
          `
        : html`
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <circle cx="12" cy="12" r="10" />
              <text
                x="12"
                y="16.5"
                text-anchor="middle"
                font-size="14"
                font-weight="600"
                fill="var(--bg, #fff)"
              >
                ?
              </text>
            </svg>
          `;
  const className = normalized === "user" ? "user" : normalized === "tool" ? "tool" : "other";

  if (normalized === "user" && userAvatarUrl) {
    const imageUrl = resolveAvatarImageUrl(userAvatarUrl) ?? userAvatarUrl;
    return renderUserAvatarSlot(
      {
        fallback: resolveAvatarInitials({ name: userName }),
        imageUrl,
        pending: typeof imageUrl !== "string",
      },
      userName,
    );
  }

  if (normalized === "user" && userAvatarText) {
    return html`<div class="chat-avatar ${className}" role="img" aria-label="${userName}">
      ${userAvatarText}
    </div>`;
  }

  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

function renderAgentAvatar(
  name: string,
  avatar: string | null | undefined,
  fallback: TemplateResult,
  authToken?: string | null,
) {
  const value = avatar?.trim() || "";
  if (isAvatarUrl(value)) {
    // Authenticated local routes must finish the blob fetch before becoming an img src.
    return authToken?.trim() && value.startsWith("/")
      ? fallback
      : html`<img class="chat-avatar assistant" src=${value} alt=${name} />`;
  }
  const text = resolveAssistantTextAvatar(value);
  return text
    ? html`<div class="chat-avatar assistant" role="img" aria-label=${name}>${text}</div>`
    : fallback;
}

type ForwardedAvatarOptions = {
  agentId?: string;
  agents?: AgentsListResult["agents"];
  senderAgentAvatars?: ReadonlyMap<string, string | null>;
  assistantName?: string;
  assistantAvatar?: string | null;
  resourceBasePath?: string;
  assistantAttachmentAuthToken?: string | null;
};

export function renderForwardedAvatar(agentId: string | undefined, opts: ForwardedAvatarOptions) {
  // Forwarded rows carry the source agent's identity: another
  // agent's avatar via the sender map, the current agent's own
  // avatar for same-agent sessions, and the forward glyph only for
  // unresolvable or legacy sources.
  if (agentId && agentId === opts.agentId) {
    return renderChatAvatar(
      "assistant",
      { name: opts.assistantName ?? "Assistant", avatar: opts.assistantAvatar ?? null },
      undefined,
      opts.resourceBasePath,
      opts.assistantAttachmentAuthToken,
    );
  }
  const agent = agentId ? opts.agents?.find((candidate) => candidate.id === agentId) : undefined;
  if (!agent) {
    return html`<div class="chat-avatar chat-avatar--forwarded" aria-hidden="true">
      ${icons.forward}
    </div>`;
  }
  const name = agent.identity?.name?.trim() || agent.id;
  return renderAgentAvatar(
    name,
    opts.senderAgentAvatars?.get(agent.id),
    renderUserAvatarSlot(
      { fallback: resolveAvatarInitials({ id: agent.id, name }), imageUrl: null, pending: false },
      name,
      "assistant",
    ),
    opts.assistantAttachmentAuthToken,
  );
}

/**
 * The avatar URL may 404 or be unreachable (missing upload, dead Gravatar,
 * stale configured URL); swap to initials instead of a broken image. Lit
 * reuses DOM parts, so a load must clear a prior identity's error state.
 */
function renderUserAvatarSlot(view: IdentityAvatarView, label: string, role = "user") {
  const initialsAvatar = html`<div
    class="chat-avatar ${role} chat-avatar--sender-initials"
    style=${`background: hsl(${view.fallback.colorSeed % 360} 48% 42%)`}
    role="img"
    aria-label="${label}"
  >
    ${view.fallback.initials}
  </div>`;
  if (!view.imageUrl) {
    return initialsAvatar;
  }
  return html`<span class=${identityAvatarClass("chat-avatar-slot", view)}>
    ${renderIdentityAvatarImage({
      view,
      fallbackSelector: ".chat-avatar-slot",
      className: `chat-avatar ${role}`,
      alt: label,
    })}${initialsAvatar}
  </span>`;
}

function isAvatarUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("blob:") || isRenderableControlUiAvatarUrl(trimmed);
}

type ChatAvatarHost = {
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; agents?: AgentsListResult["agents"] } | null;
  resourceBasePath: string;
  chatAvatarReason?: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarUrl: string | null;
  senderAgentAvatars?: ReadonlyMap<string, string | null>;
  client?: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch?: number;
  hello: GatewayHelloOk | null;
  password?: string | null;
  sessionKey: string;
  settings?: { token?: string | null } | null;
  requestUpdate?: () => void;
};

const chatAvatarRequestVersions = new WeakMap<object, number>();
const chatAvatarDisplayedAgents = new WeakMap<object, string>();
const senderAvatarRequestVersions = new WeakMap<object, number>();
const senderAvatarInputs = new WeakMap<object, unknown[]>();

type ChatAvatarSnapshot = {
  reason: string | null;
  source: string | null;
  status: "none" | "local" | "remote" | "data" | null;
  url: string | null;
};

type ChatAvatarSnapshotEntry = {
  kind: "snapshot";
  snapshot: ChatAvatarSnapshot;
  cachedAt: number;
  retired?: ChatAvatarSnapshot[];
};

type ChatAvatarCacheEntry =
  | {
      kind: "pending";
      pending: Promise<ChatAvatarSnapshot | null>;
      stale?: ChatAvatarSnapshotEntry;
    }
  | ChatAvatarSnapshotEntry;

const CHAT_AVATAR_CACHE_LIMIT = 24;
const CHAT_AVATAR_CACHE_TTL_MS = 60_000;
const chatAvatarCaches = new WeakMap<object, Map<string, ChatAvatarCacheEntry>>();

function readHelloDefaultAgentId(host: Pick<ChatAvatarHost, "hello">): string | undefined {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  return snapshot?.sessionDefaults?.defaultAgentId?.trim() || undefined;
}

export function resolveAgentIdForSession(
  host: Pick<ChatAvatarHost, "sessionKey" | "assistantAgentId" | "agentsList" | "hello">,
): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  if (isUiGlobalSessionKey(host.sessionKey)) {
    return resolveUiSelectedGlobalAgentId(host) || DEFAULT_AGENT_ID;
  }
  return readHelloDefaultAgentId(host) || DEFAULT_AGENT_ID;
}

function beginChatAvatarRequest(host: ChatAvatarHost): number {
  const key = host as object;
  const nextVersion = (chatAvatarRequestVersions.get(key) ?? 0) + 1;
  chatAvatarRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function shouldApplyChatAvatarResult(
  host: ChatAvatarHost,
  version: number,
  sessionKey: string,
  agentId: string | null,
): boolean {
  return (
    chatAvatarRequestVersions.get(host as object) === version &&
    host.sessionKey === sessionKey &&
    resolveAgentIdForSession(host) === agentId
  );
}

function buildAvatarMetaUrl(resourceBasePath: string, agentId: string): string {
  return `${buildControlUiResourcePath("agentAvatar", resourceBasePath, agentId)}?meta=1`;
}

function clearChatAvatarState(host: ChatAvatarHost) {
  host.chatAvatarUrl = null;
  host.chatAvatarSource = null;
  host.chatAvatarStatus = null;
  host.chatAvatarReason = null;
}

function applyChatAvatarSnapshot(
  host: ChatAvatarHost,
  agentId: string,
  snapshot: ChatAvatarSnapshot,
): void {
  host.chatAvatarSource = snapshot.source;
  host.chatAvatarStatus = snapshot.status;
  host.chatAvatarReason = snapshot.reason;
  host.chatAvatarUrl = snapshot.url;
  chatAvatarDisplayedAgents.set(host as object, agentId);
}

function revokeChatAvatarEntry(entry: ChatAvatarCacheEntry | undefined): void {
  const snapshots =
    entry?.kind === "snapshot"
      ? [entry.snapshot, ...(entry.retired ?? [])]
      : entry?.stale
        ? [entry.stale.snapshot, ...(entry.stale.retired ?? [])]
        : [];
  for (const snapshot of snapshots) {
    if (snapshot.url?.startsWith("blob:")) {
      URL.revokeObjectURL(snapshot.url);
    }
  }
}

function revokeRetiredChatAvatarSnapshots(entry: ChatAvatarSnapshotEntry): void {
  for (const snapshot of entry.retired ?? []) {
    if (snapshot.url?.startsWith("blob:")) {
      URL.revokeObjectURL(snapshot.url);
    }
  }
  entry.retired = undefined;
}

function isFreshChatAvatarEntry(entry: ChatAvatarSnapshotEntry): boolean {
  return Date.now() - entry.cachedAt < CHAT_AVATAR_CACHE_TTL_MS;
}

function clearChatAvatarCache(host: ChatAvatarHost): void {
  const key = host as object;
  const cache = chatAvatarCaches.get(key);
  if (cache) {
    for (const entry of cache.values()) {
      revokeChatAvatarEntry(entry);
    }
    chatAvatarCaches.delete(key);
  }
  chatAvatarDisplayedAgents.delete(key);
  senderAvatarRequestVersions.delete(key);
  senderAvatarInputs.delete(key);
  host.senderAgentAvatars = undefined;
}

export function invalidateChatAvatarCache(host: ChatAvatarHost): void {
  beginChatAvatarRequest(host);
  clearChatAvatarCache(host);
  clearChatAvatarState(host);
}

function chatAvatarCacheFor(host: ChatAvatarHost): Map<string, ChatAvatarCacheEntry> {
  const key = host as object;
  const current = chatAvatarCaches.get(key);
  if (current) {
    return current;
  }
  const entries = new Map<string, ChatAvatarCacheEntry>();
  chatAvatarCaches.set(key, entries);
  return entries;
}

function rememberChatAvatarEntry(
  cache: Map<string, ChatAvatarCacheEntry>,
  agentId: string,
  entry: ChatAvatarCacheEntry,
): void {
  cache.delete(agentId);
  cache.set(agentId, entry);
  while (cache.size > CHAT_AVATAR_CACHE_LIMIT) {
    const oldestAgentId = cache.keys().next().value;
    if (typeof oldestAgentId !== "string") {
      break;
    }
    const oldest = cache.get(oldestAgentId);
    cache.delete(oldestAgentId);
    revokeChatAvatarEntry(oldest);
  }
}

function loadChatAvatarSnapshot(
  host: ChatAvatarHost,
  cache: Map<string, ChatAvatarCacheEntry>,
  agentId: string,
): Promise<ChatAvatarSnapshot | null> {
  const cached = cache.get(agentId);
  if (cached?.kind === "snapshot" && isFreshChatAvatarEntry(cached)) {
    rememberChatAvatarEntry(cache, agentId, cached);
    return Promise.resolve(cached.snapshot);
  }
  if (cached?.kind === "pending") {
    return cached.pending;
  }
  const stale = cached?.kind === "snapshot" ? cached : undefined;
  const pending = fetchChatAvatarSnapshot(host, agentId).then((snapshot) => {
    const current = cache.get(agentId);
    if (
      chatAvatarCaches.get(host as object) === cache &&
      current?.kind === "pending" &&
      current.pending === pending
    ) {
      if (snapshot) {
        rememberChatAvatarEntry(cache, agentId, {
          kind: "snapshot",
          snapshot,
          cachedAt: Date.now(),
          ...(stale && stale.snapshot.url !== snapshot.url
            ? { retired: [stale.snapshot, ...(stale.retired ?? [])] }
            : {}),
        });
      } else if (stale) {
        rememberChatAvatarEntry(cache, agentId, stale);
      } else {
        cache.delete(agentId);
      }
    } else if (snapshot?.url?.startsWith("blob:")) {
      URL.revokeObjectURL(snapshot.url);
    }
    return snapshot ?? stale?.snapshot ?? null;
  });
  rememberChatAvatarEntry(cache, agentId, { kind: "pending", pending, stale });
  return pending;
}

function buildControlUiAuthHeaders(authHeader: string | null): Record<string, string> | undefined {
  return authHeader ? { Authorization: authHeader } : undefined;
}

function isLocalControlUiAvatarUrl(avatarUrl: string): boolean {
  return avatarUrl.startsWith("/");
}

/** Give each sequential fetch a full budget; sharing one can starve the image request. */
const CHAT_AVATAR_FETCH_TIMEOUT_MS = 30_000;

function scheduleChatAvatarFetchTimeout(controller: AbortController, label: string) {
  return setTimeout(
    () => controller.abort(new DOMException(`${label} timed out`, "TimeoutError")),
    CHAT_AVATAR_FETCH_TIMEOUT_MS,
  );
}

async function fetchChatAvatarSnapshot(
  host: ChatAvatarHost,
  agentId: string,
): Promise<ChatAvatarSnapshot | null> {
  const sessionAgentId = resolveAgentIdForSession(host);
  const authHeader = resolveControlUiAuthHeader(host);
  const headers = buildControlUiAuthHeaders(authHeader);
  const url = buildAvatarMetaUrl(host.resourceBasePath, agentId);
  const metaController = new AbortController();
  const metaTimeout = scheduleChatAvatarFetchTimeout(metaController, "chat avatar metadata fetch");
  let data: {
    avatarUrl?: unknown;
    avatarSource?: unknown;
    avatarStatus?: unknown;
    avatarReason?: unknown;
  };
  try {
    const res = await fetch(url, {
      method: "GET",
      ...(headers ? { headers } : {}),
      signal: metaController.signal,
    });
    if (!res.ok) {
      return null;
    }
    data = (await res.json()) as typeof data;
  } catch {
    return null;
  } finally {
    clearTimeout(metaTimeout);
  }

  const status =
    data.avatarStatus === "none" ||
    data.avatarStatus === "local" ||
    data.avatarStatus === "remote" ||
    data.avatarStatus === "data"
      ? data.avatarStatus
      : null;
  const snapshot: ChatAvatarSnapshot = {
    source:
      typeof data.avatarSource === "string" && data.avatarSource.trim()
        ? data.avatarSource.trim()
        : null,
    status,
    reason:
      typeof data.avatarReason === "string" && data.avatarReason.trim()
        ? data.avatarReason.trim()
        : null,
    url: null,
  };
  const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
  if (!avatarUrl || !isRenderableControlUiAvatarUrl(avatarUrl)) {
    return snapshot;
  }
  if (!isLocalControlUiAvatarUrl(avatarUrl)) {
    return { ...snapshot, url: avatarUrl };
  }
  if (!host.connected || resolveAgentIdForSession(host) !== sessionAgentId) {
    return null;
  }

  const avatarController = new AbortController();
  const avatarTimeout = scheduleChatAvatarFetchTimeout(avatarController, "chat avatar image fetch");
  try {
    const avatarRes = await fetch(avatarUrl, {
      method: "GET",
      ...(headers ? { headers } : {}),
      signal: avatarController.signal,
    });
    if (!avatarRes.ok) {
      return null;
    }
    return { ...snapshot, url: URL.createObjectURL(await avatarRes.blob()) };
  } catch {
    return null;
  } finally {
    clearTimeout(avatarTimeout);
  }
}

export async function refreshSenderAgentAvatars(
  host: (ChatAvatarHost & { chatMessages: unknown[] }) | undefined,
): Promise<void> {
  if (!host) {
    return;
  }
  const inputs = [
    host.chatMessages,
    host.agentsList,
    host.sessionKey,
    host.assistantAgentId,
    host.connected,
    host.client,
    host.connectionEpoch,
  ];
  const previous = senderAvatarInputs.get(host);
  if (previous && inputs.every((input, index) => input === previous[index])) {
    return;
  }
  senderAvatarInputs.set(host, inputs);
  // Use the same normalized sender metadata as grouping, after each transcript commit.
  const agentIds = host.chatMessages.flatMap((message) => {
    if (resolveMessageRole(message) !== "assistant") {
      return [];
    }
    const id = readMessageSenderSession(asOptionalRecord(message)?.senderSession)?.agentId;
    return id ? [id] : [];
  });
  await loadSenderAgentAvatars(host, agentIds);
}

async function loadSenderAgentAvatars(host: ChatAvatarHost, agentIds: readonly string[]) {
  const version = (senderAvatarRequestVersions.get(host) ?? 0) + 1;
  senderAvatarRequestVersions.set(host, version);
  const sessionKey = host.sessionKey;
  const agentId = resolveAgentIdForSession(host);
  const client = host.client;
  const epoch = host.connectionEpoch;
  const agents = host.agentsList?.agents;
  const roster = new Set(agents?.map((agent) => agent.id));
  // Reserve one LRU slot for the current agent; never publish URLs the cache evicted/revoked.
  const ids = [...new Set(agentIds)]
    .filter((id) => id !== agentId && roster.has(id))
    .slice(0, CHAT_AVATAR_CACHE_LIMIT - 1);
  if (!host.connected || ids.length === 0) {
    if (host.senderAgentAvatars?.size) {
      host.senderAgentAvatars = new Map();
      host.requestUpdate?.();
    }
    return;
  }
  host.senderAgentAvatars = new Map();
  const cache = chatAvatarCacheFor(host);
  const current = cache.get(agentId ?? "");
  if (current && agentId) {
    rememberChatAvatarEntry(cache, agentId, current);
  }
  const snapshots = await Promise.all(ids.map((id) => loadChatAvatarSnapshot(host, cache, id)));
  if (
    !host.connected ||
    host.client !== client ||
    host.connectionEpoch !== epoch ||
    host.agentsList?.agents !== agents ||
    host.sessionKey !== sessionKey ||
    resolveAgentIdForSession(host) !== agentId ||
    senderAvatarRequestVersions.get(host) !== version ||
    chatAvatarCaches.get(host) !== cache
  ) {
    return;
  }
  host.senderAgentAvatars = new Map(
    ids.map((id, index) => {
      const entry = cache.get(id);
      const snapshot = snapshots[index];
      const retained = entry?.kind === "snapshot" && entry.snapshot === snapshot;
      if (retained) {
        revokeRetiredChatAvatarSnapshots(entry);
      }
      return [id, retained ? snapshot.url : null];
    }),
  );
  host.requestUpdate?.();
}

export async function refreshChatAvatar(host: ChatAvatarHost) {
  if (!host.connected) {
    clearChatAvatarCache(host);
    clearChatAvatarState(host);
    return;
  }
  const sessionKey = host.sessionKey;
  const requestVersion = beginChatAvatarRequest(host);
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      clearChatAvatarState(host);
    }
    return;
  }
  const cache = chatAvatarCacheFor(host);
  const cached = cache.get(agentId);
  if (cached?.kind === "snapshot") {
    rememberChatAvatarEntry(cache, agentId, cached);
    applyChatAvatarSnapshot(host, agentId, cached.snapshot);
    revokeRetiredChatAvatarSnapshots(cached);
    if (isFreshChatAvatarEntry(cached)) {
      return;
    }
  }
  const showingSameAgent = chatAvatarDisplayedAgents.get(host as object) === agentId;
  if (!showingSameAgent) {
    clearChatAvatarState(host);
  }
  const snapshot = await loadChatAvatarSnapshot(host, cache, agentId);
  if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
    return;
  }
  if (snapshot) {
    applyChatAvatarSnapshot(host, agentId, snapshot);
    const current = cache.get(agentId);
    if (current?.kind === "snapshot" && current.snapshot === snapshot) {
      revokeRetiredChatAvatarSnapshots(current);
    }
  } else if (!showingSameAgent) {
    clearChatAvatarState(host);
  }
}
