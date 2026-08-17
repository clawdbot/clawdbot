import { consume } from "@lit/context";
import { html } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../../session-progress-cards.ts";
import type { BoardWidget } from "../types.ts";
import type { PluginBoardWidgetRenderer } from "./index.ts";

function readSessionKeyProp(widget: BoardWidget | undefined): string | undefined {
  const value = widget?.props?.sessionKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

class OpenClawSessionProgressWidget extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardWidget;
  @property({ attribute: false }) sessionKey = "";

  private store?: SessionProgressCardStore;
  private targetSessionKey = "";
  private unsubscribe?: () => void;

  override connectedCallback(): void {
    super.connectedCallback();
    this.syncStore();
  }

  override willUpdate(): void {
    this.syncStore();
  }

  override disconnectedCallback(): void {
    this.releaseStore();
    super.disconnectedCallback();
  }

  override render() {
    const card = this.store?.get(this.targetSessionKey);
    if (card === undefined) {
      return html`<p class="board-widget__plugin-loading">
        ${t("sessionProgressCard.widgetLoading")}
      </p>`;
    }
    if (card === null) {
      return html`<p class="board-widget__plugin-loading">
        ${t("sessionProgressCard.widgetEmpty")}
      </p>`;
    }
    return renderSessionProgressCard(card, "board");
  }

  private syncStore(): void {
    const targetSessionKey = readSessionKeyProp(this.widget) ?? this.sessionKey.trim();
    const store = this.context ? sessionProgressCardsForGateway(this.context.gateway) : undefined;
    if (store === this.store && targetSessionKey === this.targetSessionKey) {
      return;
    }
    this.releaseStore();
    this.store = store;
    this.targetSessionKey = targetSessionKey;
    if (store && targetSessionKey) {
      store.watch(this, [targetSessionKey]);
      this.unsubscribe = store.subscribe(() => this.requestUpdate());
    }
  }

  private releaseStore(): void {
    this.store?.unwatch(this);
    this.unsubscribe?.();
    this.store = undefined;
    this.unsubscribe = undefined;
  }
}

if (!customElements.get("openclaw-session-progress-widget")) {
  customElements.define("openclaw-session-progress-widget", OpenClawSessionProgressWidget);
}

export const renderSessionProgressWidget: PluginBoardWidgetRenderer = ({
  widget,
  sessionKey,
}) => html`
  <openclaw-session-progress-widget
    .widget=${widget}
    .sessionKey=${sessionKey}
  ></openclaw-session-progress-widget>
`;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-progress-widget": OpenClawSessionProgressWidget;
  }
}
