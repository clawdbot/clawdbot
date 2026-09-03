import { consume } from "@lit/context";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { controlUiPublicAssetPath } from "../../app/public-assets.ts";
import { icons } from "../../components/icons.ts";
import { markdownBlocks } from "../../components/markdown-blocks.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { handleMarkdownTableInteraction } from "../../components/markdown-tables.ts";
import { renderPanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import "../../components/openclaw-mascot.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/chat/grouped.css";
import "../../styles/chat/layout.css";
import "../../styles/chat/message-layout.css";
import "../../styles/chat/composer.css";
import "../../styles/chat/text.css";
import "../../styles/custodian.css";
import { renderCustodianAlertCard } from "./custodian-alert-card.ts";
import { custodianAlertStore } from "./custodian-alert-store.ts";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import * as eventNudgeState from "./event-nudge.ts";
import { sessionVariant } from "./session-lifecycle.ts";
import { renderCustodianTranscriptEntry } from "./transcript.ts";

class CustodianSurface extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) store: CustodianSessionStore = custodianSessionStore;
  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) newAgentIntent = false;
  @property({ attribute: false }) showChannelOnboardingNudge = false;
  @property({ attribute: false }) channelOnboardingError: string | null = null;
  @property({ attribute: false }) channelOnboardingRetrying = false;
  @property({ attribute: false }) onRetryChannelOnboarding: () => void = () => undefined;
  @property({ attribute: false }) compact = false;
  @property({ attribute: false }) historyContent: TemplateResult | typeof nothing = nothing;

  private subscribedStore: CustodianSessionStore | null = null;
  private storeCleanup: (() => void) | null = null;
  private alertCleanup: (() => void) | null = null;
  private lastMessageId: number | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.subscribeToStore();
    this.alertCleanup = custodianAlertStore.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    this.storeCleanup?.();
    this.storeCleanup = null;
    this.alertCleanup?.();
    this.alertCleanup = null;
    this.subscribedStore = null;
    super.disconnectedCallback();
  }

  protected override async getUpdateComplete(): Promise<boolean> {
    const complete = await super.getUpdateComplete();
    await Promise.all(
      Array.from(
        this.querySelectorAll<HTMLElement & { updateComplete: Promise<boolean> }>(
          "openclaw-option-card",
        ),
      ).map((card) => card.updateComplete),
    );
    return complete;
  }

  override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has("store")) {
      this.subscribeToStore();
    }
    this.store.connect(this.context, sessionVariant(this.onboarding, this.newAgentIntent));
  }

  override updated(): void {
    const store = this.store;
    if (store.canSend && !store.sensitive && !store.hasUnresolvedQuestion()) {
      custodianAlertStore.askIfReady(
        (question, admission, display) => void store.send(question, display, false, admission),
      );
    }
    const transcript = this.querySelector<HTMLElement>(".custodian__messages");
    const messageId = this.store.messages.at(-1)?.id ?? null;
    if (messageId !== this.lastMessageId) {
      this.lastMessageId = messageId;
      const lastMessage = transcript?.lastElementChild;
      if (lastMessage instanceof HTMLElement) {
        lastMessage.scrollIntoView?.({ block: "nearest" });
      }
    }
  }

  private subscribeToStore(): void {
    if (!this.isConnected || this.subscribedStore === this.store) {
      return;
    }
    this.storeCleanup?.();
    this.subscribedStore = this.store;
    this.storeCleanup = this.store.subscribe(() => this.requestUpdate());
  }

  private handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    void this.store.send();
  }

  override render() {
    const store = this.store;
    const assistantAvatar = controlUiPublicAssetPath("favicon.svg", this.context.resourceBasePath);
    const alertCard = custodianAlertStore.alert
      ? renderCustodianAlertCard({
          alert: custodianAlertStore.alert,
          context: this.context,
          onDismiss: () => custodianAlertStore.dismiss(),
        })
      : nothing;
    if (store.setupRequired) {
      return html`
        <section
          class="custodian-surface custodian-surface--setup-required ${this.compact
            ? "custodian-surface--panel"
            : ""}"
        >
          ${alertCard}
          <div class="custodian__setup-state" role="alert">
            <openclaw-mascot mood="idle" .size=${this.compact ? 72 : 96}></openclaw-mascot>
            <h2>${t("modelSetup.required.title")}</h2>
            <p>${t("modelSetup.required.body")}</p>
            <div class="custodian__setup-actions">
              <button class="btn primary" type="button" @click=${() => store.openModelSetup()}>
                ${t("modelSetup.required.action")}
              </button>
            </div>
          </div>
        </section>
      `;
    }
    const emptyError = store.messages.length === 0 && store.error !== null && !store.sending;
    const activeWizardMessage = store.wizardInputPending
      ? store.messages.findLast((message) => message.step !== null)
      : undefined;
    return html`
      <section
        class="custodian-surface ${this.compact ? "custodian-surface--panel" : ""} ${emptyError
          ? "custodian-surface--empty-error"
          : ""}"
      >
        <div
          class="custodian__messages"
          ${markdownBlocks()}
          aria-live="polite"
          @click=${(event: MouseEvent) => {
            handleMarkdownCodeBlockClick(event);
            handleMarkdownTableInteraction(event);
          }}
        >
          ${alertCard}
          ${this.channelOnboardingError
            ? eventNudgeState.renderCustodianChannelOnboardingError({
                retrying: this.channelOnboardingRetrying,
                onRetry: this.onRetryChannelOnboarding,
                onDismiss: () => store.dismissChannelOnboardingNudge(),
              })
            : this.showChannelOnboardingNudge
              ? eventNudgeState.renderCustodianChannelOnboardingNudge({
                  onOpenChannels: () => store.openChannelsFromOnboarding(),
                  onDismiss: () => store.dismissChannelOnboardingNudge(),
                })
              : nothing}
          ${!this.onboarding && store.eventNudge && !store.eventNudgePending
            ? eventNudgeState.renderCustodianEventNudge({
                nudge: store.eventNudge,
                disabled: !store.canSend || store.sensitive || store.hasUnresolvedQuestion(),
                onSend: () => void store.sendEventNudge(),
                onDismiss: () => store.dismissEventNudge(),
              })
            : nothing}
          ${store.messages.map((message) => {
            const questionKey = message.question ? `${message.id}:${message.question.id}` : "";
            const showQuestion =
              message.question !== null && !store.dismissedQuestions.has(questionKey);
            return renderCustodianTranscriptEntry({
              message,
              boundaryAfterId: store.earlierBoundaryAfterId,
              assistantAvatar,
              showQuestion,
              questionDisabled: !store.canSend || store.answeredQuestions.has(questionKey),
              onSelect: (label) => store.answerQuestion(message, label),
              onSkip: () => void store.dismissQuestion(message),
              showWizardStep: message === activeWizardMessage,
              wizardValue: store.wizardValue,
              wizardDisabled: !store.canSend,
              wizardSecretVisible: store.wizardSecretVisible,
              onWizardValueChange: (value) => store.setWizardValue(value),
              onWizardAnswer: (value) => store.answerWizardStep(message, value),
              showWizardCancel: store.wizardCancelAvailable,
              onWizardCancel: () => store.cancelWizardStep(message),
              onToggleWizardSecretVisibility: () => store.toggleWizardSecretVisibility(),
            });
          })}
          ${store.sending
            ? html`<div class="chat-group assistant custodian__thinking-row" role="status">
                <div class="chat-avatar assistant custodian__mascot-avatar" aria-hidden="true">
                  <openclaw-mascot mood="thinking" .size=${26}></openclaw-mascot>
                </div>
                <div class="chat-group-messages custodian__thinking">
                  <span></span><span></span><span></span>
                  <span class="sr-only">${t("custodian.thinking")}</span>
                </div>
              </div>`
            : nothing}
          ${store.abandonedTurnOutcomeUnknown
            ? html`<div class="custodian__error" role="alert">
                <span>${t("custodian.connectionChanged")}</span>
              </div>`
            : nothing}
          ${renderPanelRefreshStatus({
            status: store.transcript.status,
            onRetry: () => void store.refreshTranscriptIfIdle(),
            retryDisabled: !store.canRefreshTranscript(),
            className: "custodian__transcript-status",
          })}
          ${store.error &&
          !(store.abandonedTurnOutcomeUnknown && store.error === t("custodian.connectionChanged"))
            ? html`<div class="custodian__error" role="alert">
                <span>${store.error}</span>
                ${store.activeClient && store.chatAvailable && store.canRetry()
                  ? html`<button class="btn btn--sm" type="button" @click=${() => store.retry()}>
                      ${t("common.retry")}
                    </button>`
                  : nothing}
              </div>`
            : nothing}
        </div>

        ${this.historyContent}
        ${activeWizardMessage
          ? nothing
          : html`<div class="agent-chat__composer-shell">
              <div class="agent-chat__input">
                <div class="agent-chat__composer-input-row">
                  <div class="agent-chat__composer-combobox">
                    ${store.sensitive
                      ? html`<input
                          type="password"
                          .value=${store.input}
                          autocomplete="off"
                          placeholder=${t("custodian.sensitivePlaceholder")}
                          aria-label=${t("custodian.sensitivePlaceholder")}
                          ?disabled=${!store.canSend}
                          @input=${(event: Event) =>
                            store.setInput((event.target as HTMLInputElement).value)}
                          @keydown=${(event: KeyboardEvent) => this.handleComposerKeydown(event)}
                        />`
                      : html`<textarea
                          rows="1"
                          .value=${store.input}
                          autocomplete="on"
                          placeholder=${t("custodian.placeholder")}
                          aria-label=${t("custodian.placeholder")}
                          ?disabled=${!store.canSend}
                          @input=${(event: Event) =>
                            store.setInput((event.target as HTMLTextAreaElement).value)}
                          @keydown=${(event: KeyboardEvent) => this.handleComposerKeydown(event)}
                        ></textarea>`}
                  </div>
                  <div class="agent-chat__composer-actions">
                    <button
                      class="chat-send-btn"
                      type="button"
                      aria-label=${t("custodian.send")}
                      ?disabled=${!store.input.trim() || !store.canSend}
                      @click=${() => void store.send()}
                    >
                      ${icons.arrowUp}
                      <span class="agent-chat__control-label">${t("custodian.send")}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>`}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-custodian-surface")) {
  customElements.define("openclaw-custodian-surface", CustodianSurface);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-surface": CustodianSurface;
  }
}
