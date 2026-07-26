import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import type { WorkboardStatus } from "../../workboard/types.ts";
import type { BoardViewWidget } from "../view-types.ts";
import type { PluginBoardWidgetRenderer } from "./index.ts";
import { WorkboardWidgetElement } from "./workboard-widget.ts";

class OpenClawWorkboardCardWidget extends WorkboardWidgetElement {
  private async handleStatusChange(event: Event): Promise<void> {
    const cardId = this.readStringProp("cardId");
    const card = this.cards.find((candidate) => candidate.id === cardId);
    const status = (event.currentTarget as HTMLSelectElement).value;
    if (!card || !this.statuses.includes(status as WorkboardStatus)) {
      return;
    }
    await this.moveCard(card, status as WorkboardStatus);
  }

  override render(): TemplateResult {
    const cardId = this.readStringProp("cardId");
    if (!cardId) {
      return html`<p class="workboard-widget__state" role="alert">
        ${t("workboard.widget.cardIdRequired")}
      </p>`;
    }
    if (this.loading && !this.loaded) {
      return html`<p class="workboard-widget__state">${t("workboard.widget.loading")}</p>`;
    }
    if (this.error) {
      return html`<div class="workboard-widget__state" role="alert">
        <span>${this.error}</span>
        <button class="btn btn--sm" type="button" @click=${() => this.retryLoad()}>
          ${t("common.retry")}
        </button>
      </div>`;
    }
    const card = this.cards.find((candidate) => candidate.id === cardId);
    if (!card) {
      return html`<p class="workboard-widget__state">${t("workboard.widget.cardMissing")}</p>`;
    }
    const statuses = this.statuses.includes(card.status)
      ? this.statuses
      : [card.status, ...this.statuses];
    const priority = card.priority.charAt(0).toUpperCase() + card.priority.slice(1);
    return html`
      <article class="workboard-widget-card" data-test-id="workboard-card-widget">
        <div class="workboard-widget-card__heading">
          <strong>${card.title}</strong>
          <span class=${`workboard-widget__status workboard-widget__status--${card.status}`}>
            ${t(`workboard.status.${card.status}`)}
          </span>
        </div>
        <dl class="workboard-widget-card__meta">
          <div>
            <dt>${t("workboard.fieldPriority")}</dt>
            <dd>${priority}</dd>
          </div>
          <div>
            <dt>${t("workboard.fieldAgent")}</dt>
            <dd>${card.agentId ?? t("workboard.widget.unassigned")}</dd>
          </div>
        </dl>
        ${statuses.length > 1
          ? html`
              <label class="workboard-widget-card__move">
                <span>${t("workboard.fieldStatus")}</span>
                <select
                  aria-label=${`${t("workboard.fieldStatus")}: ${card.title}`}
                  .value=${card.status}
                  @change=${(event: Event) => void this.handleStatusChange(event)}
                >
                  ${statuses.map(
                    (status) => html`
                      <option value=${status} ?selected=${status === card.status}>
                        ${t(`workboard.status.${status}`)}
                      </option>
                    `,
                  )}
                </select>
              </label>
            `
          : nothing}
      </article>
    `;
  }
}

if (!customElements.get("openclaw-workboard-card-widget")) {
  customElements.define("openclaw-workboard-card-widget", OpenClawWorkboardCardWidget);
}

export const renderWorkboardCardWidget: PluginBoardWidgetRenderer = ({
  widget,
  sessionKey,
  requestUpdate,
}: {
  widget: BoardViewWidget;
  sessionKey: string;
  requestUpdate: () => void;
}) => html`
  <openclaw-workboard-card-widget
    .widget=${widget}
    .sessionKey=${sessionKey}
    .hostRequestUpdate=${requestUpdate}
  ></openclaw-workboard-card-widget>
`;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-workboard-card-widget": OpenClawWorkboardCardWidget;
  }
}
