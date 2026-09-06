import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { t } from "../../../i18n/index.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
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
    transcript,
    requestUpdate,
  }: {
    messages: readonly unknown[];
    transcript: ChatTranscriptSession;
    requestUpdate: () => void;
  }) {
    this.requestUpdate = requestUpdate;
    if (this.session !== transcript) {
      this.session = transcript;
      this.interaction = initialInteraction();
    }
    const candidates = messages.flatMap((message) => {
      const id = persistedMessageEntryId(message);
      return id ? [{ id, message }] : [];
    });
    const count = Math.min(candidates.length, MAX_POSITION_MARKERS);
    if (count < 2) {
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
      Math.round((index * (candidates.length - 1)) / (count - 1)),
    );
    const focusedIndex = candidates.findIndex(
      (candidate) => candidate.id === interaction.focusedId,
    );
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
    // Resolve previews only for the bounded set of visible landmarks.
    const markers = indexes.map((candidateIndex, index) => {
      const candidate = candidates[candidateIndex]!;
      const role = normalizeMessage(candidate.message).role;
      return {
        id: candidate.id,
        label: t(
          role === "user"
            ? "chat.thread.positionUserMessage"
            : "chat.thread.positionAssistantMessage",
        ),
        preview: truncateUtf16Safe(
          resolveMessageReplyText(candidate.message).replace(/\s+/g, " ").trim(),
          PREVIEW_LENGTH,
        ),
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
                  class="chat-position-rail__marker ${marker.id === activeMarker.id ? "chat-position-rail__marker--current" : ""}"
                  style=${styleMap({
                    "--chat-position-marker": marker.position,
                    "--chat-position-proximity-opacity": String(0.18 + 0.72 * proximity),
                    "--chat-position-proximity-width": `${2 + Math.round(12 * proximity)}px`,
                  })}
                  type="button"
                  data-position-marker-id=${marker.id}
                  tabindex=${marker.id === rovingMarker.id ? "0" : "-1"}
                  aria-label=${t("chat.thread.positionMarker", { position: String(index + 1), count: String(count), label: marker.label })}
                  aria-description=${`${marker.preview}. ${t("chat.thread.positionMarkerHint")}`}
                  aria-current=${marker.id === activeMarker.id ? "true" : "false"}
                  @pointerenter=${() => {
                    interaction.hoveredId = marker.id;
                    interaction.dismissed = false;
                    requestUpdate();
                  }}
                  @focus=${() => {
                    interaction.focusedId = marker.id;
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
                    }
                  }}
                  @click=${() => transcript.revealMessage(marker.id)}
                >
                  <span class="chat-position-rail__dot" aria-hidden="true"></span>
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
