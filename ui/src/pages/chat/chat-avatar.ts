// Control UI chat module implements chat avatar behavior.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type TemplateResult } from "lit";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { fetchAssistantIdentity } from "../../app/assistant-identity.ts";
import {
  resolveLocalUserAvatarText,
  resolveLocalUserAvatarUrl,
  resolveLocalUserName,
} from "../../app/user-identity.ts";
import { icons } from "../../components/icons.ts";
import {
  identityAvatarClass,
  identityAvatarImage,
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
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
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
        sourceUrl: userAvatarUrl.startsWith("/") ? userAvatarUrl : undefined,
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
) {
  const value = avatar?.trim() || "";
  if (isAvatarUrl(value)) {
    return html`<img
      class="chat-avatar assistant"
      src=${identityAvatarImage(value)}
      alt=${name}
    />`;
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
const senderAvatarRequests = new WeakMap<object, object>();
const senderAvatarInputs = new WeakMap<object, unknown[]>();

type ChatAvatarSnapshot = {
  reason: string | null;
  source: string | null;
  status: "none" | "local" | "remote" | "data" | null;
  url: string | null;
  release: () => void;
};

const CHAT_AVATAR_CACHE_LIMIT = 24;
const currentAvatarReference = Symbol("current-chat-avatar");
const chatAvatarReferences = new WeakMap<
  object,
  Map<string | typeof currentAvatarReference, () => void>
>();

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

function clearChatAvatarState(host: ChatAvatarHost) {
  const references = chatAvatarReferences.get(host);
  references?.get(currentAvatarReference)?.();
  references?.delete(currentAvatarReference);
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

function rememberChatAvatarReference(
  host: ChatAvatarHost,
  key: string | typeof currentAvatarReference,
  release: () => void,
) {
  let references = chatAvatarReferences.get(host);
  if (!references) {
    references = new Map();
    chatAvatarReferences.set(host, references);
  }
  references.get(key)?.();
  references.set(key, release);
}

export function invalidateChatAvatarCache(host: ChatAvatarHost): void {
  beginChatAvatarRequest(host);
  for (const release of chatAvatarReferences.get(host)?.values() ?? []) {
    release();
  }
  chatAvatarReferences.delete(host);
  chatAvatarDisplayedAgents.delete(host);
  senderAvatarRequests.delete(host);
  senderAvatarInputs.delete(host);
  host.senderAgentAvatars = undefined;
  clearChatAvatarState(host);
}

async function loadChatAvatarSnapshot(
  host: ChatAvatarHost,
  agentId: string,
): Promise<ChatAvatarSnapshot | null> {
  const client = host.client;
  const epoch = host.connectionEpoch;
  const sessionAgentId = resolveAgentIdForSession(host);
  if (!client || !host.connected) {
    return null;
  }
  let release: () => void = () => undefined;
  try {
    const identity = await fetchAssistantIdentity(client, agentId);
    if (
      !identity ||
      !host.connected ||
      host.client !== client ||
      host.connectionEpoch !== epoch ||
      resolveAgentIdForSession(host) !== sessionAgentId
    ) {
      return null;
    }
    const avatar = identity.avatar?.trim() ?? "";
    const imageUrl = avatar.startsWith("/")
      ? resolveAvatarImageUrl(avatar)
      : isRenderableControlUiAvatarUrl(avatar)
        ? avatar
        : null;
    release = retainAvatarImageUrl(imageUrl);
    const url = await imageUrl;
    // A failed replacement keeps the displayed image; empty/text identities clear it.
    if (imageUrl !== null && url === null) {
      release();
      return null;
    }
    return {
      release,
      source: identity.avatarSource ?? null,
      status: identity.avatarStatus ?? null,
      reason: identity.avatarReason ?? null,
      url,
    };
  } catch {
    release();
    return null;
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
  // A unique token keeps a batch retired by invalidation from becoming current again.
  const request = {};
  senderAvatarRequests.set(host, request);
  const sessionKey = host.sessionKey;
  const agentId = resolveAgentIdForSession(host);
  const client = host.client;
  const epoch = host.connectionEpoch;
  const agents = host.agentsList?.agents;
  const roster = new Set(agents?.map((agent) => agent.id));
  // Bound forwarded-agent work independently of transcript size.
  const ids = [...new Set(agentIds)]
    .filter((id) => id !== agentId && roster.has(id))
    .slice(0, CHAT_AVATAR_CACHE_LIMIT - 1);
  if (!host.connected || ids.length === 0) {
    const references = chatAvatarReferences.get(host);
    for (const [key, release] of references ?? []) {
      if (key !== currentAvatarReference) {
        release();
        references?.delete(key);
      }
    }
    if (host.senderAgentAvatars?.size) {
      host.senderAgentAvatars = new Map();
      host.requestUpdate?.();
    }
    return;
  }
  const previousAvatars = host.senderAgentAvatars;
  const snapshots = await Promise.all(ids.map((id) => loadChatAvatarSnapshot(host, id)));
  if (
    !host.connected ||
    host.client !== client ||
    host.connectionEpoch !== epoch ||
    host.agentsList?.agents !== agents ||
    host.sessionKey !== sessionKey ||
    resolveAgentIdForSession(host) !== agentId ||
    senderAvatarRequests.get(host) !== request
  ) {
    for (const snapshot of snapshots) {
      snapshot?.release();
    }
    return;
  }
  const references = chatAvatarReferences.get(host);
  for (const [key, release] of references ?? []) {
    if (key !== currentAvatarReference && !ids.includes(key)) {
      release();
      references?.delete(key);
    }
  }
  host.senderAgentAvatars = new Map(
    ids.map((id, index) => {
      const snapshot = snapshots[index];
      if (snapshot) {
        rememberChatAvatarReference(host, id, snapshot.release);
      }
      return [id, snapshot ? snapshot.url : (previousAvatars?.get(id) ?? null)];
    }),
  );
  host.requestUpdate?.();
}

export async function refreshChatAvatar(host: ChatAvatarHost) {
  if (!host.connected) {
    invalidateChatAvatarCache(host);
    return;
  }
  const sessionKey = host.sessionKey;
  const client = host.client;
  const epoch = host.connectionEpoch;
  const requestVersion = beginChatAvatarRequest(host);
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    clearChatAvatarState(host);
    return;
  }
  const showingSameAgent = chatAvatarDisplayedAgents.get(host) === agentId;
  if (!showingSameAgent) {
    clearChatAvatarState(host);
  }
  const snapshot = await loadChatAvatarSnapshot(host, agentId);
  if (
    !host.connected ||
    host.client !== client ||
    host.connectionEpoch !== epoch ||
    !shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)
  ) {
    snapshot?.release();
    return;
  }
  if (snapshot) {
    rememberChatAvatarReference(host, currentAvatarReference, snapshot.release);
    applyChatAvatarSnapshot(host, agentId, snapshot);
  } else if (!showingSameAgent) {
    clearChatAvatarState(host);
  }
}
