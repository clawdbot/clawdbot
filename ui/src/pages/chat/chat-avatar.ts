// Control UI chat module implements chat avatar behavior.
import { html } from "lit";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import { normalizeBasePath } from "../../app-route-paths.ts";
import { resolveControlUiAuthHeader } from "../../app/control-ui-auth.ts";
import {
  resolveLocalUserAvatarText,
  resolveLocalUserAvatarUrl,
  resolveLocalUserName,
} from "../../app/user-identity.ts";
import type { AssistantIdentity } from "../../lib/assistant-identity.ts";
import {
  assistantAvatarFallbackUrl,
  isRenderableControlUiAvatarUrl,
  resolveAssistantTextAvatar,
} from "../../lib/avatar.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
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
  basePath?: string,
  authToken?: string | null,
) {
  const normalized = normalizeRoleForGrouping(role);
  const assistantName = assistant?.name?.trim() || "Assistant";
  const assistantAvatar = assistant?.avatar?.trim() || "";
  const assistantAvatarText = resolveAssistantTextAvatar(assistantAvatar);
  const assistantFallbackAvatar = assistantAvatarFallbackUrl(basePath ?? "");
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
    return html`<img class="chat-avatar ${className}" src="${userAvatarUrl}" alt="${userName}" />`;
  }

  if (normalized === "user" && userAvatarText) {
    return html`<div class="chat-avatar ${className}" aria-label="${userName}">
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
      return html`<div class="chat-avatar ${className}" aria-label="${assistantName}">
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

function isAvatarUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("blob:") || isRenderableControlUiAvatarUrl(trimmed);
}

type ChatAvatarHost = {
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null } | null;
  basePath: string;
  chatAvatarReason?: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarUrl: string | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  password?: string | null;
  sessionKey: string;
  settings?: { token?: string | null } | null;
};

const chatAvatarRequestVersions = new WeakMap<object, number>();
const chatAvatarObjectUrls = new WeakMap<object, string>();

function readHelloDefaultAgentId(host: Pick<ChatAvatarHost, "hello">): string | undefined {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  return snapshot?.sessionDefaults?.defaultAgentId?.trim() || undefined;
}

export function resolveAgentIdForSession(host: ChatAvatarHost): string | null {
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

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

function clearChatAvatarUrl(host: ChatAvatarHost) {
  const key = host as object;
  const previousBlobUrl = chatAvatarObjectUrls.get(key);
  if (previousBlobUrl) {
    URL.revokeObjectURL(previousBlobUrl);
    chatAvatarObjectUrls.delete(key);
  }
  host.chatAvatarUrl = null;
}

function clearChatAvatarState(host: ChatAvatarHost) {
  clearChatAvatarUrl(host);
  host.chatAvatarSource = null;
  host.chatAvatarStatus = null;
  host.chatAvatarReason = null;
}

function setChatAvatarUrl(host: ChatAvatarHost, nextUrl: string | null) {
  const key = host as object;
  const previousBlobUrl = chatAvatarObjectUrls.get(key);
  if (previousBlobUrl && previousBlobUrl !== nextUrl) {
    URL.revokeObjectURL(previousBlobUrl);
    chatAvatarObjectUrls.delete(key);
  }
  if (nextUrl?.startsWith("blob:")) {
    chatAvatarObjectUrls.set(key, nextUrl);
  }
  host.chatAvatarUrl = nextUrl;
}

function setChatAvatarMeta(
  host: ChatAvatarHost,
  data: {
    avatarSource?: unknown;
    avatarStatus?: unknown;
    avatarReason?: unknown;
  },
) {
  const status =
    data.avatarStatus === "none" ||
    data.avatarStatus === "local" ||
    data.avatarStatus === "remote" ||
    data.avatarStatus === "data"
      ? data.avatarStatus
      : null;
  host.chatAvatarSource =
    typeof data.avatarSource === "string" && data.avatarSource.trim()
      ? data.avatarSource.trim()
      : null;
  host.chatAvatarStatus = status;
  host.chatAvatarReason =
    typeof data.avatarReason === "string" && data.avatarReason.trim()
      ? data.avatarReason.trim()
      : null;
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

export async function refreshChatAvatar(host: ChatAvatarHost) {
  if (!host.connected) {
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
  clearChatAvatarState(host);
  const authHeader = resolveControlUiAuthHeader(host);
  const headers = buildControlUiAuthHeaders(authHeader);
  const url = buildAvatarMetaUrl(host.basePath, agentId);

  const metaController = new AbortController();
  const metaTimeout = scheduleChatAvatarFetchTimeout(metaController, "chat avatar metadata fetch");
  let avatarUrl: string;
  try {
    const res = await fetch(url, {
      method: "GET",
      ...(headers ? { headers } : {}),
      signal: metaController.signal,
    });
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      return;
    }
    if (!res.ok) {
      clearChatAvatarState(host);
      return;
    }
    const data = (await res.json()) as {
      avatarUrl?: unknown;
      avatarSource?: unknown;
      avatarStatus?: unknown;
      avatarReason?: unknown;
    };
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      return;
    }
    setChatAvatarMeta(host, data);
    avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    if (!avatarUrl || !isRenderableControlUiAvatarUrl(avatarUrl)) {
      clearChatAvatarUrl(host);
      return;
    }
    if (!isLocalControlUiAvatarUrl(avatarUrl)) {
      setChatAvatarUrl(host, avatarUrl);
      return;
    }
  } catch {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      clearChatAvatarState(host);
    }
    return;
  } finally {
    clearTimeout(metaTimeout);
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
      if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
        clearChatAvatarUrl(host);
      }
      return;
    }
    const blobUrl = URL.createObjectURL(await avatarRes.blob());
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    setChatAvatarUrl(host, blobUrl);
  } catch {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      clearChatAvatarState(host);
    }
  } finally {
    clearTimeout(avatarTimeout);
  }
}
