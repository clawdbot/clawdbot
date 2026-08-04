import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { workboardBoardColor, workboardBoardGlyph } from "../lib/workboard/board-presentation.ts";
import type { WorkboardBoardSummary } from "../lib/workboard/index.ts";

export function renderWorkboardBoardGlyph(
  board: Pick<WorkboardBoardSummary, "id" | "name" | "icon" | "color">,
  className = "",
) {
  return html`
    <span
      class="workboard-board-glyph ${className}"
      style=${styleMap({ "--workboard-board-color": workboardBoardColor(board) })}
      aria-hidden="true"
      >${workboardBoardGlyph(board)}</span
    >
  `;
}
