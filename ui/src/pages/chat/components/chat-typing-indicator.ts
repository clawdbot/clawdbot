import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";

export function renderChatTypingIndicator(
  actors: readonly { id: string; label: string }[] | undefined,
) {
  if (!actors?.length) {
    return null;
  }
  return html`<div class="agent-chat__typing-indicator" role="status">
    <span class="agent-chat__typing-avatars" aria-hidden="true">
      ${actors
        .slice(0, 3)
        .map((actor) => renderChatAuthorAvatar({ id: actor.id, name: actor.label }))}
    </span>
    <span class="agent-chat__typing-text"
      >${actors.length === 1
        ? t("chat.sessionSuggestions.typing", { name: actors[0]?.label ?? "" })
        : t("chat.sessionSuggestions.typingMany", {
            names: actors.map((actor) => actor.label).join(", "),
          })}</span
    >
  </div>`;
}
