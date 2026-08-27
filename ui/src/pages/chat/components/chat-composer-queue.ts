import { html, nothing, svg } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  chatQueueMovableSegments,
  isMovableChatQueueItem,
} from "../../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { isQueuedSendInlineState } from "../chat-progress.ts";
import { isSteerableQueuedMessage } from "../chat-queue.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";

type ChatQueueProps = {
  queue: ChatQueueItem[];
  offline?: boolean;
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
const KEYBOARD_EDIT_FOCUS_ATTRIBUTE = "data-edit-keyboard-focus";
const QUEUE_ROW_CONTROL_SELECTOR =
  "a, button, input, select, textarea, wa-dropdown, wa-dropdown-item";
const QUEUE_DRAG_SCROLL_EDGE = 24;
const QUEUE_DRAG_SCROLL_MAX_SPEED = 12;
const mountedQueueEditInputs = new WeakSet<HTMLTextAreaElement>();
const queueWaitingIcon = strokeIcon(svg` <path d="M16 5H3" />
  <path d="M16 12H3" />
  <path d="M9 19H3" />
  <path d="m16 16-3 3 3 3" />
  <path d="M21 5v12a2 2 0 0 1-2 2h-6" />`);

let queueDragScroll: { container: HTMLElement; velocity: number; frame: number | null } | undefined;
const queueDoubleClickEditRows = new WeakSet<Element>();

function stopQueueDragAutoScroll(): void {
  if (queueDragScroll?.frame != null) {
    cancelAnimationFrame(queueDragScroll.frame);
  }
  queueDragScroll = undefined;
}

function runQueueDragAutoScroll(): void {
  const active = queueDragScroll;
  if (!active || active.velocity === 0) {
    return;
  }
  const previous = active.container.scrollTop;
  active.container.scrollTop += active.velocity;
  if (active.container.scrollTop === previous) {
    stopQueueDragAutoScroll();
    return;
  }
  active.frame = requestAnimationFrame(runQueueDragAutoScroll);
}

function updateQueueDragAutoScroll(container: HTMLElement, pointerY: number): void {
  const bounds = container.getBoundingClientRect();
  const topProximity = Math.min(
    QUEUE_DRAG_SCROLL_EDGE,
    Math.max(0, QUEUE_DRAG_SCROLL_EDGE - (pointerY - bounds.top)),
  );
  const bottomProximity = Math.min(
    QUEUE_DRAG_SCROLL_EDGE,
    Math.max(0, QUEUE_DRAG_SCROLL_EDGE - (bounds.bottom - pointerY)),
  );
  const proximity = bottomProximity > 0 ? bottomProximity : -topProximity;
  const velocity = (proximity / QUEUE_DRAG_SCROLL_EDGE) * QUEUE_DRAG_SCROLL_MAX_SPEED;
  if (velocity === 0) {
    stopQueueDragAutoScroll();
    return;
  }
  if (queueDragScroll?.container === container) {
    queueDragScroll.velocity = velocity;
    if (queueDragScroll.frame == null) {
      queueDragScroll.frame = requestAnimationFrame(runQueueDragAutoScroll);
    }
    return;
  }
  stopQueueDragAutoScroll();
  queueDragScroll = {
    container,
    velocity,
    frame: requestAnimationFrame(runQueueDragAutoScroll),
  };
}

function markQueueEditFocus(row: Element | null, keyboard: boolean): void {
  row?.toggleAttribute(KEYBOARD_EDIT_FOCUS_ATTRIBUTE, keyboard);
}

function fitQueueEditInput(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight) || 101;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function mountQueueEditInput(element: Element | undefined, value: string): void {
  // Seed each mounted editor once so rerenders cannot overwrite user input or selection.
  if (element instanceof HTMLTextAreaElement && !mountedQueueEditInputs.has(element)) {
    mountedQueueEditInputs.add(element);
    element.value = value;
    queueMicrotask(() => {
      if (element.isConnected) {
        fitQueueEditInput(element);
        element.focus();
        element.setSelectionRange(value.length, value.length);
      }
    });
  }
}

function sendStateLabel(item: ChatQueueItem, offline: boolean): string | null {
  if (offline && item.sendState !== "failed" && item.sendState !== "unconfirmed") {
    return t("chat.queue.states.waitingForReconnect");
  }
  switch (item.sendState) {
    case "waiting-model":
    case "waiting-idle":
      return null;
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
  const visibleQueue = props.queue.filter(
    (item) => item.sendState !== "sending" && !isQueuedSendInlineState(item),
  );
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
  // Applying settings belongs to the queue as a whole. Connection loss is the
  // exceptional per-item delivery state operators need to see on every row.
  const globalState =
    visibleQueue.some((item) => item.sendState === "waiting-model") && !props.offline
      ? { label: t("chat.queue.states.applyingSettings"), tone: "settings" }
      : null;
  // Keyed rows so a reorder moves the existing DOM node instead of rewriting
  // it in place; that is what keeps focus on the handle the operator is using.
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      ${globalState
        ? html`<div
            class="chat-queue__global-state"
            data-chat-queue-global-state=${globalState.tone}
          >
            ${globalState.label}
          </div>`
        : nothing}
      <div
        class="chat-queue__scroll"
        data-scrollable=${visibleQueue.length > 3 ? "true" : "false"}
        data-at-start="true"
        data-at-end=${visibleQueue.length > 3 ? "false" : "true"}
        @dragover=${(event: DragEvent) => {
          if (!event.dataTransfer?.types.includes(DRAG_MIME)) {
            return;
          }
          const container = event.currentTarget;
          if (container instanceof HTMLElement) {
            updateQueueDragAutoScroll(container, event.clientY);
          }
        }}
        @dragleave=${(event: DragEvent) => {
          const container = event.currentTarget;
          if (
            container instanceof HTMLElement &&
            event.relatedTarget instanceof Node &&
            container.contains(event.relatedTarget)
          ) {
            return;
          }
          stopQueueDragAutoScroll();
        }}
        @drop=${stopQueueDragAutoScroll}
        @scroll=${(event: Event) => {
          const scroll = event.currentTarget;
          if (scroll instanceof HTMLElement) {
            scroll.dataset.atStart = String(scroll.scrollTop <= 1);
            scroll.dataset.atEnd = String(
              scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1,
            );
          }
        }}
      >
        ${repeat(
          visibleQueue,
          (item) => item.id,
          (item) => renderChatQueueItem(item, props, reorder),
        )}
      </div>
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
  const authorAvatar = renderChatAuthorAvatar(item.sender);
  const hasAuthorAvatar = authorAvatar !== nothing;
  const failed = item.sendState === "failed" || item.sendState === "unconfirmed";
  const reconnecting = !failed && (props.offline || item.sendState === "waiting-reconnect");
  const stateLabel = sendStateLabel(item, props.offline === true);
  const steered = item.queueMode === "steer" && !failed;
  const busy = item.sendState === "executing-command";
  const editing = props.editingId === item.id;
  const canSteer =
    Boolean(props.canAbort && props.onQueueSteer) && isSteerableQueuedMessage(item) && !editing;
  const showsSteer =
    Boolean(props.canAbort && props.onQueueSteer) &&
    !editing &&
    !item.localCommandName &&
    (isSteerableQueuedMessage(item) || item.sendState === "waiting-model");
  const segment = reorder.segments.find((ids) => ids.includes(item.id)) ?? [];
  const moveIndex = segment.indexOf(item.id);
  const move = props.onQueueMove;
  // Queue-level: once any row can move, every row's own state icon becomes the
  // handle so text stays on one x without adding a second grabber column.
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
  // The leading glyph identifies the object, not its transient delivery state.
  // Row tone, badges, and actions carry failure, review, reconnect, and steer.
  const leadingIcon = queueWaitingIcon;
  const itemClass = `chat-queue__item${hasAuthorAvatar ? "" : " chat-queue__item--no-avatar"}${steered ? " chat-queue__item--steered" : ""}${
    failed ? " chat-queue__item--failed" : ""
  }${reconnecting ? " chat-queue__item--reconnect" : ""}${
    editing ? " chat-queue__item--editing" : ""
  }`;
  // The error occupies the grid's final columns below the primary row, so a
  // diagnostic grows the attached tray without disturbing its action rail.
  return html`
    <div
      class=${itemClass}
      data-chat-queue-item=${item.id}
      @click=${(event: MouseEvent) => {
        const row = event.currentTarget;
        const target = event.target;
        if (!(row instanceof Element) || !(target instanceof Element)) {
          return;
        }
        if (!canEdit || target.closest(QUEUE_ROW_CONTROL_SELECTOR)) {
          queueDoubleClickEditRows.delete(row);
        } else if (event.detail === 1) {
          queueDoubleClickEditRows.add(row);
        }
      }}
      @dblclick=${canEdit
        ? (event: MouseEvent) => {
            const row = event.currentTarget;
            if (!(row instanceof Element) || !queueDoubleClickEditRows.has(row)) {
              return;
            }
            queueDoubleClickEditRows.delete(row);
            event.stopPropagation();
            markQueueEditFocus(row, false);
            props.onQueueEdit?.(item.id);
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
      ${showsHandle
        ? html`<button
            class="chat-queue__leading chat-queue__grip"
            type="button"
            draggable=${canMove ? "true" : "false"}
            ?disabled=${!canMove}
            aria-label=${canMove
              ? t("chat.queue.reorderQueuedMessage")
              : t("chat.queue.reorderUnavailable")}
            aria-keyshortcuts=${ifDefined(canMove ? "ArrowUp ArrowDown" : undefined)}
            @dragstart=${canMove
              ? (event: DragEvent) => {
                  event.dataTransfer?.setData(DRAG_MIME, item.id);
                  if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = "move";
                  }
                }
              : undefined}
            @dragend=${stopQueueDragAutoScroll}
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
            <span class="chat-queue__grip-state chat-queue__grip-state--idle" aria-hidden="true"
              >${leadingIcon}</span
            >
            ${canMove
              ? html`<span
                  class="chat-queue__grip-state chat-queue__grip-state--active"
                  aria-hidden="true"
                  >${icons.gripVertical}</span
                >`
              : nothing}
          </button>`
        : html`<span class="chat-queue__leading chat-queue__icon" aria-hidden="true"
            >${leadingIcon}</span
          >`}
      ${authorAvatar}
      ${editing
        ? html`<textarea
            class="chat-queue__edit-input"
            rows="1"
            ${ref((element) => mountQueueEditInput(element, props.editingText ?? item.text))}
            aria-label=${t("chat.queue.editQueuedMessage")}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLTextAreaElement) {
                fitQueueEditInput(event.currentTarget);
                props.onQueueEditChange?.(event.currentTarget.value);
              }
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.isComposing || event.keyCode === 229) {
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onQueueEditCancel?.();
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                props.onQueueEditSubmit?.();
              }
            }}
          ></textarea>`
        : html`<span class="chat-queue__copy">
            <span class="chat-queue__text" title=${text}>${text}</span>
            ${steered
              ? html`<span class="chat-queue__badge chat-queue__badge--steered"
                  >${t("chat.queue.steer")}</span
                >`
              : nothing}
            ${stateLabel && (!failed || !item.sendError)
              ? html`<span
                  class=${failed
                    ? "chat-queue__badge"
                    : reconnecting
                      ? "chat-queue__badge chat-queue__badge--reconnect"
                      : "chat-queue__state"}
                  title=${ifDefined(reconnecting ? item.sendError : undefined)}
                  >${stateLabel}</span
                >`
              : nothing}
          </span>`}
      <span class="chat-queue__actions">
        ${failed && !editing && props.onQueueRetry
          ? html`
              <button
                class="chat-queue__action chat-queue__retry"
                type="button"
                aria-label=${t("chat.queue.retryQueuedMessage")}
                @click=${() => props.onQueueRetry?.(item.id)}
              >
                ${icons.refresh}
                <span>${t("chat.queue.retry")}</span>
              </button>
            `
          : nothing}
        ${showsSteer
          ? html`
              <button
                class="chat-queue__action chat-queue__steer"
                type="button"
                ?disabled=${!canSteer}
                aria-label=${t("chat.queue.steerQueuedMessage")}
                @click=${() => props.onQueueSteer?.(item.id)}
              >
                ${icons.arrowUp}
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
                  ${icons.trash}
                </button>
              </openclaw-tooltip>
            `}
        ${editing || !editable
          ? nothing
          : html`
              <wa-dropdown
                class="chat-queue__overflow"
                placement="top-end"
                @wa-select=${(event: CustomEvent<{ item: Element & { value?: string } }>) => {
                  const selectedItem = event.detail.item;
                  if (selectedItem.value === "edit" && canEdit) {
                    const dropdown = event.currentTarget;
                    const row =
                      dropdown instanceof Element ? dropdown.closest(".chat-queue__item") : null;
                    const keyboard = selectedItem.matches(":focus-visible");
                    markQueueEditFocus(row, keyboard);
                    props.onQueueEdit?.(item.id);
                  }
                }}
              >
                <button
                  slot="trigger"
                  class="chat-queue__more"
                  type="button"
                  ?disabled=${!canEdit}
                  aria-label=${t("chat.queue.moreActions")}
                  @dblclick=${(event: MouseEvent) => event.stopPropagation()}
                >
                  ${icons.moreHorizontal}
                </button>
                <wa-dropdown-item value="edit" ?disabled=${!canEdit}>
                  <span slot="icon" aria-hidden="true">${icons.pencil}</span>
                  ${t("chat.queue.editQueuedMessage")}
                </wa-dropdown-item>
              </wa-dropdown>
            `}
      </span>
      ${
        // Reconnect rows auto-retry, so the raw transport error is noise there;
        // it stays inspectable via the badge tooltip. Failed/unconfirmed rows
        // keep the visible error because the user must act on them.
        item.sendError && !reconnecting
          ? html`<span class="chat-queue__error">
              ${failed && stateLabel
                ? html`<span class="chat-queue__badge">${stateLabel}</span>`
                : nothing}
              <span class="chat-queue__error-text">${item.sendError}</span>
            </span>`
          : nothing
      }
    </div>
  `;
}
