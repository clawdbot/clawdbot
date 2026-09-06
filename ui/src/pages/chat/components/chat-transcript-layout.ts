import type { Virtualizer } from "@tanstack/virtual-core";
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";

export type TranscriptRow<T = unknown> =
  | { kind: "item"; key: string; item: T }
  | { kind: "content"; key: string; content: unknown };

export function renderChatTranscriptLayout<T>({
  rows,
  renderRow,
  virtualizer,
  overlay,
  header,
  scrollElementRef,
  captureInteractionResize,
  measureRowRefFor,
}: {
  rows: readonly TranscriptRow<T>[];
  renderRow: (row: TranscriptRow<T>) => unknown;
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
  overlay: unknown;
  header: unknown;
  scrollElementRef: (element?: Element) => void;
  captureInteractionResize: (event: Event) => void;
  measureRowRefFor: (key: string) => (element?: Element) => void;
}): TemplateResult {
  const virtualRows = virtualizer.getVirtualItems();
  return html`
    <div
      class="chat-thread-inner chat-thread-inner--virtual"
      ${ref(scrollElementRef)}
      @click=${{ handleEvent: captureInteractionResize, capture: true }}
    >
      ${header}
      <div
        class="chat-virtual-sizer"
        style=${styleMap({ height: `${virtualizer.getTotalSize()}px` })}
      >
        ${overlay}
        <div
          class="chat-virtual-block"
          style=${styleMap({
            transform: `translateY(${(virtualRows[0]?.start ?? virtualizer.options.scrollMargin) - virtualizer.options.scrollMargin}px)`,
          })}
        >
          ${repeat(
            virtualRows,
            (virtualRow) => virtualRow.key,
            (virtualRow, renderedIndex) => {
              const row = rows[virtualRow.index];
              if (!row) {
                return nothing;
              }
              const previous = virtualRows[renderedIndex - 1];
              // A focused outlier needs omitted space, not intermediate rows.
              // Sibling spacers keep the flat keyed rows (and iframes) parented.
              const gap =
                previous && virtualRow.index > previous.index + 1
                  ? virtualRow.start - previous.end
                  : 0;
              return html`
                ${
                  gap > 0
                    ? html`<div aria-hidden="true" style=${styleMap({ height: `${gap}px` })}></div>`
                    : nothing
                }
                <div
                  class="chat-virtual-row ${
                    virtualRow.index === 0 ? "chat-virtual-row--first" : ""
                  }"
                  style=${styleMap({
                    // Keep skipped overscan rows at the virtualizer's known size.
                    containIntrinsicBlockSize: `auto ${virtualRow.size}px`,
                  })}
                  data-index=${String(virtualRow.index)}
                  data-virtual-row-key=${row.key}
                  ${ref(measureRowRefFor(row.key))}
                >
                  ${renderRow(row)}
                </div>
              `;
            },
          )}
        </div>
      </div>
    </div>
  `;
}
