import { consume } from "@lit/context";
import type {
  SystemAgentChatParams,
  SystemAgentChatResult,
  SystemChangeEntry,
  SystemChangesListResult,
} from "@openclaw/gateway-protocol";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { searchForSession } from "../../lib/sessions/navigation.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/chat/grouped.css";
import "../../styles/chat/layout.css";
import "../../styles/chat/text.css";
import "../../styles/custodian.css";
import { renderChatAvatar } from "../chat/chat-avatar.ts";
import { renderCustodianChangeHistory } from "./custodian-history.ts";
import * as eventNudgeState from "./event-nudge.ts";
import {
  isCustodianSessionInvalidatedError,
  sessionVariant,
  type CustodianSessionVariant,
  welcomeVariant,
} from "./session-lifecycle.ts";
import { parseCustodianQuestion, type CustodianStructuredQuestion } from "./structured-question.ts";
import {
  createCustodianSessionId,
  createCustodianTranscriptMessages,
  custodianErrorMessage,
  hasUnresolvedCustodianQuestion,
  readCustodianTranscript,
  renderCustodianTranscriptEntry,
  retireCustodianQuestions,
  type CustodianMessage,
} from "./transcript.ts";

const SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;
const SYSTEM_CHANGE_PAGE_SIZE = 50;
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

export class CustodianPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  /** Onboarding mode shows the Exit setup control; the route view sets this. */
  @property({ attribute: false }) onboarding = false;

  /** New-agent mode starts a creation proposal conversation. */
  @property({ attribute: false }) newAgentIntent = false;

  @state() private messages: CustodianMessage[] = [];
  @state() private input = "";
  @state() private sending = false;
  @state() private sensitive = false;
  @state() private wizardInputPending = false;
  @state() private questionReplyUncertain = false;
  @state() private error: string | null = null;
  @state() private dismissedQuestions = new Set<string>();
  @state() private answeredQuestions = new Set<string>();
  @state() private activeClient: GatewayBrowserClient | null = null;
  @state() private chatAvailable = false;
  @state() private historyAvailable = false;
  @state() private historyOpen = false;
  @state() private historyEntries: SystemChangeEntry[] = [];
  @state() private historyNextCursor: string | null = null;
  @state() private historyLoading = false;
  @state() private historyLoadingMore = false;
  @state() private historyError: string | null = null;
  @state() private eventNudge: eventNudgeState.CustodianEventNudge | null = null;
  @state() private eventNudgePending: eventNudgeState.CustodianEventNudge | null = null;

  private sessionId = createCustodianSessionId();
  private requestEpoch = 0;
  private nextMessageId = 1;
  private retryParams: SystemAgentChatParams | null = null;
  private sessionVariant: CustodianSessionVariant | null = null;
  private sessionClient: GatewayBrowserClient | null = null;
  private sessionOwnershipKey: string | null = null;
  private sessionStarted = false;
  private earlierBoundaryAfterId: number | null = null;
  private lastHelloDeviceToken = "";
  private eventNudgeClosed = false;
  private abandonedTurnOutcomeUnknown = false;
  private historyLoaded = false;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );
  private readonly eventSubscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) =>
      gateway.subscribeEvents((event) => {
        if (this.onboarding || this.newAgentIntent || this.eventNudgeClosed) {
          return;
        }
        [this.eventNudge, this.eventNudgePending] = eventNudgeState.reconcileCustodianEventNudge(
          this.eventNudge,
          this.eventNudgePending,
          event,
        );
      }),
  );

  override disconnectedCallback(): void {
    this.requestEpoch += 1;
    this.subscriptions.clear();
    this.eventSubscriptions.clear();
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues): void {
    this.synchronizeClient();
    if (changedProperties.has("messages")) {
      const lastMessage = this.querySelector(".custodian__messages")?.lastElementChild;
      if (lastMessage instanceof HTMLElement) {
        lastMessage.scrollIntoView?.({ block: "nearest" });
      }
    }
  }

  /**
   * Transcript rows are durable and admin-scoped, but the live engine session
   * owns wizard and approval state. Rotate only that volatile state when its
   * client or authenticated gateway identity changes.
   */
  private currentSessionOwnershipKey(): string {
    const { gatewayUrl, token, password, bootstrapToken } = this.context.gateway.connection;
    const auth = this.context.gateway.snapshot.hello?.auth;
    if (auth) {
      this.lastHelloDeviceToken = auth.deviceToken ?? "";
    }
    return JSON.stringify([gatewayUrl, token, password, bootstrapToken, this.lastHelloDeviceToken]);
  }

  private startSession(
    client: GatewayBrowserClient,
    variant: CustodianSessionVariant,
    loadTranscript: boolean,
  ): void {
    this.sessionId = createCustodianSessionId();
    this.sessionVariant = variant;
    this.sessionClient = client;
    this.sessionOwnershipKey = this.currentSessionOwnershipKey();
    this.sessionStarted = true;
    void this.initializeSession(
      client,
      { sessionId: this.sessionId, ...welcomeVariant(variant) },
      loadTranscript,
    );
  }

  /**
   * A user turn abandoned mid-flight may already have acted on the gateway.
   * The unknown-outcome warning must survive rotations and reconnects
   * independently of retry state (raw text is never retained) until the
   * operator supersedes it with a new message.
   */
  private abandonPendingUserTurn(pendingParams: SystemAgentChatParams | null): void {
    if (pendingParams?.message === undefined) {
      return;
    }
    this.retryParams = null;
    this.abandonedTurnOutcomeUnknown = true;
  }

  private rotateVolatileSession(
    client: GatewayBrowserClient,
    variant: CustodianSessionVariant,
  ): void {
    this.answeredQuestions = retireCustodianQuestions(this.messages, this.answeredQuestions);
    this.retryParams = null;
    this.input = "";
    this.sensitive = this.wizardInputPending = this.questionReplyUncertain = false;
    this.error = null;
    this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
    this.startSession(client, variant, false);
  }

  private synchronizeClient(): void {
    const snapshot = this.context.gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const chatSupported =
      client !== null && isGatewayMethodAdvertised(snapshot, "openclaw.chat") === true;
    const historyAvailable =
      client !== null && isGatewayMethodAdvertised(snapshot, "openclaw.changes.list") === true;
    if (this.historyAvailable !== historyAvailable) {
      this.historyAvailable = historyAvailable;
      if (!historyAvailable) {
        this.historyOpen = false;
        this.resetHistory();
      }
    }
    const variant = sessionVariant(this.onboarding, this.newAgentIntent);
    const variantChanged = this.sessionStarted && this.sessionVariant !== variant;
    const ownershipKey = this.currentSessionOwnershipKey();
    const clientReplaced =
      this.sessionStarted &&
      client !== null &&
      this.sessionClient !== null &&
      client !== this.sessionClient;
    // Ownership boundaries stay armed even while the volatile session is torn
    // down (e.g. an unsupported replacement): a retained transcript must never
    // survive an authenticated identity change.
    const ownershipChanged =
      this.sessionOwnershipKey !== null && ownershipKey !== this.sessionOwnershipKey;
    if (
      client === this.activeClient &&
      !variantChanged &&
      !clientReplaced &&
      !ownershipChanged &&
      this.chatAvailable === chatSupported
    ) {
      return;
    }
    const requestWasPending = this.sending && this.retryParams !== null;
    const pendingParams = requestWasPending ? this.retryParams : null;
    this.activeClient = client;
    this.requestEpoch += 1;
    this.historyOpen = false;
    this.resetHistory();
    this.sending = false;
    this.chatAvailable = false;
    if (variantChanged || ownershipChanged) {
      [this.eventNudge, this.eventNudgePending] = [null, null];
      // A different operator or mode must not inherit the previous context's
      // abandoned-turn warning; same-ownership paths below preserve it.
      this.abandonedTurnOutcomeUnknown = false;
      this.sessionStarted = false;
      this.clearConversation();
    } else if (client && clientReplaced) {
      // A transport replacement keeps the same durable transcript, but do not
      // create a fresh volatile session until the new client advertises chat.
      if (!chatSupported) {
        this.sessionStarted = false;
        this.abandonPendingUserTurn(pendingParams);
        this.error = t("custodian.unsupportedGateway");
        return;
      }
      this.chatAvailable = true;
      // Abandon before rotating: rotation installs the fresh welcome's retry
      // state, which the abandoned turn's scrub must not clear.
      this.abandonPendingUserTurn(pendingParams);
      this.rotateVolatileSession(client, variant);
      return;
    } else if (requestWasPending) {
      if (pendingParams?.message === undefined) {
        this.error = t("custodian.connectionChanged");
      }
      this.abandonPendingUserTurn(pendingParams);
    }
    if (!client) {
      return;
    }
    if (!chatSupported) {
      this.error = t("custodian.unsupportedGateway");
      return;
    }
    this.chatAvailable = true;
    if (this.sessionStarted) {
      if (!this.retryParams) {
        // The abandoned-turn warning renders from its own flag; transient
        // reconnects only clear stale request errors here.
        this.error = requestWasPending ? this.error : null;
      }
      // This rendered thread owns live questions and turns for the active
      // session; durable history is projected only during its cold start.
      return;
    }
    this.clearConversation();
    // Route variants seed their dedicated proposal conversation; the permanent
    // presence surface gets the normal caretaker greeting instead.
    this.startSession(client, variant, true);
  }

  private async initializeSession(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    loadTranscript = true,
  ): Promise<void> {
    const epoch = ++this.requestEpoch;
    this.sending = true;
    this.error = null;
    this.retryParams = params;
    if (loadTranscript) {
      await this.refreshTranscriptHistory(client, epoch);
    }
    if (epoch !== this.requestEpoch || client !== this.activeClient) {
      return;
    }
    await this.requestReply(client, params);
  }

  private async refreshTranscriptHistory(
    client: GatewayBrowserClient,
    epoch: number,
  ): Promise<void> {
    if (
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "openclaw.chat.history") !== true
    ) {
      return;
    }
    const turns = await readCustodianTranscript(client);
    if (turns === null || epoch !== this.requestEpoch || client !== this.activeClient) {
      // History is additive. A transient read failure must not block chat or erase local state.
      return;
    }
    const transcript = createCustodianTranscriptMessages(turns, this.nextMessageId);
    this.messages = transcript.messages;
    this.nextMessageId = transcript.nextMessageId;
    this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
  }

  private clearConversation(): void {
    this.messages = [];
    this.dismissedQuestions = new Set();
    this.answeredQuestions = new Set();
    this.retryParams = null;
    this.error = null;
    this.input = "";
    this.sensitive = this.wizardInputPending = this.questionReplyUncertain = false;
    this.earlierBoundaryAfterId = null;
  }

  private resetHistory(): void {
    this.historyEntries = [];
    this.historyNextCursor = null;
    this.historyLoading = false;
    this.historyLoadingMore = false;
    this.historyError = null;
    this.historyLoaded = false;
  }

  private toggleHistory(): void {
    this.historyOpen = !this.historyOpen;
    if (this.historyOpen && !this.historyLoading && !this.historyLoadingMore) {
      void this.loadHistory(true);
    }
  }

  private async loadHistory(reset: boolean): Promise<void> {
    const client = this.activeClient;
    const cursor = reset ? undefined : (this.historyNextCursor ?? undefined);
    if (
      !client ||
      !this.historyAvailable ||
      this.historyLoading ||
      this.historyLoadingMore ||
      (!reset && !cursor)
    ) {
      return;
    }
    const epoch = this.requestEpoch;
    if (reset) {
      this.historyLoading = true;
    } else {
      this.historyLoadingMore = true;
    }
    this.historyError = null;
    const isCurrent = () =>
      this.isConnected &&
      this.activeClient === client &&
      this.requestEpoch === epoch &&
      this.historyAvailable;
    try {
      const result = await client.request<SystemChangesListResult>("openclaw.changes.list", {
        limit: SYSTEM_CHANGE_PAGE_SIZE,
        ...(cursor ? { beforeCursor: cursor } : {}),
      });
      if (!isCurrent()) {
        return;
      }
      this.historyEntries = reset ? result.entries : [...this.historyEntries, ...result.entries];
      this.historyNextCursor = result.nextCursor ?? null;
      this.historyLoaded = true;
    } catch {
      if (isCurrent()) {
        this.historyError = t("custodian.history.requestFailed");
        this.historyLoaded = true;
      }
    } finally {
      if (isCurrent()) {
        this.historyLoading = false;
        this.historyLoadingMore = false;
      }
    }
  }

  private appendAssistant(reply: string, question: CustodianStructuredQuestion | null): void {
    this.messages = [
      ...this.messages,
      {
        id: this.nextMessageId++,
        role: "assistant",
        text: reply,
        at: Date.now(),
        question,
      },
    ];
  }

  private async requestReply(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    const epoch = ++this.requestEpoch;
    let delivery: eventNudgeState.CustodianSendDelivery = "unsent";
    this.sending = true;
    this.error = null;
    this.retryParams = params;
    try {
      const result = await client.request<SystemAgentChatResult>("openclaw.chat", params, {
        timeoutMs: SYSTEM_AGENT_CHAT_TIMEOUT_MS,
        onSent: () => (delivery = "sent"),
      });
      delivery = "received";
      if (epoch !== this.requestEpoch || client !== this.activeClient) {
        return "sent";
      }
      this.sessionId = result.sessionId;
      this.sensitive = result.sensitive === true;
      this.wizardInputPending = result.wizardInputPending === true;
      this.retryParams = null;
      const question = parseCustodianQuestion(result.question);
      // Match regular chat: NO_REPLY is a delivery sentinel, not transcript content.
      const silentReply = SILENT_REPLY_PATTERN.test(result.reply);
      if (!silentReply || question) {
        this.appendAssistant(silentReply ? "" : result.reply, question);
      }
      if (result.action === "open-agent") {
        let sessionKey = this.context.gateway.snapshot.sessionKey?.trim();
        if (result.agentId) {
          const roster = await this.context.agents.refreshList();
          if (epoch !== this.requestEpoch || client !== this.activeClient) {
            return "sent";
          }
          sessionKey = buildAgentMainSessionKey({
            agentId: result.agentId,
            mainKey: roster?.mainKey,
          });
          this.context.gateway.setSessionKey(sessionKey);
        }
        if (result.agentDraft === "hatch" && sessionKey) {
          // Preserve the destination session while preloading the localized
          // birth-sequence opener; draft-only chat routes are intentionally invalid.
          this.context.navigate("chat", {
            search: `${searchForSession(sessionKey)}&draft=${encodeURIComponent(t("custodian.hatchDraft"))}`,
          });
        } else {
          this.exitSetup();
        }
      } else if (result.action === "exit") {
        this.exitSetup();
      }
      return "sent";
    } catch (error) {
      if (epoch === this.requestEpoch && client === this.activeClient) {
        this.error = custodianErrorMessage(error);
        if (params.message !== undefined && isCustodianSessionInvalidatedError(error)) {
          // Adopt a new id before another visible turn; retained rows are not live context.
          // Welcome requests never rotate, so even a mis-marked outage stops after one attempt.
          this.rotateVolatileSession(client, sessionVariant(this.onboarding, this.newAgentIntent));
          this.error = t("custodian.sessionRestarted", { error: custodianErrorMessage(error) });
        }
      }
      // A failed user turn may still have reached the agent and acted; there is
      // no turn idempotency, so never keep it replayable (or its raw text).
      if (params.message !== undefined && this.retryParams === params) {
        this.retryParams = null;
      }
      return eventNudgeState.classifyCustodianSendFailure(error, delivery);
    } finally {
      if (epoch === this.requestEpoch) {
        this.sending = false;
      }
    }
  }

  private async send(
    text = this.input,
    display?: string,
    questionReply = this.hasUnresolvedQuestion(),
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    // Trim decides emptiness only; sensitive values (credentials) may carry
    // meaningful whitespace and must reach the agent exactly as entered.
    const message = this.sensitive ? text : text.trim();
    const client = this.activeClient;
    const questionState = [this.answeredQuestions, this.questionReplyUncertain] as const;
    if (questionReply) {
      // A failed wizard reply may have arrived, so block nudges until the session outcome is known.
      this.questionReplyUncertain = true;
    }
    if (!message.trim() || !client || !this.chatAvailable || this.sending) {
      return "rejected";
    }
    const displayText = this.sensitive ? t("custodian.sensitiveReply") : (display ?? message);
    // A new operator turn supersedes any abandoned-turn unknown-outcome warning.
    this.abandonedTurnOutcomeUnknown = false;
    this.answeredQuestions = retireCustodianQuestions(this.messages, this.answeredQuestions);
    this.messages = [
      ...this.messages,
      {
        id: this.nextMessageId++,
        role: "user",
        text: displayText,
        at: Date.now(),
        question: null,
      },
    ];
    this.input = "";
    const reply = this.requestReply(client, {
      sessionId: this.sessionId,
      ...welcomeVariant(sessionVariant(this.onboarding, this.newAgentIntent)),
      message,
    });
    const replyEpoch = this.requestEpoch;
    const outcome = await reply;
    if (questionReply && this.requestEpoch === replyEpoch) {
      this.questionReplyUncertain = eventNudgeState.questionUncertainty(questionState[1], outcome);
      if (outcome === "rejected") {
        this.answeredQuestions = questionState[0];
      }
    }
    return outcome;
  }

  private async sendEventNudge(): Promise<void> {
    const nudge = this.eventNudge;
    if (!nudge || this.sensitive || this.hasUnresolvedQuestion()) {
      return;
    }
    this.eventNudgePending = nudge;
    const outcome = await this.send(nudge.message);
    if (this.eventNudgePending === nudge) {
      this.eventNudgePending = null;
      const consumed = eventNudgeState.shouldConsumeNudge(this.eventNudge, nudge, outcome);
      [this.eventNudgeClosed, this.eventNudge] = [consumed, consumed ? null : this.eventNudge];
    }
  }

  private async dismissQuestion(message: CustodianMessage): Promise<void> {
    const question = message.question;
    if (!question) {
      return;
    }
    if (question.skipAction === "exit") {
      this.exitSetup();
      return;
    }
    // Closed wizard selects accept cancel; open "other" prompts use their visible free-form reply.
    const outcome = await this.send(
      question.isOther ? t("optionCard.skip") : "cancel",
      t("optionCard.skip"),
      true,
    );
    if (outcome !== "rejected" && this.messages.includes(message)) {
      this.dismissedQuestions = new Set(this.dismissedQuestions).add(
        `${message.id}:${question.id}`,
      );
    }
  }

  private answerQuestion(message: CustodianMessage, label: string): void {
    const question = message.question;
    if (!question) {
      return;
    }
    const option = question.options.find((candidate) => candidate.label === label);
    // Show the friendly label while sending the canonical reply that the engine parses.
    void this.send(option?.reply ?? label, label, true);
  }

  private hasUnresolvedQuestion(): boolean {
    return hasUnresolvedCustodianQuestion(
      this.messages,
      this.dismissedQuestions,
      this.answeredQuestions,
      this.wizardInputPending,
      this.questionReplyUncertain,
    );
  }

  private exitSetup(): void {
    this.context.navigate("chat");
  }

  private canRetry(): boolean {
    // Only the welcome request is safely replayable; a user turn has no
    // idempotency key and may have already acted on the agent side.
    return this.retryParams !== null && this.retryParams.message === undefined;
  }

  private retry(): void {
    const client = this.activeClient;
    const params = this.retryParams;
    if (client && params && params.message === undefined && this.chatAvailable && !this.sending) {
      void this.initializeSession(client, params);
    }
  }

  private handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    void this.send();
  }

  override render() {
    return html`
      <section class="custodian">
        <header class="custodian__header">
          <div class="custodian__identity">
            <div class="custodian__mark" aria-hidden="true">OC</div>
            <div>
              <h1>${t("custodian.title")}</h1>
              <p>${t(this.onboarding ? "custodian.subtitle" : "custodian.subtitleCaretaker")}</p>
            </div>
          </div>
          <div class="custodian__header-actions">
            ${this.historyAvailable
              ? html`<button
                  class="btn btn--ghost custodian__history-toggle"
                  type="button"
                  aria-expanded=${this.historyOpen ? "true" : "false"}
                  @click=${() => this.toggleHistory()}
                >
                  ${t("custodian.history.button")}
                </button>`
              : nothing}
            ${this.onboarding
              ? html`<button class="btn btn--ghost" type="button" @click=${() => this.exitSetup()}>
                  ${t("custodian.exitSetup")}
                </button>`
              : nothing}
          </div>
        </header>

        <div class="custodian__messages" aria-live="polite">
          ${!this.onboarding && this.eventNudge && !this.eventNudgePending
            ? eventNudgeState.renderCustodianEventNudge({
                nudge: this.eventNudge,
                disabled:
                  !this.activeClient ||
                  !this.chatAvailable ||
                  this.sending ||
                  this.sensitive ||
                  this.hasUnresolvedQuestion(),
                onSend: () => void this.sendEventNudge(),
                onDismiss: () => void ([this.eventNudge, this.eventNudgeClosed] = [null, true]),
              })
            : nothing}
          ${this.messages.map((message) => {
            const questionKey = message.question ? `${message.id}:${message.question.id}` : "";
            const showQuestion =
              message.question !== null && !this.dismissedQuestions.has(questionKey);
            return renderCustodianTranscriptEntry({
              message,
              boundaryAfterId: this.earlierBoundaryAfterId,
              showQuestion,
              questionDisabled:
                this.sending || !this.chatAvailable || this.answeredQuestions.has(questionKey),
              onSelect: (label) => this.answerQuestion(message, label),
              onSkip: () => void this.dismissQuestion(message),
            });
          })}
          ${this.sending
            ? html`<div class="chat-group assistant custodian__thinking-row" role="status">
                ${renderChatAvatar("assistant", { name: t("custodian.title"), avatar: "OC" })}
                <div class="chat-group-messages custodian__thinking">
                  <span></span><span></span><span></span>
                  <span class="sr-only">${t("custodian.thinking")}</span>
                </div>
              </div>`
            : nothing}
          ${this.abandonedTurnOutcomeUnknown
            ? html`<div class="custodian__error" role="alert">
                <span>${t("custodian.connectionChanged")}</span>
              </div>`
            : nothing}
          ${this.error &&
          !(this.abandonedTurnOutcomeUnknown && this.error === t("custodian.connectionChanged"))
            ? html`<div class="custodian__error" role="alert">
                <span>${this.error}</span>
                ${this.activeClient && this.chatAvailable && this.canRetry()
                  ? html`<button class="btn btn--sm" type="button" @click=${() => this.retry()}>
                      ${t("common.retry")}
                    </button>`
                  : nothing}
              </div>`
            : nothing}
        </div>

        ${this.historyOpen && this.historyAvailable
          ? renderCustodianChangeHistory({
              entries: this.historyEntries,
              error: this.historyError,
              loaded: this.historyLoaded,
              loading: this.historyLoading,
              loadingMore: this.historyLoadingMore,
              nextCursor: this.historyNextCursor,
              onLoad: (reset) => {
                void this.loadHistory(reset);
              },
            })
          : nothing}

        <div class="agent-chat__composer-shell">
          <div class="agent-chat__input">
            <div class="agent-chat__composer-input-row">
              <div class="agent-chat__composer-combobox">
                ${this.sensitive
                  ? html`<input
                      type="password"
                      .value=${this.input}
                      autocomplete="off"
                      placeholder=${t("custodian.sensitivePlaceholder")}
                      aria-label=${t("custodian.sensitivePlaceholder")}
                      ?disabled=${!this.activeClient || !this.chatAvailable || this.sending}
                      @input=${(event: Event) =>
                        (this.input = (event.target as HTMLInputElement).value)}
                      @keydown=${(event: KeyboardEvent) => this.handleComposerKeydown(event)}
                    />`
                  : html`<textarea
                      rows="1"
                      .value=${this.input}
                      autocomplete="on"
                      placeholder=${t("custodian.placeholder")}
                      aria-label=${t("custodian.placeholder")}
                      ?disabled=${!this.activeClient || !this.chatAvailable || this.sending}
                      @input=${(event: Event) =>
                        (this.input = (event.target as HTMLTextAreaElement).value)}
                      @keydown=${(event: KeyboardEvent) => this.handleComposerKeydown(event)}
                    ></textarea>`}
              </div>
              <div class="agent-chat__composer-actions">
                <button
                  class="chat-send-btn"
                  type="button"
                  aria-label=${t("custodian.send")}
                  ?disabled=${!this.input.trim() ||
                  !this.activeClient ||
                  !this.chatAvailable ||
                  this.sending}
                  @click=${() => void this.send()}
                >
                  ${icons.arrowUp}
                  <span class="agent-chat__control-label">${t("custodian.send")}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-custodian-page")) {
  customElements.define("openclaw-custodian-page", CustodianPage);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-page": CustodianPage;
  }
}
