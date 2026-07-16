import { html, nothing } from "lit";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";

export function renderChatDivider(
  item: Extract<ChatItem, { kind: "divider" }>,
  onOpenSessionCheckpoints?: () => void | Promise<void>,
) {
  return html`
    <div class="chat-divider" data-chat-row-key=${item.key} data-ts=${String(item.timestamp)}>
      <div
        class="chat-divider__rule"
        role="separator"
        aria-label=${item.metric ? `${item.label}, ${item.metric}` : item.label}
      >
        <span class="chat-divider__line"></span>
        <span class="chat-divider__label">
          <span>${item.label}</span>
          ${item.metric
            ? html`
                <span class="chat-divider__separator" aria-hidden="true">·</span>
                <span class="chat-divider__metric">${item.metric}</span>
              `
            : nothing}
        </span>
        <span class="chat-divider__line"></span>
      </div>
      ${item.description || item.action
        ? html`
            <div class="chat-divider__details">
              ${item.description
                ? html`<span class="chat-divider__description">${item.description}</span>`
                : nothing}
              ${item.action?.kind === "session-checkpoints" && onOpenSessionCheckpoints
                ? html`
                    <button
                      type="button"
                      class="btn btn--subtle btn--sm chat-divider__action"
                      @click=${() => onOpenSessionCheckpoints()}
                    >
                      ${item.action.label}
                    </button>
                  `
                : nothing}
            </div>
          `
        : nothing}
    </div>
  `;
}
