import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { chatQueueMovableSegments } from "../../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { isInflightSteer, isSteeredQueueItem } from "../steered-chip.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";

type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueMove?: (id: string, toIndex: number) => void;
  onQueueRemove: (id: string) => void;
};

const DRAG_MIME = "application/x-openclaw-queued-message";
const DRAG_OVER_CLASS = "chat-queue__item--drop-target";

function sendStateLabel(item: ChatQueueItem): string | null {
  switch (item.sendState) {
    case "waiting-model":
      // Persisted state name predates reasoning and speed picker gating.
      return t("chat.queue.states.applyingSettings");
    case "waiting-idle":
      return t("chat.queue.states.waitingForRun");
    case "executing-command":
      return t("chat.queue.states.runningCommand");
    case "waiting-reconnect":
      return t("chat.queue.states.waitingForReconnect");
    case "unconfirmed":
      return t("chat.queue.states.needsReview");
    case "failed":
      return t("common.failed");
    default:
      return null;
  }
}

export function renderChatQueue(props: ChatQueueProps) {
  const visibleQueue = props.queue.filter((item) => item.sendState !== "sending");
  if (!visibleQueue.length) {
    return nothing;
  }
  // Move positions address one movable segment, matching what the reorder owner
  // permutes. A row attached to a run keeps its place and ends the segment, so
  // the handle never offers a move across it.
  const movableSegments = chatQueueMovableSegments(visibleQueue).map((rows) =>
    rows.map((row) => row.id),
  );
  // Keyed rows so a reorder moves the existing DOM node instead of rewriting
  // it in place; that is what keeps focus on the handle the operator is using.
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      ${repeat(
        visibleQueue,
        (item) => item.id,
        (item) => renderChatQueueItem(item, props, movableSegments),
      )}
    </div>
  `;
}

function setDropTarget(event: DragEvent, active: boolean): void {
  const row = event.currentTarget;
  if (row instanceof HTMLElement) {
    row.classList.toggle(DRAG_OVER_CLASS, active);
  }
}

function renderChatQueueItem(
  item: ChatQueueItem,
  props: ChatQueueProps,
  movableSegments: readonly (readonly string[])[],
) {
  const stateLabel = sendStateLabel(item);
  const failed = item.sendState === "failed" || item.sendState === "unconfirmed";
  const steered = isSteeredQueueItem(item) && !failed;
  const reconnecting = item.sendState === "waiting-reconnect";
  const busy = item.sendState === "executing-command" || isInflightSteer(item);
  const canSteer =
    Boolean(props.canAbort && props.onQueueSteer) &&
    !steered &&
    (item.sendState === undefined || item.sendState === "waiting-idle") &&
    !item.localCommandName;
  const segment = movableSegments.find((ids) => ids.includes(item.id)) ?? [];
  const moveIndex = segment.indexOf(item.id);
  const move = props.onQueueMove;
  const canMove = Boolean(move) && moveIndex >= 0 && segment.length > 1;
  const text =
    item.text ||
    (item.attachments?.length
      ? t("chat.queue.imageCount", { count: String(item.attachments.length) })
      : "");
  const itemClass = `chat-queue__item${steered ? " chat-queue__item--steered" : ""}${
    failed ? " chat-queue__item--failed" : ""
  }${reconnecting ? " chat-queue__item--reconnect" : ""}`;
  // Row order keeps the actions on the first flex line; the error wraps below
  // them via flex-basis so failed rows grow by one line instead of a card.
  return html`
    <div
      class=${itemClass}
      draggable=${canMove ? "true" : "false"}
      @dragstart=${canMove
        ? (event: DragEvent) => {
            event.dataTransfer?.setData(DRAG_MIME, item.id);
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "move";
            }
          }
        : undefined}
      @dragover=${canMove
        ? (event: DragEvent) => {
            if (!event.dataTransfer?.types.includes(DRAG_MIME)) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(event, true);
          }
        : undefined}
      @dragleave=${canMove ? (event: DragEvent) => setDropTarget(event, false) : undefined}
      @drop=${canMove
        ? (event: DragEvent) => {
            const draggedId = event.dataTransfer?.getData(DRAG_MIME);
            setDropTarget(event, false);
            // Index space is per segment, so a drop from another one would land
            // the row at an unrelated position; refuse it instead of guessing.
            if (!draggedId || draggedId === item.id || !segment.includes(draggedId)) {
              return;
            }
            event.preventDefault();
            move?.(draggedId, moveIndex);
          }
        : undefined}
    >
      ${canMove
        ? html`<button
            class="chat-queue__grip"
            type="button"
            aria-label=${t("chat.queue.reorderQueuedMessage")}
            aria-keyshortcuts="ArrowUp ArrowDown"
            @keydown=${(event: KeyboardEvent) => {
              const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
              if (delta === 0) {
                return;
              }
              // The handle owns reordering for pointer and keyboard alike, so
              // arrow keys here must not also scroll the transcript.
              event.preventDefault();
              move?.(item.id, moveIndex + delta);
            }}
          >
            ${icons.gripVertical}
          </button>`
        : nothing}
      ${reconnecting
        ? html`<span class="chat-queue__dot" aria-hidden="true"></span>`
        : html`<span class="chat-queue__icon" aria-hidden="true">
            ${failed ? icons.alertTriangle : icons.clock}
          </span>`}
      ${renderChatAuthorAvatar(item.sender)}
      ${steered
        ? html`<span class="chat-queue__badge chat-queue__badge--steered"
            >${t("chat.queue.states.steering")}</span
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
