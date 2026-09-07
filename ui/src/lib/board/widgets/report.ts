import { html, nothing, svg, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { parseBoardReport, type BoardReport } from "../../../../../src/boards/board-report.ts";
import { renderBoardWidgetError } from "../../../components/board/board-widget-cell-render.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import type { BoardWidget } from "../types.ts";
import "./report.css";

type ReportBlock = BoardReport["blocks"][number];

function renderReportChart(block: Extract<ReportBlock, { type: "chart" }>) {
  const values = block.points.map((point) => point.value);
  const minimum = Math.min(0, ...values);
  const span = Math.max(0, ...values) - minimum || 1;
  const y = (value: number) => 164 - ((value - minimum) / span) * 148;
  const baseline = y(0);
  const line = block.style === "line";
  const width = 608 / block.points.length;
  const coordinates = values.map((value, index) => ({
    x: line
      ? values.length === 1
        ? 320
        : 16 + (index / (values.length - 1)) * 608
      : 16 + (index + 0.5) * width,
    y: y(value),
  }));
  return html`<figure class="board-report__chart">
    ${block.title ? html`<figcaption>${block.title}</figcaption>` : nothing}
    ${svg`<svg viewBox="0 0 640 180" aria-hidden="true" focusable="false">
      <line class="board-report__axis" x1="16" x2="624" y1=${baseline} y2=${baseline}></line>
      ${
        line
          ? svg`<polyline class="board-report__line" points=${coordinates.map((point) => `${point.x},${point.y}`).join(" ")}></polyline>
            ${coordinates.map((point) => svg`<circle class="board-report__point" cx=${point.x} cy=${point.y} r="3"></circle>`)}`
          : coordinates.map(
              (point) =>
                svg`<rect class="board-report__bar" x=${point.x - width * 0.35} y=${Math.min(point.y, baseline)} width=${width * 0.7} height=${Math.max(1, Math.abs(point.y - baseline))} rx="2"></rect>`,
            )
      }
    </svg>`}
    <dl class="board-report__values">
      ${block.points.map(
        (point) =>
          html`<div>
            <dt>${point.label}</dt>
            <dd>${point.value}</dd>
          </div>`,
      )}
    </dl>
  </figure>`;
}

function renderReportBlock(block: ReportBlock) {
  switch (block.type) {
    case "text":
      return html`<section>
        ${block.title ? html`<h3>${block.title}</h3>` : nothing}
        <p class="board-report__text">${block.text}</p>
      </section>`;
    case "metrics":
      return html`<dl class="board-report__metrics">
        ${block.items.map(
          (item) =>
            html`<div>
              <dt>${item.label}</dt>
              <dd>${item.value}</dd>
              ${item.detail ? html`<dd class="board-report__metric-detail">${item.detail}</dd>` : nothing}
            </div>`,
        )}
      </dl>`;
    case "table":
      return html`<div class="board-report__table">
        <table>
          ${
            block.title
              ? html`<caption>
                  ${block.title}
                </caption>`
              : nothing
          }
          <thead>
            <tr>
              ${block.columns.map((column) => html`<th scope="col">${column}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${block.rows.map(
              (row) =>
                html`<tr>
                  ${row.map((cell) => html`<td>${cell}</td>`)}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`;
    case "chart":
      return renderReportChart(block);
    case "links":
      return html`<section>
        ${block.title ? html`<h3>${block.title}</h3>` : nothing}
        <ul class="board-report__links">
          ${block.items.map(
            (item) => html`<li>
              <a href=${item.url} target="_blank" rel="noopener noreferrer">${item.label}</a>
              ${item.detail ? html`<span>${item.detail}</span>` : nothing}
            </li>`,
          )}
        </ul>
      </section>`;
  }
  return block satisfies never;
}

class OpenClawReportWidget extends OpenClawLightDomElement {
  @property({ attribute: false }) widget?: BoardWidget;
  private content: { report: BoardReport } | { error: unknown } | undefined;

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("widget")) {
      try {
        this.content = { report: parseBoardReport(this.widget?.props) };
      } catch (error) {
        this.content = { error };
      }
    }
  }

  override render() {
    const content = this.content;
    if (!content) {
      return nothing;
    }
    return "error" in content
      ? renderBoardWidgetError(content.error)
      : html`<article
          class="board-report"
          aria-label=${this.widget?.title ?? t("board.widget.kindReport")}
        >
          ${content.report.blocks.map(renderReportBlock)}
        </article>`;
  }
}

if (!customElements.get("openclaw-report-widget")) {
  customElements.define("openclaw-report-widget", OpenClawReportWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-report-widget": OpenClawReportWidget;
  }
}
