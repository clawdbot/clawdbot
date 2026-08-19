import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import type { SessionSplitDiffRow } from "../../../lib/chat/session-diff-split.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";

function renderSplitSide(line: DiffLine | undefined, side: "left" | "right") {
  const sign = side === "left" ? "-" : "+";
  // Tint only sides that carry a line; a lone add/del keeps its counterpart neutral.
  return html`<div
    class="session-diff-split__side session-diff-split__side--${side} ${line
      ? "session-diff-split__side--filled"
      : ""}"
  >
    <span class="session-diff-split__gutter">${line?.lineNo ?? ""}</span>
    <span class="session-diff-split__sign">${line ? sign : ""}</span>
    <span class="session-diff-split__text">${line?.text || (line ? " " : "")}</span>
  </div>`;
}

export function renderSessionSplitDiff(
  rows: readonly SessionSplitDiffRow[],
  renderSkip?: (line: DiffLine) => unknown,
) {
  return html`<div
    class="session-diff-split"
    role="figure"
    aria-label=${t("chat.toolCards.fileChanges")}
  >
    ${rows.map((row) => {
      if (row.kind === "pair") {
        return html`<div class="session-diff-split__row session-diff-split__row--pair">
          ${renderSplitSide(row.left, "left")} ${renderSplitSide(row.right, "right")}
        </div>`;
      }
      if (row.line.kind === "skip") {
        return html`<div class="session-diff-split__row session-diff-split__row--skip">
          ${(renderSkip?.(row.line) ?? row.line.text) || "⋯"}
        </div>`;
      }
      return html`<div class="session-diff-split__row session-diff-split__row--context">
        <span class="session-diff-split__gutter">${row.line.lineNo ?? ""}</span>
        <span class="session-diff-split__sign"></span>
        <span class="session-diff-split__text">${row.line.text || " "}</span>
      </div>`;
    })}
  </div>`;
}
