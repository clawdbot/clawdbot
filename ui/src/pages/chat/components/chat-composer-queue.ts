import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { isInflightSteer, isSteeredQueueItem } from "../steered-chip.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";

type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueRemove: (id: string) => void;
};

function sendStateLabel(item: ChatQueueItem): string | null {
  if (isInflightSteer(item)) {
    return "Steering";
  }
  switch (item.sendState) {
    case "waiting-model":
      // Persisted state name predates reasoning and speed picker gating.
      return "Applying chat settings";
    case "waiting-idle":
      return "Waiting for current run";
    case "executing-command":
      return "Running command";
    case "waiting-reconnect":
      return "Waiting for reconnect";
    case "unconfirmed":
      return "Needs review";
    case "failed":
      return "Failed";
    default:
      return null;
  }
}

export function renderChatQueue(props: ChatQueueProps) {
  const visibleQueue = props.queue.filter((item) => item.sendState !== "sending");
  if (!visibleQueue.length) {
    return nothing;
  }
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      ${visibleQueue.map((item) => renderChatQueueItem(item, props))}
    </div>
  `;
}

function renderChatQueueItem(item: ChatQueueItem, props: ChatQueueProps) {
  const stateLabel = sendStateLabel(item);
  const steered = isSteeredQueueItem(item);
  const failed = item.sendState === "failed" || item.sendState === "unconfirmed";
  const reconnecting = item.sendState === "waiting-reconnect";
  const busy = item.sendState === "executing-command" || isInflightSteer(item);
  const canSteer =
    Boolean(props.canAbort && props.onQueueSteer) &&
    !steered &&
    (item.sendState === undefined || item.sendState === "waiting-idle") &&
    !item.localCommandName;
  const text = item.text || (item.attachments?.length ? `Image (${item.attachments.length})` : "");
  const itemClass = `chat-queue__item${steered ? " chat-queue__item--steered" : ""}${
    failed ? " chat-queue__item--failed" : ""
  }${reconnecting ? " chat-queue__item--reconnect" : ""}`;
  // Row order keeps the actions on the first flex line; the error wraps below
  // them via flex-basis so failed rows grow by one line instead of a card.
  return html`
    <div class=${itemClass}>
      ${reconnecting
        ? html`<span class="chat-queue__dot" aria-hidden="true"></span>`
        : html`<span class="chat-queue__icon" aria-hidden="true">
            ${failed ? icons.alertTriangle : icons.clock}
          </span>`}
      ${renderChatAuthorAvatar(item.sender)}
      ${steered
        ? html`<span class="chat-queue__badge chat-queue__badge--steered"
            >${t("chat.queue.steered")}</span
          >`
        : nothing}
      ${stateLabel
        ? html`<span
            class="chat-queue__badge"
            title=${ifDefined(reconnecting ? item.sendError : undefined)}
            >${stateLabel}</span
          >`
        : nothing}
      <span class="chat-queue__text" title=${text}>${text}</span>
      <span class="chat-queue__actions">
        ${failed && props.onQueueRetry
          ? html`
              <button
                class="chat-queue__retry"
                type="button"
                aria-label=${t("chat.queue.retryQueuedMessage")}
                @click=${() => props.onQueueRetry?.(item.id)}
              >
                ${icons.refresh}
                <span>${t("chat.queue.retry")}</span>
              </button>
            `
          : nothing}
        ${canSteer
          ? html`
              <button
                class="chat-queue__steer"
                type="button"
                aria-label=${t("chat.queue.steerQueuedMessage")}
                @click=${() => props.onQueueSteer?.(item.id)}
              >
                ${icons.cornerDownRight}
                <span>${t("chat.queue.steer")}</span>
              </button>
            `
          : nothing}
        ${busy
          ? nothing
          : html`
              <openclaw-tooltip .content=${t("chat.queue.removeQueuedMessage")}>
                <button
                  class="chat-queue__remove"
                  type="button"
                  aria-label=${t("chat.queue.removeQueuedMessage")}
                  @click=${() => props.onQueueRemove(item.id)}
                >
                  ${icons.x}
                </button>
              </openclaw-tooltip>
            `}
      </span>
      ${
        // Reconnect rows auto-retry, so the raw transport error is noise there;
        // it stays inspectable via the badge tooltip. Failed/unconfirmed rows
        // keep the visible error because the user must act on them.
        item.sendError && !reconnecting
          ? html`<span class="chat-queue__error">${item.sendError}</span>`
          : nothing
      }
    </div>
  `;
}
