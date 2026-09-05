import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { readPendingSendFailure } from "../chat-thread-items.ts";

export type ChatSendStatusActions = {
  onRetryQueuedMessage?: (id: string) => void;
  onDiscardQueuedMessage?: (id: string) => void;
  queuedMessageAction?: { id: string; label?: string; onAction?: () => void };
};

export function renderChatSendStatus(
  failure: ReturnType<typeof readPendingSendFailure>,
  actions: ChatSendStatusActions,
) {
  if (!failure) {
    return nothing;
  }
  const action =
    actions.queuedMessageAction?.id === failure.id ? actions.queuedMessageAction : undefined;
  const retry = action?.onAction ?? actions.onRetryQueuedMessage;
  const discard =
    failure.state === "unconfirmed" && !action ? actions.onDiscardQueuedMessage : undefined;
  return html`<span
    class="chat-send-status"
    title=${failure.error ?? nothing}
    data-send-state=${failure.state}
  >
    <span aria-hidden="true">·</span>
    <span
      >${t(
        failure.state === "unconfirmed" ? "chat.queue.deliveryUnconfirmed" : "chat.queue.notSent",
      )}</span
    >
    ${
      retry
        ? html`
            <span aria-hidden="true">·</span>
            <button
              class="chat-send-status__action chat-send-status__retry"
              type="button"
              aria-label=${action?.label ?? t("chat.queue.retryQueuedMessage")}
              @click=${() => retry(failure.id)}
            >
              ${action?.label ?? t("chat.queue.retry")}
            </button>
          `
        : nothing
    }
    ${
      discard
        ? html`
            <span aria-hidden="true">·</span>
            <button
              class="chat-send-status__action chat-send-status__discard"
              type="button"
              title=${t("chat.queue.discardPendingMessage")}
              @click=${(event: MouseEvent) => {
                // Chromium may retarget click 2 to the next row after removal.
                if (event.detail <= 1) {
                  discard(failure.id);
                }
              }}
            >
              ${t("chat.queue.discard")}
            </button>
          `
        : nothing
    }
  </span>`;
}
