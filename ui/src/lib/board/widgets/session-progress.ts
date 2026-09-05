import { consume } from "@lit/context";
import type { BoardGetParams, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  resolveSessionProgressCardTarget,
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../../session-progress-cards.ts";
import { parseAgentSessionKey } from "../../sessions/session-key.ts";
import type { BoardWidget } from "../types.ts";
import type { PluginBoardWidgetRenderer } from "./index.ts";

function resolveSessionTarget(
  widget: BoardWidget | undefined,
  boardSession: BoardGetParams,
): ProgressCardGetParams {
  const value = widget?.props?.sessionKey;
  const key = typeof value === "string" ? value.trim() : "";
  // Unqualified overrides retain the board's captured owner; qualified links name their own.
  return key
    ? { sessionKey: key, agentId: parseAgentSessionKey(key)?.agentId ?? boardSession.agentId }
    : boardSession;
}

class OpenClawSessionProgressWidget extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardWidget;
  @property({ attribute: false }) session: BoardGetParams = { sessionKey: "" };
  @property({ attribute: false }) active = true;

  private store?: SessionProgressCardStore;
  private target: ProgressCardGetParams = { sessionKey: "" };
  private unsubscribe?: () => void;
  private unsubscribeSessions?: () => void;

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
    const loadError = this.store?.getError(this.target);
    const card = this.store?.get(this.target);
    const errorNotice = loadError
      ? html`<div
          class="board-widget__plugin-loading"
          data-test-id="session-progress-error"
          role="alert"
        >
          <span
            >${t(
              loadError === "access-denied"
                ? "sessionProgressCard.widgetAccessDenied"
                : loadError === "unsupported-owner"
                  ? "sessionProgressCard.ownerUnsupported"
                  : "sessionProgressCard.widgetUnavailable",
            )}</span
          >
          ${
            loadError === "unavailable"
              ? html`<button class="btn btn--sm" type="button" @click=${this.retryLoad}>
                  ${t("common.retry")}
                </button>`
              : null
          }
        </div>`
      : nothing;
    if (loadError && (loadError !== "unsupported-owner" || !card)) {
      return errorNotice;
    }
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
    const identity = resolveSessionProgressCardTarget(
      this.context?.gateway.snapshot ?? {},
      this.target,
    );
    const row = this.context?.sessions?.state.result?.sessions.find(
      (entry) =>
        entry.key === identity.sessionKey &&
        (entry.agentId ?? parseAgentSessionKey(entry.key)?.agentId) === identity.agentId,
    );
    return html`${errorNotice}${renderSessionProgressCard(
      card,
      "board",
      undefined,
      row?.status,
      row?.startedAt,
      row?.endedAt,
    )}`;
  }

  private syncStore(): void {
    const target = resolveSessionTarget(this.widget, this.session);
    const store =
      this.active && this.context
        ? sessionProgressCardsForGateway(this.context.gateway)
        : undefined;
    if (
      store === this.store &&
      target.sessionKey === this.target.sessionKey &&
      target.agentId === this.target.agentId
    ) {
      return;
    }
    this.releaseStore();
    this.store = store;
    this.target = target;
    if (store && target.sessionKey) {
      store.watch(this, [target]);
      this.unsubscribe = store.subscribe(() => this.requestUpdate());
      this.unsubscribeSessions = this.context?.sessions?.subscribe(() => this.requestUpdate());
    }
  }

  private readonly retryLoad = () => {
    if (!this.store || !this.target.sessionKey) {
      return;
    }
    void this.store.load(this.target).catch(() => undefined);
  };

  private releaseStore(): void {
    this.store?.unwatch(this);
    this.unsubscribe?.();
    this.unsubscribeSessions?.();
    this.store = undefined;
    this.unsubscribe = undefined;
    this.unsubscribeSessions = undefined;
  }
}

if (!customElements.get("openclaw-session-progress-widget")) {
  customElements.define("openclaw-session-progress-widget", OpenClawSessionProgressWidget);
}

export const renderSessionProgressWidget: PluginBoardWidgetRenderer = ({
  widget,
  session,
  active,
}) => html`
  <openclaw-session-progress-widget
    .widget=${widget}
    .session=${session}
    .active=${active}
  ></openclaw-session-progress-widget>
`;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-progress-widget": OpenClawSessionProgressWidget;
  }
}
