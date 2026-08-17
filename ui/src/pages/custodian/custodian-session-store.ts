import {
  readSystemAgentInferenceUnavailableErrorDetails,
  type SystemAgentChatParams,
  type SystemAgentChatResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { performCustodianAgentHandoff } from "./custodian-navigation.ts";
import {
  createCustodianSessionId,
  CustodianSessionOwner,
  loadCustodianSessionId,
  persistCustodianSessionId,
} from "./custodian-session-identity.ts";
import {
  resolveCustodianConfiguredInferenceState,
  type CustodianConfiguredInferenceState,
} from "./custodian-session-variant.ts";
import {
  custodianWizardSubmission,
  initialCustodianWizardValue,
  isCustodianWizardCancelAvailable,
} from "./custodian-wizard-step.ts";
import * as eventNudgeState from "./event-nudge.ts";
import {
  custodianChatParams,
  hasCustodianUserInput,
  isCustodianSessionInvalidatedError,
  type CustodianSessionVariant,
} from "./session-lifecycle.ts";
import { parseCustodianQuestion, type CustodianStructuredQuestion } from "./structured-question.ts";
import {
  createCustodianTranscriptMessages,
  custodianErrorMessage,
  hasUnresolvedCustodianQuestion,
  readCustodianTranscript,
  retireCustodianQuestions,
  type CustodianMessage,
} from "./transcript.ts";

const SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

type StoreListener = () => void;
type CustodianSetupIssue = "missing" | "unavailable";

/** One process-local conversation owner shared by the full page and dock surface. */
export class CustodianSessionStore {
  messages: CustodianMessage[] = [];
  input = "";
  sending = false;
  sensitive = false;
  wizardInputPending = false;
  wizardValue: unknown;
  wizardSecretVisible = false;
  questionReplyUncertain = false;
  error: string | null = null;
  setupIssue: CustodianSetupIssue | null = null;
  dismissedQuestions = new Set<string>();
  answeredQuestions = new Set<string>();
  activeClient: GatewayBrowserClient | null = null;
  chatAvailable = false;
  eventNudge: eventNudgeState.CustodianEventNudge | null = null;
  eventNudgePending: eventNudgeState.CustodianEventNudge | null = null;
  channelOnboardingNudgeClosed = false;
  earlierBoundaryAfterId: number | null = null;
  abandonedTurnOutcomeUnknown = false;

  private context: ApplicationContext | null = null;
  private variant: CustodianSessionVariant = "caretaker";
  private sessionVariant: CustodianSessionVariant | null = null;
  private restoredIdentity = loadCustodianSessionId();
  private sessionId = this.restoredIdentity.sessionId;
  // True while the id may address a live session whose per-session queue can
  // hold an in-flight turn from a previous page; cleared after one barrier
  // refresh and on any fresh mint.
  private rejoinBarrierPending = this.restoredIdentity.restored;
  private requestEpoch = 0;
  private requestAbort: AbortController | null = null;
  private nextMessageId = 1;
  private retryParams: SystemAgentChatParams | null = null;
  private sessionClient: GatewayBrowserClient | null = null;
  private sessionOwnershipKey: string | null = null;
  private readonly sessionOwner = new CustodianSessionOwner();
  private sessionStarted = false;
  private configuredInferenceState: CustodianConfiguredInferenceState = "unresolved";
  private eventNudgeClosed = false;
  private gatewayCleanup: (() => void) | null = null;
  private agentCleanup: (() => void) | null = null;
  private eventCleanup: (() => void) | null = null;
  private readonly listeners = new Set<StoreListener>();

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(context: ApplicationContext, variant: CustodianSessionVariant): void {
    const contextChanged = this.context !== context;
    const variantChanged = this.variant !== variant;
    if (!contextChanged && !variantChanged) {
      return;
    }
    if (contextChanged) {
      this.gatewayCleanup?.();
      this.agentCleanup?.();
      this.eventCleanup?.();
      this.context = context;
      this.gatewayCleanup = context.gateway.subscribe(() => {
        this.synchronizeClient();
        this.emit();
      });
      this.agentCleanup = context.agents.subscribe(() => {
        this.synchronizeClient();
        this.emit();
      });
      this.eventCleanup = context.gateway.subscribeEvents((event) => {
        if (this.variant !== "caretaker" || this.eventNudgeClosed) {
          return;
        }
        [this.eventNudge, this.eventNudgePending] = eventNudgeState.reconcileCustodianEventNudge(
          this.eventNudge,
          this.eventNudgePending,
          event,
        );
        this.emit();
      });
    }
    this.variant = variant;
    this.synchronizeClient();
    this.emit();
  }

  setInput(value: string): void {
    this.input = value;
    this.emit();
  }

  setWizardValue(value: unknown): void {
    this.wizardValue = value;
    this.emit();
  }

  toggleWizardSecretVisibility(): void {
    this.wizardSecretVisible = !this.wizardSecretVisible;
    this.emit();
  }

  hasRealUserTurn(): boolean {
    return this.messages.some((message) => message.role === "user");
  }

  get activeVariant(): CustodianSessionVariant {
    return this.variant;
  }

  hasUnresolvedQuestion(): boolean {
    return hasUnresolvedCustodianQuestion(
      this.messages,
      this.dismissedQuestions,
      this.answeredQuestions,
      this.wizardInputPending,
      this.questionReplyUncertain,
    );
  }

  async refreshTranscriptIfIdle(): Promise<void> {
    const client = this.activeClient;
    // hasUnresolvedQuestion() also covers a pending wizard step.
    if (!client || !this.sessionStarted || this.sending || this.hasUnresolvedQuestion()) {
      return;
    }
    const refreshed = await this.refreshTranscriptHistory(client, this.requestEpoch);
    if (refreshed && this.abandonedTurnOutcomeUnknown) {
      this.abandonedTurnOutcomeUnknown = false;
      this.emit();
    }
  }

  canRetry(): boolean {
    return this.retryParams !== null && !hasCustodianUserInput(this.retryParams);
  }

  get setupRequired(): boolean {
    return this.setupIssue !== null;
  }

  get wizardCancelAvailable(): boolean {
    return isCustodianWizardCancelAvailable(this.context);
  }

  retry(): void {
    const client = this.activeClient;
    const params = this.retryParams;
    if (client && params && !hasCustodianUserInput(params) && this.chatAvailable && !this.sending) {
      void this.initializeSession(client, params);
    }
  }

  async send(
    text = this.input,
    display?: string,
    questionReply = this.hasUnresolvedQuestion(),
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    // Trim decides emptiness only; sensitive values may carry meaningful whitespace.
    const message = this.sensitive ? text : text.trim();
    const client = this.activeClient;
    if (!message.trim() || !client || !this.chatAvailable || this.sending || this.setupRequired) {
      this.emit();
      return "rejected";
    }
    const displayText = this.sensitive ? t("custodian.sensitiveReply") : (display ?? message);
    return await this.sendUserTurn(
      client,
      {
        sessionId: this.sessionId,
        ...custodianChatParams(this.variant, message),
      },
      displayText,
      questionReply,
    );
  }

  private async sendUserTurn(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    displayText: string,
    questionReply: boolean,
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    const questionState = [this.answeredQuestions, this.questionReplyUncertain] as const;
    if (questionReply) {
      this.questionReplyUncertain = true;
    }
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
        step: null,
      },
    ];
    this.input = "";
    this.emit();
    const reply = this.requestReply(client, params);
    const replyEpoch = this.requestEpoch;
    const outcome = await reply;
    if (questionReply && this.requestEpoch === replyEpoch) {
      this.questionReplyUncertain = eventNudgeState.questionUncertainty(questionState[1], outcome);
      if (outcome === "rejected") {
        this.answeredQuestions = questionState[0];
      }
      this.emit();
    }
    return outcome;
  }

  async sendEventNudge(): Promise<void> {
    const nudge = this.eventNudge;
    if (!nudge || this.sensitive || this.hasUnresolvedQuestion()) {
      return;
    }
    this.eventNudgePending = nudge;
    this.emit();
    const outcome = await this.send(nudge.message);
    if (this.eventNudgePending === nudge) {
      this.eventNudgePending = null;
      const consumed = eventNudgeState.shouldConsumeNudge(this.eventNudge, nudge, outcome);
      [this.eventNudgeClosed, this.eventNudge] = [consumed, consumed ? null : this.eventNudge];
      this.emit();
    }
  }

  dismissEventNudge(): void {
    [this.eventNudge, this.eventNudgeClosed] = [null, true];
    this.emit();
  }

  dismissChannelOnboardingNudge(): void {
    this.channelOnboardingNudgeClosed = true;
    this.emit();
    this.context?.replace("custodian");
  }

  openChannelsFromOnboarding(): void {
    this.channelOnboardingNudgeClosed = true;
    this.revokeNavigationAuthority();
    this.emit();
    this.context?.navigate("channels");
  }

  async dismissQuestion(message: CustodianMessage): Promise<void> {
    const question = message.question;
    if (!question) {
      return;
    }
    if (question.skipAction === "exit") {
      this.exitSetup();
      return;
    }
    const outcome = await this.send(
      question.isOther ? t("optionCard.skip") : "cancel",
      t("optionCard.skip"),
      true,
    );
    if (outcome !== "rejected" && this.messages.includes(message)) {
      this.dismissedQuestions = new Set(this.dismissedQuestions).add(
        `${message.id}:${question.id}`,
      );
      this.emit();
    }
  }

  answerQuestion(message: CustodianMessage, label: string): void {
    const question = message.question;
    if (!question) {
      return;
    }
    const option = question.options.find((candidate) => candidate.label === label);
    void this.send(option?.reply ?? label, label, true);
  }

  answerWizardStep(message: CustodianMessage, value: unknown): void {
    if (!message.step || !this.wizardInputPending) {
      return;
    }
    const submission = custodianWizardSubmission(message.step, value);
    const client = this.activeClient;
    if (!submission || !client || !this.chatAvailable || this.sending || this.setupRequired) {
      this.emit();
      return;
    }
    const displayText = message.step.sensitive ? t("custodian.sensitiveReply") : submission.display;
    void this.sendUserTurn(
      client,
      { sessionId: this.sessionId, wizardAnswer: submission.answer },
      displayText,
      true,
    );
  }

  cancelWizardStep(message: CustodianMessage): void {
    const step = message.step;
    const client = this.activeClient;
    if (
      !step ||
      !this.wizardInputPending ||
      !client ||
      !this.chatAvailable ||
      !this.wizardCancelAvailable ||
      this.sending ||
      this.setupRequired
    ) {
      this.emit();
      return;
    }
    void this.sendUserTurn(
      client,
      { sessionId: this.sessionId, wizardCancel: { stepId: step.id } },
      t("custodian.cancel"),
      true,
    );
  }

  exitSetup(): void {
    // Leaving setup revokes navigation authority from every in-flight reply.
    // The destination surface separately decides whether to retain or rotate context.
    this.revokeNavigationAuthority();
    this.context?.navigate("chat");
  }

  private revokeNavigationAuthority(): void {
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.requestEpoch += 1;
    this.sending = false;
    this.questionReplyUncertain = false;
    this.retryParams = null;
    this.error = null;
  }

  openModelSetup(): void {
    this.revokeNavigationAuthority();
    this.context?.navigate("model-setup");
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private startSession(
    client: GatewayBrowserClient,
    variant: CustodianSessionVariant,
    loadTranscript: boolean,
  ): void {
    this.sessionVariant = variant;
    this.sessionClient = client;
    this.sessionOwnershipKey = this.sessionOwner.key(this.context?.gateway ?? null);
    this.sessionStarted = true;
    void this.initializeSession(
      client,
      { sessionId: this.sessionId, ...custodianChatParams(variant) },
      loadTranscript,
    );
  }

  private replaceSessionId(sessionId?: string): void {
    if (sessionId === undefined) {
      // A freshly minted id cannot address a live session; no barrier needed.
      this.rejoinBarrierPending = false;
    }
    const next = sessionId ?? createCustodianSessionId();
    this.sessionId = next;
    persistCustodianSessionId(next);
  }

  private abandonPendingUserTurn(pendingParams: SystemAgentChatParams | null): void {
    if (!pendingParams || !hasCustodianUserInput(pendingParams)) {
      return;
    }
    this.retryParams = null;
    // The gateway may already have acted, so keep the warning without retaining replayable text.
    this.abandonedTurnOutcomeUnknown = true;
  }

  private restartVolatileSession(
    client: GatewayBrowserClient,
    variant: CustodianSessionVariant,
    rotateSessionId: boolean,
  ): void {
    if (rotateSessionId) {
      this.replaceSessionId();
    }
    this.answeredQuestions = retireCustodianQuestions(this.messages, this.answeredQuestions);
    this.retryParams = null;
    this.input = "";
    this.wizardValue = undefined;
    this.wizardSecretVisible = false;
    this.sensitive = this.wizardInputPending = this.questionReplyUncertain = false;
    this.error = null;
    this.setupIssue = null;
    this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
    this.startSession(client, variant, false);
  }

  private synchronizeClient(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const snapshot = context.gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const chatSupported =
      client !== null && canCallGatewayMethod(snapshot, "openclaw.chat", "operator.admin");
    const chatUnsupported = isGatewayMethodAdvertised(snapshot, "openclaw.chat") === false;
    const configuredInferenceState = resolveCustodianConfiguredInferenceState(this.context);
    const inferenceStateChanged = configuredInferenceState !== this.configuredInferenceState;
    this.configuredInferenceState = configuredInferenceState;
    const variantChanged = this.sessionStarted && this.sessionVariant !== this.variant;
    const ownershipKey = this.sessionOwner.key(context.gateway);
    const reconnected = this.sessionStarted && client !== null && this.activeClient === null;
    const clientReplaced =
      this.sessionStarted &&
      client !== null &&
      this.sessionClient !== null &&
      client !== this.sessionClient;
    const ownershipChanged =
      this.sessionOwnershipKey !== null && ownershipKey !== this.sessionOwnershipKey;
    if (
      client === this.activeClient &&
      !variantChanged &&
      !clientReplaced &&
      !ownershipChanged &&
      this.chatAvailable === (chatSupported && configuredInferenceState !== "unresolved") &&
      !inferenceStateChanged
    ) {
      return;
    }
    const requestWasPending = this.sending && this.retryParams !== null;
    const pendingParams = requestWasPending ? this.retryParams : null;
    this.activeClient = client;
    this.requestEpoch += 1;
    this.sending = false;
    this.chatAvailable = false;
    if (variantChanged || ownershipChanged) {
      // A different operator gets a new server owner binding; route changes retain
      // the stable companion id but rebuild their visible transcript projection.
      if (ownershipChanged) {
        this.replaceSessionId();
      }
      [this.eventNudge, this.eventNudgePending] = [null, null];
      this.eventNudgeClosed = false;
      this.abandonedTurnOutcomeUnknown = false;
      this.sessionStarted = false;
      this.clearConversation();
    } else if (client && (clientReplaced || reconnected)) {
      if (!chatSupported) {
        this.sessionStarted = false;
        this.abandonPendingUserTurn(pendingParams);
        this.error = chatUnsupported ? t("custodian.unsupportedGateway") : null;
        return;
      }
      this.chatAvailable = true;
      this.abandonPendingUserTurn(pendingParams);
      this.requestAbort?.abort();
      this.requestAbort = null;
      this.sessionClient = client;
      this.sessionOwnershipKey = ownershipKey;
      if (this.questionReplyUncertain || this.abandonedTurnOutcomeUnknown) {
        // A SUBMITTED reply with an unknown outcome blocks the idle refresh by
        // design; only a full rejoin can settle it — the Gateway session owns
        // whether the answer was consumed and which control is live now, and
        // its projection re-renders the authoritative state. A merely displayed
        // unanswered card keeps its state; the session still awaits it.
        this.questionReplyUncertain = false;
        this.wizardInputPending = false;
        this.abandonedTurnOutcomeUnknown = false;
        // The reconnect rejoin races the interrupted turn the same way a
        // reload does; arm one barrier refresh behind it.
        this.rejoinBarrierPending = true;
        void this.initializeSession(client, {
          sessionId: this.sessionId,
          ...custodianChatParams(this.variant),
        });
      } else {
        void this.refreshTranscriptIfIdle();
      }
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
      this.error = chatUnsupported ? t("custodian.unsupportedGateway") : null;
      return;
    }
    if (configuredInferenceState === "unresolved") {
      return;
    }
    this.chatAvailable = true;
    if (configuredInferenceState === "required") {
      this.sessionStarted = false;
      this.clearConversation();
      this.setupIssue = "missing";
      return;
    }
    if (inferenceStateChanged) {
      this.setupIssue = null;
    }
    if (this.sessionStarted) {
      if (!this.retryParams) {
        this.error = requestWasPending ? this.error : null;
      }
      return;
    }
    this.clearConversation();
    this.startSession(client, this.variant, true);
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
    this.emit();
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
  ): Promise<boolean> {
    const context = this.context;
    if (
      !context ||
      isGatewayMethodAdvertised(context.gateway.snapshot, "openclaw.chat.history") !== true
    ) {
      return false;
    }
    const turns = await readCustodianTranscript(client);
    if (turns === null || epoch !== this.requestEpoch || client !== this.activeClient) {
      return false;
    }
    const transcript = createCustodianTranscriptMessages(turns, this.nextMessageId);
    this.messages = transcript.messages;
    this.nextMessageId = transcript.nextMessageId;
    this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
    this.emit();
    return true;
  }

  private clearConversation(): void {
    this.messages = [];
    this.dismissedQuestions = new Set();
    this.answeredQuestions = new Set();
    this.retryParams = null;
    this.error = null;
    this.setupIssue = null;
    this.input = "";
    this.wizardValue = undefined;
    this.wizardSecretVisible = false;
    this.sensitive = this.wizardInputPending = this.questionReplyUncertain = false;
    this.earlierBoundaryAfterId = null;
  }

  private appendAssistant(
    reply: string,
    question: CustodianStructuredQuestion | null,
    step: WizardStep | null,
  ): void {
    this.messages = [
      ...this.messages,
      {
        id: this.nextMessageId++,
        role: "assistant",
        text: reply,
        at: Date.now(),
        question,
        step,
      },
    ];
  }

  private async requestReply(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    const context = this.context;
    if (!context) {
      return "rejected";
    }
    const snapshot = context.gateway.snapshot;
    if (
      snapshot.client !== client ||
      !canCallGatewayMethod(snapshot, "openclaw.chat", "operator.admin")
    ) {
      return "rejected";
    }
    this.requestAbort?.abort();
    const requestAbort = new AbortController();
    this.requestAbort = requestAbort;
    const epoch = ++this.requestEpoch;
    let delivery: eventNudgeState.CustodianSendDelivery = "unsent";
    this.sending = true;
    this.error = null;
    if (hasCustodianUserInput(params)) {
      this.setupIssue = null;
    }
    this.retryParams = params;
    this.emit();
    try {
      const result = await client.request<SystemAgentChatResult>("openclaw.chat", params, {
        timeoutMs: SYSTEM_AGENT_CHAT_TIMEOUT_MS,
        onSent: () => (delivery = "sent"),
        signal: requestAbort.signal,
      });
      delivery = "received";
      if (epoch !== this.requestEpoch || client !== this.activeClient) {
        return "sent";
      }
      this.replaceSessionId(result.sessionId);
      this.sensitive = result.sensitive === true;
      this.wizardInputPending = result.wizardInputPending === true;
      this.retryParams = null;
      this.setupIssue = null;
      const step = result.step ?? null;
      const question = step ? null : parseCustodianQuestion(result.question);
      if (this.rejoinBarrierPending && !hasCustodianUserInput(params) && !step && !question) {
        // Rejoin barrier: this input-free request queued behind any in-flight
        // turn on the Gateway's per-session queue, so refreshing here shows
        // rows a racing turn persisted after the initial history fetch.
        // Once per restored id; skipped when a live control is about to render.
        this.rejoinBarrierPending = false;
        await this.refreshTranscriptHistory(client, epoch);
        if (epoch !== this.requestEpoch || client !== this.activeClient) {
          return "sent";
        }
      }
      this.wizardValue = step ? initialCustodianWizardValue(step) : undefined;
      this.wizardSecretVisible = false;
      const silentReply = SILENT_REPLY_PATTERN.test(result.reply);
      if (!silentReply || question || step) {
        this.appendAssistant(silentReply ? "" : result.reply, question, step);
      }
      if (result.action === "open-agent") {
        const handoff = await performCustodianAgentHandoff({
          context,
          ...(result.agentId ? { agentId: result.agentId } : {}),
          hatchDraft: result.agentDraft === "hatch",
          isCurrent: () => epoch === this.requestEpoch && client === this.activeClient,
        });
        if (handoff === "exit-setup") {
          this.exitSetup();
        }
      } else if (result.action === "exit") {
        this.exitSetup();
      }
      return "sent";
    } catch (error) {
      if (epoch === this.requestEpoch && client === this.activeClient) {
        this.error = custodianErrorMessage(error);
        const details =
          error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
        this.setupIssue =
          readSystemAgentInferenceUnavailableErrorDetails(details) !== undefined
            ? this.configuredInferenceState === "required"
              ? "missing"
              : "unavailable"
            : null;
        const sessionInvalidated = isCustodianSessionInvalidatedError(error);
        if (sessionInvalidated && hasCustodianUserInput(params)) {
          // Retained transcript rows are display context only; the next turn needs a fresh id.
          this.restartVolatileSession(client, this.variant, true);
          this.error = t("custodian.sessionRestarted", { error: custodianErrorMessage(error) });
        } else if (sessionInvalidated) {
          this.replaceSessionId();
          this.retryParams = { ...params, sessionId: this.sessionId };
          this.error = t("custodian.sessionRestarted", { error: custodianErrorMessage(error) });
        }
      }
      if (hasCustodianUserInput(params) && this.retryParams === params) {
        // User turns have no idempotency key and are never replayed after an ambiguous failure.
        this.retryParams = null;
      }
      return eventNudgeState.classifyCustodianSendFailure(error, delivery);
    } finally {
      if (this.requestAbort === requestAbort) {
        this.requestAbort = null;
      }
      if (epoch === this.requestEpoch) {
        this.sending = false;
      }
      this.emit();
    }
  }
}

export const custodianSessionStore = new CustodianSessionStore();
