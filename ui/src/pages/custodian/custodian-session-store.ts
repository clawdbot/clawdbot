import type { SystemAgentChatParams, SystemAgentChatResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { CustodianTurnAdmission } from "../../components/custodian-alert-contract.ts";
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
  custodianFailure,
  hasCustodianUserInput,
  type CustodianSessionVariant,
} from "./session-lifecycle.ts";
import {
  createCustodianMessage,
  createCustodianReplyMessage,
  custodianErrorMessage,
  CustodianTranscriptLoader,
  hasUnresolvedCustodianQuestion,
  retireCustodianQuestions,
  type CustodianMessage,
} from "./transcript.ts";

const SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;

type StoreListener = () => void;

/** One process-local conversation owner shared by the full page and dock surface. */
export class CustodianSessionStore {
  messages: CustodianMessage[] = [];
  sending = false;
  sensitive = false;
  wizardInputPending = false;
  wizardValue: unknown;
  wizardSecretVisible = false;
  questionReplyUncertain = false;
  error: string | null = null;
  transcript = new CustodianTranscriptLoader(() => this.emit());
  dismissedQuestions = new Set<string>();
  answeredQuestions = new Set<string>();
  activeClient: GatewayBrowserClient | null = null;
  chatAvailable = false;
  eventNudge: eventNudgeState.CustodianEventNudge | null = null;
  eventNudgePending: eventNudgeState.CustodianEventNudge | null = null;
  channelOnboardingNudgeClosed = false;
  earlierBoundaryAfterId: number | null = null;
  abandonedTurnOutcomeUnknown = false;

  private inferenceState: "unverified" | "ready" = "unverified";
  private inputDrafts = { ordinary: { value: "" }, sensitive: { value: "" } };
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

  get input(): string {
    return this.inputDrafts[this.sensitive ? "sensitive" : "ordinary"].value;
  }

  set input(value: string) {
    this.inputDrafts[this.sensitive ? "sensitive" : "ordinary"] = { value };
  }

  setInput(value: string): void {
    this.input = value;
    this.emit();
  }

  private resetPromptInput(sensitive: boolean): void {
    // Retire prompt input at admission or replacement, even if the reply fails.
    // Ordinary composer drafts survive explicit actions and prompt replacement.
    this.inputDrafts.sensitive = { value: "" };
    [this.wizardValue, this.wizardSecretVisible] = [undefined, false];
    this.sensitive = sensitive;
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
    if (!client || !this.canRefreshTranscript()) {
      return;
    }
    const refreshed = await this.refreshTranscriptHistory(client, this.requestEpoch);
    if (refreshed && this.abandonedTurnOutcomeUnknown) {
      this.abandonedTurnOutcomeUnknown = false;
      this.emit();
    }
  }

  canRefreshTranscript(): boolean {
    // hasUnresolvedQuestion() also covers a pending wizard step.
    const blocked = this.sending || this.hasUnresolvedQuestion() || this.transcript.refreshing;
    return this.activeClient !== null && this.sessionStarted && this.chatAvailable && !blocked;
  }

  canRetry(): boolean {
    return this.retryParams !== null && !hasCustodianUserInput(this.retryParams);
  }

  get setupRequired(): boolean {
    return this.configuredInferenceState === "required";
  }

  get canSend(): boolean {
    return (
      this.activeClient !== null &&
      this.chatAvailable &&
      !this.sending &&
      this.configuredInferenceState === "ready" &&
      this.inferenceState === "ready"
    );
  }

  get wizardCancelAvailable(): boolean {
    return isCustodianWizardCancelAvailable(this.context);
  }

  retry(): void {
    const client = this.activeClient;
    const params = this.retryParams;
    if (client && params && !hasCustodianUserInput(params) && this.chatAvailable && !this.sending) {
      void this.initializeSession(client, params, false);
    }
  }

  async send(
    text?: string,
    display?: string,
    questionReply = this.hasUnresolvedQuestion(),
    admission?: CustodianTurnAdmission,
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    // Trim decides emptiness only; sensitive values may carry meaningful whitespace.
    const input = text ?? this.input;
    const message = this.sensitive ? input : input.trim();
    const client = this.activeClient;
    if (!message.trim() || !client || !this.canSend) {
      this.emit();
      return "rejected";
    }
    const displayText = this.sensitive ? t("custodian.sensitiveReply") : (display ?? message);
    const params = { sessionId: this.sessionId, ...custodianChatParams(this.variant, message) };
    return await this.sendUserTurn(client, params, displayText, questionReply, () => {
      if (admission && (!admission.isCurrent() || !admission.admit())) {
        return false;
      }
      // Explicit actions do not submit the operator's unsent composer draft.
      if (text === undefined) {
        this.input = "";
      }
      return true;
    });
  }

  private async sendUserTurn(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    displayText: string,
    questionReply: boolean,
    admit?: () => boolean,
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    const questionState = [this.answeredQuestions, this.questionReplyUncertain] as const;
    let replyEpoch: number | undefined;
    const reply = this.requestReply(client, params, () => {
      const ordinaryDraft = this.inputDrafts.ordinary;
      if (admit && !admit()) {
        return false;
      }
      const consumedDraft = this.inputDrafts.ordinary;
      this.resetPromptInput(this.sensitive);
      replyEpoch = this.requestEpoch;
      if (questionReply) {
        this.questionReplyUncertain = true;
      }
      this.abandonedTurnOutcomeUnknown = false;
      this.answeredQuestions = retireCustodianQuestions(this.messages, this.answeredQuestions);
      const message = createCustodianMessage(this.nextMessageId++, "user", displayText);
      this.messages = [...this.messages, message];
      return () => {
        this.messages = this.messages.filter((entry) => entry !== message);
        this.answeredQuestions = questionState[0];
        if (ordinaryDraft !== consumedDraft && this.inputDrafts.ordinary === consumedDraft) {
          this.inputDrafts.ordinary = ordinaryDraft;
        }
      };
    });
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
    if (!submission || !client || !this.canSend) {
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
      !this.canSend ||
      !this.wizardCancelAvailable
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
    this.advanceRequestEpoch();
    this.sending = false;
    this.questionReplyUncertain = false;
    this.retryParams = null;
    this.error = null;
  }

  private advanceRequestEpoch(): number {
    this.transcript.invalidate();
    return ++this.requestEpoch;
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

  private startSession(client: GatewayBrowserClient, loadTranscript: boolean): void {
    this.sessionVariant = this.variant;
    this.sessionClient = client;
    this.sessionOwnershipKey = this.sessionOwner.key(this.context?.gateway ?? null);
    this.sessionStarted = true;
    void this.initializeSession(
      client,
      { sessionId: this.sessionId, ...custodianChatParams(this.variant) },
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

  private restartVolatileSession(client: GatewayBrowserClient): void {
    this.replaceSessionId();
    this.answeredQuestions = retireCustodianQuestions(this.messages, this.answeredQuestions);
    this.resetPromptInput(false);
    this.wizardInputPending = this.questionReplyUncertain = false;
    this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
    this.startSession(client, false);
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
    this.advanceRequestEpoch();
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
      return;
    }
    if (this.sessionStarted) {
      if (!this.retryParams) {
        this.error = requestWasPending ? this.error : null;
      }
      return;
    }
    this.clearConversation();
    this.startSession(client, true);
  }

  private async initializeSession(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    loadTranscript = true,
  ): Promise<void> {
    const epoch = this.advanceRequestEpoch();
    this.sending = true;
    this.inferenceState = "unverified";
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
    const isCurrent = () => epoch === this.requestEpoch && client === this.activeClient;
    const transcript = await this.transcript.loadMessages(
      client,
      epoch,
      this.nextMessageId,
      isCurrent,
    );
    if (!transcript) {
      return false;
    }
    [this.messages, this.nextMessageId] = [transcript.messages, transcript.nextMessageId];
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
    this.transcript.reset();
    this.inferenceState = "unverified";
    this.inputDrafts.ordinary = { value: "" };
    this.resetPromptInput(false);
    this.wizardInputPending = this.questionReplyUncertain = false;
    this.earlierBoundaryAfterId = null;
  }

  private async requestReply(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    admit?: () => false | (() => void),
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    const context = this.context;
    if (!context) {
      return "rejected";
    }
    const canRequest = () =>
      client === this.activeClient &&
      context.gateway.snapshot.client === client &&
      canCallGatewayMethod(context.gateway.snapshot, "openclaw.chat", "operator.admin");
    if (!canRequest()) {
      return "rejected";
    }
    this.requestAbort?.abort();
    const requestAbort = new AbortController();
    this.requestAbort = requestAbort;
    const epoch = this.advanceRequestEpoch();
    let delivery: eventNudgeState.CustodianSendDelivery = "unsent";
    let rollbackUnsent: false | (() => void) | undefined;
    this.sending = true;
    this.error = null;
    this.retryParams = params;
    this.emit();
    try {
      if (epoch !== this.requestEpoch || !canRequest() || (rollbackUnsent = admit?.()) === false) {
        if (this.retryParams === params) {
          this.retryParams = null;
        }
        return "rejected";
      }
      // Admission publishes the turn; dispatch before observers can rotate its owner.
      const pending = client.request<SystemAgentChatResult>("openclaw.chat", params, {
        timeoutMs: SYSTEM_AGENT_CHAT_TIMEOUT_MS,
        onSent: () => {
          delivery = "sent";
        },
        signal: requestAbort.signal,
      });
      this.emit();
      const result = await pending;
      delivery = "received";
      if (epoch !== this.requestEpoch || client !== this.activeClient) {
        return "sent";
      }
      this.replaceSessionId(result.sessionId);
      this.resetPromptInput(result.sensitive === true);
      this.wizardInputPending = result.wizardInputPending === true;
      this.retryParams = null;
      this.inferenceState = "ready";
      if (this.rejoinBarrierPending && !hasCustodianUserInput(params)) {
        // Rejoin barrier: this input-free request queued behind any in-flight
        // turn on the Gateway's per-session queue, so refreshing here shows
        // rows a racing turn persisted after the initial history fetch. Runs
        // before the reply/control is appended, so a projected live wizard or
        // question renders on top of the reconciled rows. Once per restored id.
        this.rejoinBarrierPending = false;
        await this.refreshTranscriptHistory(client, epoch);
        if (epoch !== this.requestEpoch || client !== this.activeClient) {
          return "sent";
        }
      }
      this.wizardValue = result.step ? initialCustodianWizardValue(result.step) : undefined;
      const message = createCustodianReplyMessage(this.nextMessageId, result);
      if (message) {
        this.nextMessageId += 1;
        this.messages = [...this.messages, message];
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
        // Only a known-unsent turn may restore its unchanged draft; newer edits,
        // receipts, sensitive input and replacement conversations stay untouched.
        if (delivery === "unsent" && rollbackUnsent) {
          rollbackUnsent();
        }
        this.error = custodianErrorMessage(error);
        const { inferenceUnavailable, sessionInvalidated } = custodianFailure(error);
        if (inferenceUnavailable) {
          this.inferenceState = "unverified";
          // Recheck the runtime without replaying a user turn that may have reached the Gateway.
          this.retryParams = { sessionId: this.sessionId, ...custodianChatParams(this.variant) };
        }
        if (sessionInvalidated && hasCustodianUserInput(params)) {
          // Retained transcript rows are display context only; the next turn needs a fresh id.
          this.restartVolatileSession(client);
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
