import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import type { ChatQueueItem } from "../ui-types.ts";

export type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueSteer?: (id: string) => void;
  onQueueRemove: (id: string) => void;
};

export function renderChatQueue(props: ChatQueueProps) {
  if (!props.queue.length) {
    return nothing;
  }
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      <div class="chat-queue__title">Queued (${props.queue.length})</div>
      <div class="chat-queue__list">
        ${props.queue.map(
          (item) => html`
            <div
              class="chat-queue__item ${item.kind === "steered" ? "chat-queue__item--steered" : ""}"
            >
              <div class="chat-queue__main">
                ${item.kind === "steered"
                  ? html`<span class="chat-queue__badge">Steered</span>`
                  : nothing}
                <div class="chat-queue__text">
                  ${item.text ||
                  (item.attachments?.length ? `Image (${item.attachments.length})` : "")}
                </div>
              </div>
              <div class="chat-queue__actions">
                ${props.canAbort &&
                props.onQueueSteer &&
                item.kind !== "steered" &&
                !item.localCommandName
                  ? html`
                      <button
                        class="btn chat-queue__steer"
                        type="button"
                        title="Steer now"
                        aria-label="Steer queued message"
                        @click=${() => props.onQueueSteer?.(item.id)}
                      >
                        ${icons.cornerDownRight}
                        <span>Steer</span>
                      </button>
                    `
                  : nothing}
                <button
                  class="btn chat-queue__remove"
                  type="button"
                  aria-label="Remove queued message"
                  @click=${() => props.onQueueRemove(item.id)}
                >
                  ${icons.x}
                </button>
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}
