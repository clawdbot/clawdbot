import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { pairSessionDiffLines } from "../../../lib/chat/session-diff-split.ts";
import type { DiffFilePaths, DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { renderHighlightedDiff } from "./chat-diff-highlight.ts";

function renderSplitSide(
  line: DiffLine | undefined,
  side: "left" | "right",
  renderLine: (line: DiffLine) => unknown,
) {
  const sign = side === "left" ? "-" : "+";
  // Tint only sides that carry a line; a lone add/del keeps its counterpart neutral.
  return html`<div
    class="session-diff-split__side session-diff-split__side--${side} ${line
      ? "session-diff-split__side--filled"
      : ""}"
  >
    <span class="session-diff-split__gutter">${line?.lineNo ?? ""}</span>
    <span class="session-diff-split__sign">${line ? sign : ""}</span>
    <span class="session-diff-split__text">${line ? renderLine(line) : ""}</span>
  </div>`;
}

export function renderSessionSplitDiff(
  lines: readonly DiffLine[],
  renderSkip?: (line: DiffLine) => unknown,
  file: DiffFilePaths = { path: "" },
) {
  const rows = pairSessionDiffLines(lines);
  return renderHighlightedDiff(
    lines,
    file,
    (renderLine) => html`<div
      class="session-diff-split code-highlight"
      role="figure"
      aria-label=${t("chat.toolCards.fileChanges")}
    >
      ${rows.map((row) => {
        if (row.kind === "pair") {
          return html`<div class="session-diff-split__row session-diff-split__row--pair">
            ${renderSplitSide(row.left, "left", renderLine)}
            ${renderSplitSide(row.right, "right", renderLine)}
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
          <span class="session-diff-split__text">${renderLine(row.line)}</span>
        </div>`;
      })}
    </div>`,
  );
}
