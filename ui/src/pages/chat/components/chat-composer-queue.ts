import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  chatQueueMovableSegments,
  compareChatQueueOrder,
  isMovableChatQueueItem,
} from "../../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { isInflightSteer, isSteeredQueueItem } from "../steered-chip.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";

type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueMove?: (id: string, toIndex: number) => void;
  onQueueEdit?: (id: string) => void;
  onQueueEditChange?: (text: string) => void;
  onQueueEditSubmit?: () => void;
  onQueueEditCancel?: () => void;
  editingId?: string | null;
  editingText?: string;
  onQueueRemove: (id: string) => void;
};

/** Queue-level reorder facts: what the column shows, and what may move where. */
type ChatQueueReorder = {
  segments: readonly (readonly string[])[];
  offered: boolean;
};

const DRAG_MIME = "application/x-openclaw-queued-message";
const DRAG_OVER_CLASS = "chat-queue__item--drop-target";

export function steerableQueuedMessage(queue: readonly ChatQueueItem[]): ChatQueueItem | undefined {
  return queue
    .toSorted(compareChatQueueOrder)
    .find(
      (item) =>
        !isSteeredQueueItem(item) &&
        (item.sendState === undefined || item.sendState === "waiting-idle") &&
        !item.localCommandName,
    );
}

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
  // the handle never offers a move across it. An edited row holds the queue
  // behind it in the drain, so it is a barrier on the same terms.
  const movableSegments = chatQueueMovableSegments(
    visibleQueue,
    (item) => isMovableChatQueueItem(item) && item.id !== props.editingId,
  ).map((rows) => rows.map((row) => row.id));
  const reorder: ChatQueueReorder = {
    segments: movableSegments,
    // Whether this queue reorders at all, which is a queue-level fact: an open
    // edit shrinks the segments but must not retract the handle column.
    offered: visibleQueue.filter(isMovableChatQueueItem).length > 1,
  };
  // Keyed rows so a reorder moves the existing DOM node instead of rewriting
  // it in place; that is what keeps focus on the handle the operator is using.
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      ${repeat(
        visibleQueue,
        (item) => item.id,
        (item) => renderChatQueueItem(item, props, reorder),
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
  reorder: ChatQueueReorder,
) {
  const stateLabel = sendStateLabel(item);
  const failed = item.sendState === "failed" || item.sendState === "unconfirmed";
  const steered = isSteeredQueueItem(item) && !failed;
  const reconnecting = item.sendState === "waiting-reconnect";
  const busy = item.sendState === "executing-command" || isInflightSteer(item);
  const editing = props.editingId === item.id;
  const canSteer =
    Boolean(props.canAbort && props.onQueueSteer) &&
    !failed &&
    steerableQueuedMessage([item]) === item &&
    !editing;
  const segment = reorder.segments.find((ids) => ids.includes(item.id)) ?? [];
  const moveIndex = segment.indexOf(item.id);
  const move = props.onQueueMove;
  // Queue-level: once any row can move, every row reserves the handle column so
  // the pill and text stay on one x whatever state a row is in. Row-level: only
  // a row that may actually move gets a live handle.
  const showsHandle = Boolean(move) && reorder.offered;
  const canMove = showsHandle && moveIndex >= 0 && segment.length > 1;
  // Every row keeps its handle and action slots in every state and goes inert
  // instead of empty while an edit is open, so no column moves mid-flow.
  const editable =
    Boolean(props.onQueueEdit) && isMovableChatQueueItem(item) && !item.localCommandName;
  const canEdit = editable && !props.editingId;
  const text =
    item.text ||
    (item.attachments?.length
      ? t("chat.queue.imageCount", { count: String(item.attachments.length) })
      : "");
  const itemClass = `chat-queue__item${steered ? " chat-queue__item--steered" : ""}${
    failed ? " chat-queue__item--failed" : ""
  }${reconnecting ? " chat-queue__item--reconnect" : ""}${
    editing ? " chat-queue__item--editing" : ""
  }`;
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
      @dblclick=${canEdit ? () => props.onQueueEdit?.(item.id) : undefined}
    >
      ${showsHandle
        ? html`<button
            class="chat-queue__grip"
            type="button"
            ?disabled=${!canMove}
            aria-label=${canMove
              ? t("chat.queue.reorderQueuedMessage")
              : t("chat.queue.reorderUnavailable")}
            aria-keyshortcuts=${ifDefined(canMove ? "ArrowUp ArrowDown" : undefined)}
            @keydown=${(event: KeyboardEvent) => {
              if (!canMove) {
                return;
              }
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
            ${failed ? icons.alertTriangle : steered ? icons.cornerDownRight : icons.outbox}
          </span>`}
      ${renderChatAuthorAvatar(item.sender)}
      ${steered
        ? html`<span class="chat-queue__badge chat-queue__badge--steered"
            >${t("chat.queue.states.steering")}</span
          >`
        : nothing}
      ${editing
        ? html`<span class="chat-queue__badge">${t("chat.queue.states.editing")}</span>`
        : stateLabel
          ? html`<span
              class="chat-queue__badge"
              title=${ifDefined(reconnecting ? item.sendError : undefined)}
              >${stateLabel}</span
            >`
          : nothing}
      ${editing
        ? html`<textarea
            class="chat-queue__edit-input"
            rows="1"
            .value=${props.editingText ?? item.text}
            aria-label=${t("chat.queue.editQueuedMessage")}
            @input=${(event: Event) => {
              props.onQueueEditChange?.((event.currentTarget as HTMLTextAreaElement).value);
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onQueueEditCancel?.();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                props.onQueueEditSubmit?.();
              }
            }}
            autofocus
          ></textarea>`
        : html`<span class="chat-queue__text" title=${text}>${text}</span>`}
      <span class="chat-queue__actions">
        ${failed && !editing && props.onQueueRetry
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
        ${editing
          ? html`
              <button
                class="chat-queue__edit-submit"
                type="button"
                aria-label=${t("chat.runControls.sendMessage")}
                @click=${() => props.onQueueEditSubmit?.()}
              >
                ${icons.check}
              </button>
              <button
                class="chat-queue__edit-cancel"
                type="button"
                aria-label=${t("chat.queue.cancelEdit")}
                @click=${() => props.onQueueEditCancel?.()}
              >
                ${icons.x}
              </button>
            `
          : editable
            ? html`
                <openclaw-tooltip .content=${t("chat.queue.editQueuedMessage")}>
                  <button
                    class="chat-queue__edit"
                    type="button"
                    ?disabled=${!canEdit}
                    aria-label=${t("chat.queue.editQueuedMessage")}
                    @click=${() => props.onQueueEdit?.(item.id)}
                  >
                    ${icons.pencil}
                  </button>
                </openclaw-tooltip>
              `
            : nothing}
        ${busy || editing
          ? nothing
          : html`
              <openclaw-tooltip .content=${t("chat.queue.removeQueuedMessage")}>
                <button
                  class="chat-queue__remove"
                  type="button"
                  ?disabled=${editing}
                  aria-label=${t("chat.queue.removeQueuedMessage")}
                  @click=${(event: MouseEvent) => {
                    // Chromium retargets click 2 after row removal; detail still owns the gesture.
                    if (event.detail <= 1) {
                      props.onQueueRemove(item.id);
                    }
                  }}
                  @dblclick=${(event: MouseEvent) => event.stopPropagation()}
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
