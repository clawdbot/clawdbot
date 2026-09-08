import { consume } from "@lit/context";
import type { BoardGetParams, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { SessionProgressCardController } from "../../../components/session-progress-card-controller.ts";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import { resolveSessionProgressCardTarget } from "../../session-progress-cards.ts";
import { isSessionRunActive } from "../../session-run-state.ts";
import { parseAgentSessionKey } from "../../sessions/session-key.ts";
import { sessionProgressTargetQuery } from "../../sessions/session-requests.ts";
import type { BoardWidget } from "../types.ts";

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

  private observedSessions?: ApplicationContext["sessions"];
  private observedScopeId?: string | null;
  private unsubscribeList?: () => void;

  private readonly progressCard = new SessionProgressCardController(this, {
    gateway: () =>
      this.active && resolveSessionTarget(this.widget, this.session).sessionKey
        ? this.context?.gateway
        : undefined,
    target: () => resolveSessionTarget(this.widget, this.session),
  });

  constructor() {
    super();
    void new SubscriptionsController(this).effect(
      () => this.context?.agentSelection,
      (agentSelection) => {
        this.bindSessionList();
        return agentSelection.subscribe(() => this.bindSessionList());
      },
    );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.bindSessionList();
  }

  override disconnectedCallback(): void {
    this.releaseSessionList();
    super.disconnectedCallback();
  }

  override willUpdate(): void {
    this.bindSessionList();
  }

  override render() {
    const loadError = this.progressCard.error;
    const card = this.progressCard.card;
    const errorNotice = loadError
      ? html`<div
          class=${card ? "callout info" : "board-widget__plugin-loading"}
          data-test-id="session-progress-error"
          role="alert"
        >
          <span
            >${t(
              loadError === "access-denied"
                ? "sessionProgressCard.widgetAccessDenied"
                : "sessionProgressCard.widgetUnavailable",
            )}</span
          >
          ${
            loadError === "unavailable"
              ? html`<button class="btn btn--sm" type="button" @click=${this.progressCard.retry}>
                  ${t("common.retry")}
                </button>`
              : null
          }
        </div>`
      : nothing;
    if (loadError && !card) {
      return errorNotice;
    }
    if (this.progressCard.loading) {
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
      resolveSessionTarget(this.widget, this.session),
    );
    const scopeId = this.context?.agentSelection.state.scopeId ?? null;
    const row = this.context?.sessions
      .listSnapshot(sessionProgressTargetQuery(scopeId))
      .result?.sessions.find(
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
      isSessionRunActive(row ?? {}),
    )}`;
  }

  private bindSessionList(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const sessions = context.sessions;
    const scopeId = context.agentSelection.state.scopeId?.trim() || null;
    const shouldObserve =
      this.active && Boolean(resolveSessionTarget(this.widget, this.session).sessionKey);
    if (!shouldObserve) {
      this.releaseSessionList();
      return;
    }
    if (sessions === this.observedSessions && scopeId === this.observedScopeId) {
      return;
    }
    this.releaseSessionList();
    this.observedSessions = sessions;
    this.observedScopeId = scopeId;
    const query = sessionProgressTargetQuery(scopeId);
    this.unsubscribeList = sessions.subscribeList(query, () => this.requestUpdate());
    const snapshot = sessions.listSnapshot(query);
    this.requestUpdate();
    if (
      !snapshot.result &&
      !snapshot.loading &&
      !snapshot.error &&
      context.gateway.snapshot.phase === "connected"
    ) {
      void sessions.refreshList({ ...query, force: true });
    }
  }

  private releaseSessionList(): void {
    this.unsubscribeList?.();
    this.unsubscribeList = undefined;
    this.observedSessions = undefined;
    this.observedScopeId = undefined;
  }
}

if (!customElements.get("openclaw-session-progress-widget")) {
  customElements.define("openclaw-session-progress-widget", OpenClawSessionProgressWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-progress-widget": OpenClawSessionProgressWidget;
  }
}
