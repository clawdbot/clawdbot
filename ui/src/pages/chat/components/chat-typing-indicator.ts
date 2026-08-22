import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { renderChatAvatar } from "../chat-avatar.ts";

export function renderChatTypingIndicator(
  actors: readonly { id: string; label: string; preview?: string }[] | undefined,
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
  const previewActors = actors.filter((actor) => actor.preview?.trim());
  const indicatorActors = actors.filter((actor) => !actor.preview?.trim());
  return html`<div class="agent-chat__typing-indicator">
    ${previewActors.map(
      (actor) => html`<div class="agent-chat__typing-preview-row">
        ${renderChatAvatar("user", undefined, undefined, undefined, undefined, {
          id: actor.id,
          name: actor.label,
        })}
        <div class="agent-chat__typing-preview-content">
          <span class="agent-chat__typing-preview-label">
            ${t("chat.sessionSuggestions.typing", { name: actor.label })}
          </span>
          <span class="agent-chat__typing-preview-bubble">${actor.preview}</span>
        </div>
      </div>`,
    )}
    ${indicatorActors.length
      ? html`<div class="agent-chat__typing-dots-row">
          <span class="agent-chat__typing-avatars" aria-hidden="true">
            ${indicatorActors.slice(0, 3).map((actor) =>
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
        </div>`
      : null}
    <span class="sr-only" role="status">${statusText}</span>
  </div>`;
}
