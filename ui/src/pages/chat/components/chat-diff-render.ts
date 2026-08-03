// Leaf diff renderers shared by tool cards and the session diff panel.
// Kept dependency-light (no chat-sidebar/chat-tool-cards imports) so both
// consumers can use them without creating an import cycle.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import type { DiffLine, DiffStat } from "../../../lib/chat/tool-call-diff.ts";

export function renderDiffStatChips(stat: DiffStat) {
  if (stat.added === 0 && stat.removed === 0) {
    return nothing;
  }
  return html`<span class="chat-diffstat">
    ${stat.added > 0 ? html`<span class="chat-diffstat__add">+${stat.added}</span>` : nothing}
    ${stat.removed > 0 ? html`<span class="chat-diffstat__del">-${stat.removed}</span>` : nothing}
  </span>`;
}

export function renderDiffBlock(
  lines: readonly DiffLine[],
  outcome: ToolCardOutcome = "succeeded",
) {
  const hasLineNumbers = lines.some((line) => line.lineNo !== undefined);
  return html`
    <div
      class="chat-diff"
      role="figure"
      aria-label=${t(
        outcome === "succeeded" ? "chat.toolCards.fileChanges" : "chat.toolCards.attemptedChanges",
      )}
    >
      ${lines.map((line) => {
        if (line.kind === "skip") {
          // Skip rows may carry a caller-formatted gap label ("N unmodified
          // lines", session diff panel); tool cards leave text empty.
          return html`<div class="chat-diff__row chat-diff__row--skip">
            ${hasLineNumbers ? html`<span class="chat-diff__gutter"></span>` : nothing}
            <span class="chat-diff__sign"></span>
            <span class="chat-diff__text">${line.text || "⋯"}</span>
          </div>`;
        }
        const kindClass =
          line.kind === "add"
            ? "chat-diff__row--add"
            : line.kind === "del"
              ? "chat-diff__row--del"
              : line.kind === "file"
                ? "chat-diff__row--file"
                : "";
        const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : "";
        return html`<div class="chat-diff__row ${kindClass}">
          ${hasLineNumbers
            ? html`<span class="chat-diff__gutter">${line.lineNo ?? ""}</span>`
            : nothing}
          <span class="chat-diff__sign">${sign}</span>
          <span class="chat-diff__text">${line.text || " "}</span>
        </div>`;
      })}
    </div>
  `;
}
