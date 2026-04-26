import { html } from "lit";
import type { AssistantIdentity } from "../assistant-identity.ts";
import {
  resolveLocalUserAvatarText,
  resolveLocalUserAvatarUrl,
  resolveLocalUserName,
} from "../user-identity.ts";
import {
  assistantAvatarFallbackUrl,
  isRenderableControlUiAvatarUrl,
  resolveAssistantTextAvatar,
} from "../views/agents-utils.ts";
import { normalizeRoleForGrouping } from "./role-normalizer.ts";

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
