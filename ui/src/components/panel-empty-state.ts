import { css, html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

class OpenClawPanelEmptyState extends OpenClawLitElement {
  @property() heading = "";
  @property() description = "";

  override render() {
    return html`<div class="empty-state" role="status">
      <div class="empty-state__icon" aria-hidden="true"><slot></slot></div>
      <strong class="empty-state__title">${this.heading}</strong>
      <p class="empty-state__description">${this.description}</p>
      <slot name="action"></slot>
    </div>`;
  }

  static override styles = css`
    :host {
      display: flex;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      flex: 1 1 auto;
    }

    .empty-state {
      display: flex;
      box-sizing: border-box;
      width: 100%;
      min-height: 0;
      flex: 1 1 auto;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      color: var(--muted);
      text-align: center;
      transform: translateY(-10px);
    }

    .empty-state__icon {
      display: inline-flex;
      width: 32px;
      height: 32px;
      align-items: center;
      justify-content: center;
      margin-bottom: 18px;
      color: var(--muted);
    }

    ::slotted(svg) {
      width: 32px;
      height: 32px;
      stroke-width: 1.5px;
    }

    .empty-state__title {
      color: var(--text);
      font-size: calc(16px * var(--control-ui-text-scale, 1));
      font-weight: 500;
      line-height: 1.25;
    }

    .empty-state__description {
      max-width: 320px;
      margin: 8px 0 0;
      color: var(--muted);
      font-size: calc(13px * var(--control-ui-text-scale, 1));
      line-height: 1.45;
    }

    ::slotted([slot="action"]) {
      margin-top: 16px;
    }
  `;
}

if (!customElements.get("openclaw-panel-empty-state")) {
  customElements.define("openclaw-panel-empty-state", OpenClawPanelEmptyState);
}

export function renderPanelEmptyState(params: {
  icon: TemplateResult;
  heading: string;
  description: string;
  action?: TemplateResult | typeof nothing;
}) {
  return html`<openclaw-panel-empty-state
    .heading=${params.heading}
    .description=${params.description}
  >
    ${params.icon}${params.action != null && params.action !== nothing
      ? html`<span slot="action">${params.action}</span>`
      : nothing}
  </openclaw-panel-empty-state>`;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-panel-empty-state": OpenClawPanelEmptyState;
  }
}
