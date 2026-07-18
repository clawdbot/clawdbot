// Control UI chat module implements chat welcome behavior.
import { html, nothing } from "lit";
import type { GatewaySessionRow, SessionsListResult } from "../../../api/types.ts";
import "../../../components/openclaw-mascot.ts";
import { t } from "../../../i18n/index.ts";
import { resolveAssistantTextAvatar, resolveChatAvatarRenderUrl } from "../../../lib/avatar.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import {
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkSubtitle,
} from "../../../lib/session-display.ts";
import { getVisibleSessionRows } from "../../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../../lib/sessions/session-key.ts";

type ChatWelcomeProps = {
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  /** Hero hint override; defaults to the chat slash-command hint. */
  hint?: unknown;
  /** Rendered between the hero and the recents (the new-session draft composer). */
  composer?: unknown;
  sessions?: SessionsListResult | null;
  sessionKey?: string;
  sessionHost?: UiSessionDefaultsHost | null;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onOpenSession?: (sessionKey: string) => void;
};

type WelcomeMascot = HTMLElement & { tease: boolean; catchOnce: () => void };

const WELCOME_SUGGESTION_KEYS = [
  "chat.welcome.suggestions.whatCanYouDo",
  "chat.welcome.suggestions.summarizeRecentSessions",
  "chat.welcome.suggestions.configureChannel",
  "chat.welcome.suggestions.checkSystemHealth",
];

const WELCOME_RECENT_SESSION_LIMIT = 5;

function resolveAssistantAvatarUrl(
  props: Pick<ChatWelcomeProps, "assistantAvatar" | "assistantAvatarUrl">,
): string | null {
  return resolveChatAvatarRenderUrl(props.assistantAvatarUrl, {
    identity: {
      avatar: props.assistantAvatar ?? undefined,
      avatarUrl: props.assistantAvatarUrl ?? undefined,
    },
  });
}

export function resolveAssistantDisplayAvatar(
  props: Pick<ChatWelcomeProps, "assistantAvatar" | "assistantAvatarUrl">,
): string | null {
  return resolveAssistantAvatarUrl(props) ?? resolveAssistantTextAvatar(props.assistantAvatar);
}

/**
 * Recent user-created chats for the welcome screen: the sidebar's visible-row
 * rules (no archived/cron/subagent/spawned rows, scoped to the active agent)
 * minus channel-originated sessions — those live in their channel sections and
 * are not something the user "starts" from here.
 */
function selectWelcomeRecentSessions(
  props: Pick<ChatWelcomeProps, "sessions" | "sessionKey" | "sessionHost">,
): GatewaySessionRow[] {
  if (!props.sessions) {
    return [];
  }
  const host = props.sessionHost ?? {};
  // Bare global keys carry no agent; the selected agent lives in host state
  // (assistantAgentId). Mirrors resolveSessionNavigation's agent resolution.
  const defaultAgentId = resolveUiSelectedGlobalAgentId(host);
  const agentId = parseAgentSessionKey(props.sessionKey)?.agentId ?? defaultAgentId;
  return (
    getVisibleSessionRows(props.sessions, { agentId, defaultAgentId, filterByAgent: true })
      .filter(
        (row) =>
          !areUiSessionKeysEquivalent(row.key, props.sessionKey) &&
          !resolveChannelSessionInfo(row.key, row.channel).channelSession,
      )
      // Pure recency, unlike the sidebar's pin-aware sort: a "Recent chats"
      // list capped at five must not let stale pinned rows hide newer chats.
      .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.key.localeCompare(b.key))
      .slice(0, WELCOME_RECENT_SESSION_LIMIT)
  );
}

function renderWelcomeClawd() {
  return html`
    <div class="agent-chat__welcome-clawd" aria-hidden="true">
      <openclaw-mascot mood="idle" .size=${112}></openclaw-mascot>
    </div>
  `;
}

function renderWelcomeRecentSessions(
  rows: GatewaySessionRow[],
  onOpenSession: ((sessionKey: string) => void) | undefined,
) {
  return html`
    <div class="agent-chat__recents">
      <div class="agent-chat__recents-title">${t("chat.welcome.recentSessions")}</div>
      ${rows.map((row) => {
        const subtitle = resolveSessionWorkSubtitle(row);
        return html`
          <button type="button" class="agent-chat__recent" @click=${() => onOpenSession?.(row.key)}>
            <span class="agent-chat__recent-name">${resolveSessionDisplayName(row.key, row)}</span>
            ${subtitle ? html`<span class="agent-chat__recent-sub">${subtitle}</span>` : nothing}
            <span class="agent-chat__recent-time">
              ${formatRelativeTimestamp(row.updatedAt, { fallback: "" })}
            </span>
          </button>
        `;
      })}
    </div>
  `;
}

function renderWelcomeSuggestions(props: Pick<ChatWelcomeProps, "onDraftChange" | "onSend">) {
  return html`
    <div class="agent-chat__suggestions">
      ${WELCOME_SUGGESTION_KEYS.map((key) => {
        const text = t(key);
        return html`
          <button
            type="button"
            class="agent-chat__suggestion"
            @click=${() => {
              props.onDraftChange(text);
              props.onSend();
            }}
          >
            ${text}
          </button>
        `;
      })}
    </div>
  `;
}

function renderWelcomeHero(
  props: Pick<ChatWelcomeProps, "assistantName" | "assistantAvatar" | "assistantAvatarUrl"> & {
    hint: unknown;
  },
) {
  const name = props.assistantName || "Assistant";
  const avatar = resolveAssistantAvatarUrl(props);
  const avatarText = avatar ? null : resolveAssistantTextAvatar(props.assistantAvatar);
  return html`
    ${avatar
      ? html`<img class="agent-chat__welcome-avatar" src=${avatar} alt=${name} />`
      : avatarText
        ? html`<div class="agent-chat__avatar agent-chat__avatar--text" aria-label=${name}>
            ${avatarText}
          </div>`
        : renderWelcomeClawd()}
    <h2>${name}</h2>
    <p class="agent-chat__hint">${props.hint}</p>
  `;
}

/** The start-screen welcome block, shared by the empty chat and the new-session draft. */
export function renderWelcomeState(props: ChatWelcomeProps) {
  const recentSessions = selectWelcomeRecentSessions(props);
  let fileDragDepth = 0;
  const mascotFor = (event: DragEvent): WelcomeMascot | null => {
    const target = event.currentTarget;
    return target instanceof HTMLElement
      ? target.querySelector<WelcomeMascot>(".agent-chat__welcome-clawd openclaw-mascot")
      : null;
  };

  return html`
    <div
      class="agent-chat__welcome"
      style="--agent-color: var(--accent)"
      @dragenter=${(event: DragEvent) => {
        if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
          return;
        }
        fileDragDepth += 1;
        const mascot = mascotFor(event);
        if (mascot) {
          mascot.tease = true;
        }
      }}
      @dragleave=${(event: DragEvent) => {
        fileDragDepth = Math.max(0, fileDragDepth - 1);
        const mascot = mascotFor(event);
        if (mascot && fileDragDepth === 0) {
          mascot.tease = false;
        }
      }}
      @drop=${(event: DragEvent) => {
        if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
          return;
        }
        fileDragDepth = 0;
        const mascot = mascotFor(event);
        if (mascot) {
          mascot.tease = false;
          mascot.catchOnce();
        }
      }}
    >
      ${renderWelcomeHero({
        assistantName: props.assistantName,
        assistantAvatar: props.assistantAvatar,
        assistantAvatarUrl: props.assistantAvatarUrl,
        hint:
          props.hint ??
          html`${t("chat.welcome.hintBeforeShortcut")} <kbd>/</kbd> ${t(
              "chat.welcome.hintAfterShortcut",
            )}`,
      })}
      ${props.composer ?? nothing}
      ${recentSessions.length > 0
        ? renderWelcomeRecentSessions(recentSessions, props.onOpenSession)
        : renderWelcomeSuggestions(props)}
    </div>
  `;
}
