import type { SystemAgentChatParams, SystemAgentChatResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import { pathForCustodianAgentHandoff } from "./custodian-navigation.ts";
import * as eventNudgeState from "./event-nudge.ts";
import {
  custodianChatParams,
  isCustodianSessionInvalidatedError,
  type CustodianSessionVariant,
} from "./session-lifecycle.ts";
import { parseCustodianQuestion, type CustodianStructuredQuestion } from "./structured-question.ts";
import {
  createCustodianSessionId,
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

/** One process-local conversation owner shared by the full page and dock surface. */
export class CustodianSessionStore {
  messages: CustodianMessage[] = [];
  input = "";
  sending = false;
  sensitive = false;
  wizardInputPending = false;
  questionReplyUncertain = false;
  error: string | null = null;
  dismissedQuestions = new Set<string>();
  answeredQuestions = new Set<string>();
  activeClient: GatewayBrowserClient | null = null;
  chatAvailable = false;
  eventNudge: eventNudgeState.CustodianEventNudge | null = null;
  eventNudgePending: eventNudgeState.CustodianEventNudge | null = null;
  earlierBoundaryAfterId: number | null = null;
  abandonedTurnOutcomeUnknown = false;

  private context: ApplicationContext | null = null;
  private variant: CustodianSessionVariant = "caretaker";
  private sessionVariant: CustodianSessionVariant | null = null;
  private sessionId = createCustodianSessionId();
  private requestEpoch = 0;
  private nextMessageId = 1;
  private retryParams: SystemAgentChatParams | null = null;
  private sessionClient: GatewayBrowserClient | null = null;
  private sessionOwnershipKey: string | null = null;
  private sessionStarted = false;
  private lastHelloDeviceToken = "";
  private eventNudgeClosed = false;
  private gatewayCleanup: (() => void) | null = null;
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
      this.eventCleanup?.();
      this.context = context;
      this.gatewayCleanup = context.gateway.subscribe(() => {
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

  canRetry(): boolean {
    return this.retryParams !== null && this.retryParams.message === undefined;
  }

  retry(): void {
    const client = this.activeClient;
    const params = this.retryParams;
    if (client && params && params.message === undefined && this.chatAvailable && !this.sending) {
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
    const questionState = [this.answeredQuestions, this.questionReplyUncertain] as const;
    if (questionReply) {
      this.questionReplyUncertain = true;
    }
    if (!message.trim() || !client || !this.chatAvailable || this.sending) {
      this.emit();
      return "rejected";
    }
    const displayText = this.sensitive ? t("custodian.sensitiveReply") : (display ?? message);
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
    this.emit();
    const reply = this.requestReply(client, {
      sessionId: this.sessionId,
      ...custodianChatParams(this.variant, message),
    });
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

  exitSetup(): void {
    this.context?.navigate("chat");
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private currentSessionOwnershipKey(): string {
    const context = this.context;
    if (!context) {
      return "";
    }
    const { gatewayUrl, token, password, bootstrapToken } = context.gateway.connection;
    const auth = context.gateway.snapshot.hello?.auth;
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
      { sessionId: this.sessionId, ...custodianChatParams(variant) },
      loadTranscript,
    );
  }

  private abandonPendingUserTurn(pendingParams: SystemAgentChatParams | null): void {
    if (pendingParams?.message === undefined) {
      return;
    }
    this.retryParams = null;
    // The gateway may already have acted, so keep the warning without retaining replayable text.
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
    const context = this.context;
    if (!context) {
      return;
    }
    const snapshot = context.gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const chatSupported =
      client !== null && isGatewayMethodAdvertised(snapshot, "openclaw.chat") === true;
    const variantChanged = this.sessionStarted && this.sessionVariant !== this.variant;
    const ownershipKey = this.currentSessionOwnershipKey();
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
      this.chatAvailable === chatSupported
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
      // A different operator or route mode must never inherit retained live context.
      [this.eventNudge, this.eventNudgePending] = [null, null];
      this.eventNudgeClosed = false;
      this.abandonedTurnOutcomeUnknown = false;
      this.sessionStarted = false;
      this.clearConversation();
    } else if (client && clientReplaced) {
      if (!chatSupported) {
        this.sessionStarted = false;
        this.abandonPendingUserTurn(pendingParams);
        this.error = t("custodian.unsupportedGateway");
        return;
      }
      this.chatAvailable = true;
      this.abandonPendingUserTurn(pendingParams);
      this.rotateVolatileSession(client, this.currentSessionVariant());
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
        this.error = requestWasPending ? this.error : null;
      }
      return;
    }
    this.clearConversation();
    this.startSession(client, this.currentSessionVariant(), true);
  }

  private currentSessionVariant(): CustodianSessionVariant {
    return this.variant;
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
  ): Promise<void> {
    const context = this.context;
    if (
      !context ||
      isGatewayMethodAdvertised(context.gateway.snapshot, "openclaw.chat.history") !== true
    ) {
      return;
    }
    const turns = await readCustodianTranscript(client);
    if (turns === null || epoch !== this.requestEpoch || client !== this.activeClient) {
      return;
    }
    const transcript = createCustodianTranscriptMessages(turns, this.nextMessageId);
    this.messages = transcript.messages;
    this.nextMessageId = transcript.nextMessageId;
    this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
    this.emit();
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
    const context = this.context;
    if (!context) {
      return "rejected";
    }
    const epoch = ++this.requestEpoch;
    let delivery: eventNudgeState.CustodianSendDelivery = "unsent";
    this.sending = true;
    this.error = null;
    this.retryParams = params;
    this.emit();
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
      const silentReply = SILENT_REPLY_PATTERN.test(result.reply);
      if (!silentReply || question) {
        this.appendAssistant(silentReply ? "" : result.reply, question);
      }
      if (result.action === "open-agent") {
        let sessionKey = context.gateway.snapshot.sessionKey?.trim();
        if (result.agentId) {
          const roster = await context.agents.refreshList();
          if (epoch !== this.requestEpoch || client !== this.activeClient) {
            return "sent";
          }
          sessionKey = buildAgentMainSessionKey({
            agentId: result.agentId,
            mainKey: roster?.mainKey,
          });
          selectApplicationSession({
            selection: context.agentSelection,
            gateway: context.gateway,
            sessionKey,
            agentId: result.agentId,
          });
        }
        if (result.agentDraft === "hatch" && sessionKey) {
          context.navigate("chat", {
            pathname: pathForCustodianAgentHandoff(context, sessionKey),
            search: `?draft=${encodeURIComponent(t("custodian.hatchDraft"))}`,
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
          // Retained transcript rows are display context only; the next turn needs a fresh id.
          this.rotateVolatileSession(client, this.currentSessionVariant());
          this.error = t("custodian.sessionRestarted", { error: custodianErrorMessage(error) });
        }
      }
      if (params.message !== undefined && this.retryParams === params) {
        // User turns have no idempotency key and are never replayed after an ambiguous failure.
        this.retryParams = null;
      }
      return eventNudgeState.classifyCustodianSendFailure(error, delivery);
    } finally {
      if (epoch === this.requestEpoch) {
        this.sending = false;
      }
      this.emit();
    }
  }
}

export const custodianSessionStore = new CustodianSessionStore();
