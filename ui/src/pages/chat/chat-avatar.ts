// Control UI chat module implements chat avatar behavior.
import { html } from "lit";
import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { resolveControlUiAuthHeader } from "../../app/control-ui-auth.ts";
import {
  resolveLocalUserAvatarText,
  resolveLocalUserAvatarUrl,
  resolveLocalUserName,
} from "../../app/user-identity.ts";
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
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
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
  const assistantName = assistant?.name?.trim() || "Assistant";
  const assistantAvatar = assistant?.avatar?.trim() || "";
  const assistantAvatarText = resolveAssistantTextAvatar(assistantAvatar);
  const assistantFallbackAvatar = assistantAvatarFallbackUrl(resourceBasePath ?? "");
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
      : normalized === "assistant"
        ? html`
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2L8 14 2 9.2h7.6z" />
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
  const className =
    normalized === "user"
      ? "user"
      : normalized === "assistant"
        ? "assistant"
        : normalized === "tool"
          ? "tool"
          : "other";

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

  if (assistantAvatar && normalized === "assistant") {
    if (isAvatarUrl(assistantAvatar)) {
      if (authToken?.trim() && assistantAvatar.startsWith("/")) {
        return html`<img
          class="chat-avatar ${className} chat-avatar--logo"
          src="${assistantFallbackAvatar}"
          alt="${assistantName}"
        />`;
      }
      return html`<img
        class="chat-avatar ${className}"
        src="${assistantAvatar}"
        alt="${assistantName}"
      />`;
    }
    if (assistantAvatarText) {
      return html`<div class="chat-avatar ${className}" role="img" aria-label="${assistantName}">
        ${assistantAvatarText}
      </div>`;
    }
    return html`<img
      class="chat-avatar ${className} chat-avatar--logo"
      src="${assistantFallbackAvatar}"
      alt="${assistantName}"
    />`;
  }

  if (normalized === "assistant") {
    return html`<img
      class="chat-avatar ${className} chat-avatar--logo"
      src="${assistantFallbackAvatar}"
      alt="${assistantName}"
    />`;
  }

  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

/**
 * The avatar URL may 404 or be unreachable (missing upload, dead Gravatar,
 * stale configured URL); swap to initials instead of a broken image. Lit
 * reuses DOM parts, so a load must clear a prior identity's error state.
 */
function renderUserAvatarSlot(view: IdentityAvatarView, label: string) {
  const initialsAvatar = html`<div
    class="chat-avatar user chat-avatar--sender-initials"
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
      className: "chat-avatar user",
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
  agentsList?: { defaultId?: string | null } | null;
  resourceBasePath: string;
  chatAvatarReason?: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarUrl: string | null;
  client?: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  password?: string | null;
  sessionKey: string;
  settings?: { token?: string | null } | null;
};

const chatAvatarRequestVersions = new WeakMap<object, number>();
const chatAvatarDisplayedAgents = new WeakMap<object, string>();

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

function clearChatAvatarUrl(host: ChatAvatarHost) {
  host.chatAvatarUrl = null;
}

function clearChatAvatarState(host: ChatAvatarHost) {
  clearChatAvatarUrl(host);
  host.chatAvatarSource = null;
  host.chatAvatarStatus = null;
  host.chatAvatarReason = null;
}

function setChatAvatarUrl(host: ChatAvatarHost, nextUrl: string | null) {
  host.chatAvatarUrl = nextUrl;
}

function applyChatAvatarSnapshot(
  host: ChatAvatarHost,
  agentId: string,
  snapshot: ChatAvatarSnapshot,
): void {
  host.chatAvatarSource = snapshot.source;
  host.chatAvatarStatus = snapshot.status;
  host.chatAvatarReason = snapshot.reason;
  setChatAvatarUrl(host, snapshot.url);
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
  if (!host.connected || resolveAgentIdForSession(host) !== agentId) {
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
