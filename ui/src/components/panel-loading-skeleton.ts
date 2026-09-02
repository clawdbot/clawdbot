import { html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "../styles/panel-loading-skeleton.css";

export type PanelLoadingSkeletonVariant =
  | "browser"
  | "chat"
  | "desktop"
  | "discussion"
  | "files"
  | "review"
  | "tasks"
  | "terminal";

class PanelLoadingSkeleton extends OpenClawLightDomElement {
  @property({ reflect: true, attribute: "data-panel-skeleton" })
  variant: PanelLoadingSkeletonVariant = "files";

  @property({ type: Boolean, reflect: true }) compact = false;

  @property({ type: Boolean, reflect: true }) overlay = false;

  private line(width: "short" | "medium" | "long" = "long") {
    return html`<div class="skeleton panel-skeleton__line panel-skeleton__line--${width}"></div>`;
  }

  private rows(count: number) {
    return Array.from(
      { length: count },
      (_, index) => html`
        <div class="panel-skeleton__row">
          <div class="skeleton panel-skeleton__icon"></div>
          <div class="panel-skeleton__copy">
            ${this.line(index % 2 === 0 ? "long" : "medium")}
            <div class="skeleton panel-skeleton__meta"></div>
          </div>
        </div>
      `,
    );
  }

  private renderContent() {
    switch (this.variant) {
      case "browser":
        return html`
          <div class="panel-skeleton__toolbar">
            <div class="skeleton panel-skeleton__button"></div>
            <div class="skeleton panel-skeleton__button"></div>
            <div class="skeleton panel-skeleton__address"></div>
          </div>
          <div class="skeleton panel-skeleton__viewport"></div>
        `;
      case "chat":
        return html`
          <div class="panel-skeleton__conversation">
            <div class="panel-skeleton__bubble">
              <div class="panel-skeleton__copy">${this.line()}${this.line("medium")}</div>
            </div>
            <div class="panel-skeleton__bubble panel-skeleton__bubble--user">
              <div class="panel-skeleton__copy">${this.line("medium")}</div>
            </div>
            <div class="panel-skeleton__bubble">
              <div class="panel-skeleton__copy">${this.line()}${this.line("short")}</div>
            </div>
          </div>
        `;
      case "desktop":
        return html`
          <div class="panel-skeleton__toolbar">${this.line("medium")}</div>
          <div class="panel-skeleton__rows">
            ${this.rows(3).map((row) => html`<div class="panel-skeleton__card">${row}</div>`)}
          </div>
        `;
      case "discussion":
        return html`
          <div class="panel-skeleton__discussion-frame">
            <div class="panel-skeleton__conversation">
              ${this.line("medium")} ${this.line()} ${this.line("long")} ${this.line("short")}
            </div>
          </div>
        `;
      case "review":
        return html`
          <div class="panel-skeleton__summary">
            <div class="skeleton panel-skeleton__pill"></div>
            <div class="skeleton panel-skeleton__pill"></div>
          </div>
          <div class="skeleton panel-skeleton__file-heading"></div>
          <div class="panel-skeleton__code">
            ${this.line()} ${this.line("long")} ${this.line("medium")} ${this.line()}
            ${this.line("short")}
          </div>
        `;
      case "terminal":
        return html`
          <div class="panel-skeleton__toolbar">
            <div class="skeleton panel-skeleton__pill"></div>
            <div class="skeleton panel-skeleton__pill"></div>
          </div>
          <div class="panel-skeleton__terminal">
            ${this.line("medium")} ${this.line()} ${this.line("short")} ${this.line("long")}
          </div>
        `;
      case "tasks":
        return html`
          <div class="panel-skeleton__toolbar">${this.line("short")}</div>
          <div class="panel-skeleton__rows">${this.rows(4)}</div>
        `;
      default:
        return html`
          <div class="panel-skeleton__toolbar">
            <div class="skeleton panel-skeleton__address"></div>
            <div class="skeleton panel-skeleton__button"></div>
          </div>
          <div class="panel-skeleton__rows">${this.rows(5)}</div>
        `;
    }
  }

  override render() {
    return html`${this.renderContent()}`;
  }
}

export function renderPanelLoadingSkeleton(
  variant: PanelLoadingSkeletonVariant,
  label: string,
  compact = false,
  overlay = false,
): TemplateResult {
  return html`
    <openclaw-panel-loading-skeleton
      .variant=${variant}
      ?compact=${compact}
      ?overlay=${overlay}
      role="status"
      aria-busy="true"
      aria-label=${label}
    ></openclaw-panel-loading-skeleton>
  `;
}

if (!customElements.get("openclaw-panel-loading-skeleton")) {
  customElements.define("openclaw-panel-loading-skeleton", PanelLoadingSkeleton);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-panel-loading-skeleton": PanelLoadingSkeleton;
  }
}
