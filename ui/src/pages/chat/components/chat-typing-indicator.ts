import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { renderChatAvatar } from "../chat-avatar.ts";

export function renderChatTypingIndicator(
  actors: readonly { id: string; label: string }[] | undefined,
) {
  if (!actors?.length) {
    return null;
  }
  const statusText =
    actors.length === 1
      ? t("chat.sessionSuggestions.typing", { name: actors[0]?.label ?? "" })
      : t("chat.sessionSuggestions.typingMany", {
          names: actors.map((actor) => actor.label).join(", "),
        });
  return html`<div class="agent-chat__typing-indicator" role="status">
    <span class="agent-chat__typing-avatars" aria-hidden="true">
      ${actors
        .slice(0, 3)
        .map((actor) =>
          renderChatAvatar("user", undefined, undefined, undefined, undefined, {
            id: actor.id,
            name: actor.label,
          }),
        )}
    </span>
    <span class="agent-chat__typing-bubble" aria-hidden="true">
      <svg class="agent-chat__typing-tail" viewBox="0 0 12 12">
        <path d="M12 0c-.5 5.5-3.5 9.5-11 11 4.5-3.5 5.5-7 5.5-11H12Z"></path>
      </svg>
      <span></span><span></span><span></span>
    </span>
    <span class="sr-only">${statusText}</span>
  </div>`;
}
