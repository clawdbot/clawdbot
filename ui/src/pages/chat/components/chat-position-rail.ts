import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import type { ChatBookmarkAccess } from "../chat-bookmarks.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { resolveMessageReplyText } from "./chat-message-markdown.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

const MAX_POSITION_MARKERS = 10;
const PREVIEW_LENGTH = 140;
const PROXIMITY_RADIUS = 3;

type RailInteraction = {
  hoveredId: string | null;
  focusedId: string | null;
  rovingId: string | null;
  dismissed: boolean;
};

function initialInteraction(): RailInteraction {
  return { hoveredId: null, focusedId: null, rovingId: null, dismissed: false };
}

// The directive owns transient DOM interaction; the session owns reader position.
class ChatPositionRailDirective extends AsyncDirective {
  private session: ChatTranscriptSession | null = null;
  private interaction = initialInteraction();
  private requestUpdate: (() => void) | undefined;
  private previewElement: Element | undefined;

  private readonly dismissPreview = (event: KeyboardEvent) => {
    const rail = this.previewElement?.closest(".chat-position-rail");
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      this.interaction.dismissed ||
      !rail ||
      rail.ownerDocument.defaultView?.getComputedStyle(rail).display === "none"
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.interaction.hoveredId = null;
    this.interaction.dismissed = true;
    this.requestUpdate?.();
  };

  private readonly bindPreview = (element?: Element) => {
    this.previewElement?.ownerDocument.defaultView?.removeEventListener(
      "keydown",
      this.dismissPreview,
      true,
    );
    this.previewElement = element;
    element?.ownerDocument.defaultView?.addEventListener("keydown", this.dismissPreview, true);
  };

  protected override disconnected() {
    this.bindPreview();
    this.interaction.hoveredId = null;
    this.interaction.focusedId = null;
    this.interaction.dismissed = false;
  }

  protected override reconnected() {
    this.requestUpdate?.();
  }

  render({
    messages,
    sourceMessages = messages,
    bookmarkAccess,
    transcript,
    requestUpdate,
  }: {
    messages: readonly unknown[];
    sourceMessages?: readonly unknown[];
    bookmarkAccess?: ChatBookmarkAccess;
    transcript: ChatTranscriptSession;
    requestUpdate: () => void;
  }) {
    this.requestUpdate = requestUpdate;
    if (this.session !== transcript) {
      this.session = transcript;
      this.interaction = initialInteraction();
    }
    const bookmarkedIds = new Set(bookmarkAccess?.bookmarks.map((item) => item.messageId));
    const landmarkIds = new Set(messages.map(persistedMessageEntryId));
    const sources = bookmarkAccess?.bookmarks.length ? sourceMessages : messages;
    const candidates = sources.flatMap((message) => {
      const id = persistedMessageEntryId(message);
      return id && (landmarkIds.has(id) || bookmarkedIds.has(id)) ? [{ id, message }] : [];
    });
    const candidateIndexes = new Map(candidates.map((candidate, index) => [candidate.id, index]));
    const count = Math.min(candidates.length, MAX_POSITION_MARKERS);
    if (count === 0 || (count < 2 && !bookmarkAccess?.bookmarks.length)) {
      this.disconnected();
      return nothing;
    }
    const interaction = this.interaction;
    if (!candidates.some((candidate) => candidate.id === interaction.focusedId)) {
      interaction.focusedId = null;
    }
    if (!candidates.some((candidate) => candidate.id === interaction.hoveredId)) {
      interaction.hoveredId = null;
    }
    const indexes = Array.from({ length: count }, (_, index) =>
      count === 1 ? 0 : Math.round((index * (candidates.length - 1)) / (count - 1)),
    );
    const focusedIndex = candidateIndexes.get(interaction.focusedId ?? "") ?? -1;
    if (focusedIndex >= 0 && !indexes.includes(focusedIndex)) {
      // Appends/prepends can change the sample. Keep the focused DOM node while
      // retaining both endpoints and the same bounded number of landmarks.
      let replacement = 1;
      for (let index = 2; index < count - 1; index++) {
        if (
          Math.abs(indexes[index]! - focusedIndex) < Math.abs(indexes[replacement]! - focusedIndex)
        ) {
          replacement = index;
        }
      }
      indexes[replacement] = focusedIndex;
      indexes.sort((left, right) => left - right);
    }
    // Keep hit targets disjoint and bounded. Nearby bookmarks share a landmark;
    // its tooltip names the group, and successive activations cycle its sources.
    const bookmarkBuckets: ChatBookmarkAccess["bookmarks"][number][][] = indexes.map(() => []);
    for (const bookmark of bookmarkAccess?.bookmarks ?? []) {
      const candidateIndex = candidateIndexes.get(bookmark.messageId) ?? -1;
      // Older, not-yet-loaded sources share the first landmark and use the
      // same fenced pagination path as the native bookmark dialog.
      let bucket = 0;
      for (let index = 1; index < indexes.length; index++) {
        if (
          Math.abs(indexes[index]! - candidateIndex) < Math.abs(indexes[bucket]! - candidateIndex)
        ) {
          bucket = index;
        }
      }
      bookmarkBuckets[bucket]!.push(bookmark);
    }
    // Resolve previews only for the bounded set of visible landmarks.
    const markers = indexes.map((candidateIndex, index) => {
      const candidate = candidates[candidateIndex]!;
      const role = normalizeMessage(candidate.message).role;
      const bookmarks = bookmarkBuckets[index]!;
      const firstBookmark = bookmarks[0];
      const previewMessage = firstBookmark
        ? candidates[candidateIndexes.get(firstBookmark.messageId) ?? -1]?.message
        : candidate.message;
      // A saved point may share a nearby sample. Never preview that other message.
      // Dense groups keep bounded copy while the library exposes every name.
      const preview =
        bookmarks.length > 1
          ? bookmarks
              .slice(0, 2)
              .map((item) => item.name)
              .join(" · ") + (bookmarks.length > 2 ? " · …" : "")
          : previewMessage === undefined
            ? (firstBookmark?.name ?? "")
            : resolveMessageReplyText(previewMessage);
      return {
        id: candidate.id,
        bookmarks,
        label:
          (bookmarks.length > 1
            ? t("chat.bookmarks.nearby", { count: String(bookmarks.length) })
            : firstBookmark?.name) ||
          t(
            role === "user"
              ? "chat.thread.positionUserMessage"
              : "chat.thread.positionAssistantMessage",
          ),
        preview: truncateUtf16Safe(preview.replace(/\s+/g, " ").trim(), PREVIEW_LENGTH),
        position: `${((index + 0.5) / count) * 100}%`,
      };
    });
    const activeId = transcript.activeMessageId(markers.map((marker) => marker.id));
    const activeMarker = markers.find((marker) => marker.id === activeId) ?? markers.at(-1)!;
    const previewMarker = interaction.dismissed
      ? undefined
      : markers.find((marker) => marker.id === (interaction.hoveredId ?? interaction.focusedId));
    const rovingMarker =
      markers.find((marker) => marker.id === interaction.rovingId) ?? activeMarker;
    const previewIndex = previewMarker ? markers.indexOf(previewMarker) : -1;
    const moveFocus = (event: KeyboardEvent, index: number) => {
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? count - 1
            : Math.max(
                0,
                Math.min(
                  count - 1,
                  index + (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1),
                ),
              );
      event.preventDefault();
      event.stopPropagation();
      // Focus existing buttons synchronously: currentTarget expires after dispatch.
      if (!(event.currentTarget instanceof HTMLButtonElement)) {
        return;
      }
      event.currentTarget
        .closest(".chat-position-rail")
        ?.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker")
        .item(nextIndex)
        ?.focus({ preventScroll: true });
    };
    return html`
      <aside
        class="chat-position-rail"
        ?data-keyboard-focus=${interaction.focusedId !== null}
        aria-label=${t("chat.thread.positionRail")}
        @pointerleave=${() => {
          interaction.hoveredId = null;
          requestUpdate();
        }}
      >
        <div class="chat-position-rail__track">
          ${repeat(
            markers,
            (marker) => marker.id,
            (marker, index) => {
              const proximity =
                previewIndex < 0
                  ? 0
                  : Math.max(0, 1 - Math.abs(index - previewIndex) / PROXIMITY_RADIUS);
              return html`
                <button
                  class="chat-position-rail__marker ${marker.id === activeMarker.id ? "chat-position-rail__marker--current" : ""} ${marker.bookmarks.length ? "chat-position-rail__marker--bookmark" : ""} ${marker.bookmarks.some((item) => item.id === bookmarkAccess?.selectedId) ? "chat-position-rail__marker--selected" : ""}"
                  style=${styleMap({
                    "--chat-position-marker": marker.position,
                    "--chat-position-proximity-opacity": String(0.18 + 0.72 * proximity),
                    "--chat-position-proximity-width": `${2 + Math.round(12 * proximity)}px`,
                  })}
                  type="button"
                  data-position-marker-id=${marker.id}
                  tabindex=${marker.id === rovingMarker.id ? "0" : "-1"}
                  aria-label=${t("chat.thread.positionMarker", { position: String(index + 1), count: String(count), label: marker.label })}
                  aria-description=${marker.bookmarks.length > 1 ? t("chat.bookmarks.collision", { count: String(marker.bookmarks.length) }) : `${marker.preview}. ${t("chat.thread.positionMarkerHint")}`}
                  aria-current=${marker.id === activeMarker.id ? "true" : "false"}
                  @pointerenter=${() => {
                    interaction.hoveredId = marker.id;
                    interaction.dismissed = false;
                    requestUpdate();
                  }}
                  @pointerdown=${() => {
                    // Reusing the keyboard-focused button does not emit another focus event.
                    interaction.focusedId = null;
                    requestUpdate();
                  }}
                  @focus=${(event: FocusEvent) => {
                    interaction.focusedId =
                      event.currentTarget instanceof HTMLButtonElement &&
                      event.currentTarget.matches(":focus-visible")
                        ? marker.id
                        : null;
                    interaction.rovingId = marker.id;
                    interaction.dismissed = false;
                    requestUpdate();
                  }}
                  @blur=${() => {
                    interaction.focusedId = null;
                    requestUpdate();
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    if (
                      ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(
                        event.key,
                      )
                    ) {
                      moveFocus(event, index);
                      interaction.focusedId = interaction.rovingId;
                      interaction.dismissed = false;
                      requestUpdate();
                    }
                  }}
                  @click=${() => {
                    if (marker.bookmarks.length && bookmarkAccess) {
                      const selected = marker.bookmarks.findIndex(
                        (item) => item.id === bookmarkAccess.selectedId,
                      );
                      bookmarkAccess.open(
                        marker.bookmarks[(selected + 1) % marker.bookmarks.length]!,
                      );
                    } else {
                      transcript.revealMessage(marker.id);
                    }
                  }}
                >
                  ${
                    marker.bookmarks.length
                      ? html`<span class="chat-position-rail__bookmark" aria-hidden="true"
                          >${icons.claw}</span
                        >`
                      : html`<span class="chat-position-rail__dot" aria-hidden="true"></span>`
                  }
                  <span class="chat-position-rail__tick" aria-hidden="true"></span>
                </button>
              `;
            },
          )}
          ${
            previewMarker
              ? html`
                  <div
                    ${ref(this.bindPreview)}
                    class="chat-position-rail__preview"
                    aria-hidden="true"
                    style=${styleMap({ "--chat-position-preview": previewMarker.position })}
                  >
                    <span class="chat-position-rail__preview-label">${previewMarker.label}</span>
                    <span class="chat-position-rail__preview-copy">${previewMarker.preview}</span>
                  </div>
                `
              : nothing
          }
        </div>
      </aside>
    `;
  }
}

export const renderChatPositionRail = directive(ChatPositionRailDirective);
