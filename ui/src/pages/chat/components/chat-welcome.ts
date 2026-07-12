// Control UI chat module implements chat welcome behavior.
import { html, nothing } from "lit";
import type { GatewaySessionRow, SessionsListResult } from "../../../api/types.ts";
import {
  canonicalLobsterLook,
  LOBSTER_PET_PALETTES,
  renderLobsterSvg,
} from "../../../components/lobster-pet.ts";
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
  sessions?: SessionsListResult | null;
  sessionKey?: string;
  sessionHost?: UiSessionDefaultsHost | null;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onOpenSession?: (sessionKey: string) => void;
};

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
export function selectWelcomeRecentSessions(
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

// The default Clawd mascot: same species as the sidebar lobster pet, rendered
// big and borderless with its own gentle idle loop (see layout.css).
function renderWelcomeClawd() {
  const palette =
    LOBSTER_PET_PALETTES.find((entry) => entry.id === "crimson") ?? LOBSTER_PET_PALETTES[0];
  const look = canonicalLobsterLook(palette);
  return html`
    <div
      class="agent-chat__welcome-clawd"
      style=${`--lob-shell:${look.palette.shell};--lob-claw:${look.palette.claw}`}
      aria-hidden="true"
    >
      ${renderLobsterSvg(look)}
    </div>
  `;
}

export function renderWelcomeRecentSessions(
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

export function renderWelcomeSuggestions(
  props: Pick<ChatWelcomeProps, "onDraftChange" | "onSend">,
) {
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

/** Shared hero (avatar, name, hint) for the chat welcome and the new-session draft. */
export function renderWelcomeHero(
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

export function renderWelcomeState(props: ChatWelcomeProps) {
  const recentSessions = selectWelcomeRecentSessions(props);

  return html`
    <div class="agent-chat__welcome" style="--agent-color: var(--accent)">
      ${renderWelcomeHero({
        assistantName: props.assistantName,
        assistantAvatar: props.assistantAvatar,
        assistantAvatarUrl: props.assistantAvatarUrl,
        hint: html`${t("chat.welcome.hintBeforeShortcut")} <kbd>/</kbd> ${t(
            "chat.welcome.hintAfterShortcut",
          )}`,
      })}
      ${recentSessions.length > 0
        ? renderWelcomeRecentSessions(recentSessions, props.onOpenSession)
        : renderWelcomeSuggestions(props)}
    </div>
  `;
}
