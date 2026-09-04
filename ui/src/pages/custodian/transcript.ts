import type {
  SystemAgentChatHistoryResult,
  SystemAgentChatHistoryTurn,
  SystemAgentChatResult,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
  type PanelRefreshStatus,
} from "../../components/panel-refresh-status.ts";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../lib/chat/message-visibility.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { renderChatDivider } from "../chat/components/chat-divider.ts";
import { renderMessageGroup } from "../chat/components/chat-message.ts";
import { renderCustodianQuestionCard } from "./custodian-question-card.ts";
import { parseCustodianQuestion, type CustodianStructuredQuestion } from "./structured-question.ts";

const CUSTODIAN_TRANSCRIPT_TIMEOUT_MS = 15_000;
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

export type CustodianMessage = {
  id: number;
  role: "assistant" | "user";
  text: string;
  at: number;
  question: CustodianStructuredQuestion | null;
  step: WizardStep | null;
};

export function createCustodianMessage(
  id: number,
  role: CustodianMessage["role"],
  text: string,
  question: CustodianStructuredQuestion | null = null,
  step: WizardStep | null = null,
): CustodianMessage {
  return { id, role, text, at: Date.now(), question, step };
}

export function createCustodianReplyMessage(
  id: number,
  result: SystemAgentChatResult,
): CustodianMessage | null {
  const step = result.step ?? null;
  const question = step ? null : parseCustodianQuestion(result.question);
  const silentReply = SILENT_REPLY_PATTERN.test(result.reply);
  return silentReply && !question && !step
    ? null
    : createCustodianMessage(id, "assistant", silentReply ? "" : result.reply, question, step);
}

export function hasUnresolvedCustodianQuestion(
  messages: readonly CustodianMessage[],
  dismissedQuestions: ReadonlySet<string>,
  answeredQuestions: ReadonlySet<string>,
  wizardInputPending: boolean,
  replyUncertain: boolean,
): boolean {
  return (
    wizardInputPending ||
    replyUncertain ||
    // buildSystemAgentGreetingQuestion emits suggestions, not pending input.
    // Like free text, diagnostics and nudges may replace those quick actions.
    messages.some(
      (message) =>
        message.question !== null &&
        message.question.id !== "system-agent-quick-actions" &&
        !dismissedQuestions.has(`${message.id}:${message.question.id}`) &&
        !answeredQuestions.has(`${message.id}:${message.question.id}`),
    )
  );
}

export function retireCustodianQuestions(
  messages: readonly CustodianMessage[],
  answeredQuestions: ReadonlySet<string>,
): Set<string> {
  const answered = new Set(answeredQuestions);
  for (const message of messages) {
    if (message.question) {
      answered.add(`${message.id}:${message.question.id}`);
    }
  }
  return answered;
}

export function custodianErrorMessage(error: unknown): string {
  return formatUiError(error, t("custodian.requestFailed"));
}

function toCustodianMessageGroup(message: CustodianMessage): MessageGroup {
  const key = `msg-${message.id}`;
  const rawMessage = { role: message.role, content: message.text };
  return {
    kind: "group",
    key,
    role: message.role,
    messages: [{ message: rawMessage, key }],
    visibleContent: resolveMessageVisibleContent(rawMessage, normalizeMessage(rawMessage)),
    timestamp: message.at,
    isStreaming: false,
  };
}

type CustodianTranscriptResult =
  | { ok: true; turns: SystemAgentChatHistoryResult["turns"] }
  | { ok: false; error: string };

async function readCustodianTranscript(
  client: GatewayBrowserClient,
): Promise<CustodianTranscriptResult> {
  try {
    const result = await client.request<SystemAgentChatHistoryResult>(
      "openclaw.chat.history",
      {},
      { timeoutMs: CUSTODIAN_TRANSCRIPT_TIMEOUT_MS },
    );
    return { ok: true, turns: result.turns };
  } catch (error) {
    return { ok: false, error: custodianErrorMessage(error) };
  }
}

export class CustodianTranscriptLoader {
  status: PanelRefreshStatus = createPanelRefreshStatus();
  private generation = 0;
  private inFlight: {
    client: GatewayBrowserClient;
    epoch: number;
    promise: Promise<CustodianTranscriptResult>;
  } | null = null;

  constructor(private readonly onStatusChange: () => void) {}

  get refreshing(): boolean {
    return this.inFlight !== null;
  }

  invalidate(): void {
    this.generation += 1;
    this.inFlight = null;
  }

  reset(): void {
    this.invalidate();
    this.status = createPanelRefreshStatus();
  }

  async read(
    client: GatewayBrowserClient,
    epoch: number,
    isCurrent: () => boolean,
  ): Promise<CustodianTranscriptResult | null> {
    const current = this.inFlight;
    if (current && current.client === client && current.epoch === epoch) {
      await current.promise;
      return null;
    }
    const generation = ++this.generation;
    this.status = beginPanelRefresh(this.status, { clearError: false });
    const promise = readCustodianTranscript(client);
    this.inFlight = { client, epoch, promise };
    this.onStatusChange();
    try {
      const result = await promise;
      if (!isCurrent() || generation !== this.generation) {
        return null;
      }
      this.status = result.ok
        ? completePanelRefresh()
        : failPanelRefresh(this.status, result.error);
      return result;
    } finally {
      if (this.inFlight?.promise === promise) {
        this.inFlight = null;
        this.onStatusChange();
      }
    }
  }

  async loadMessages(
    client: GatewayBrowserClient,
    epoch: number,
    firstMessageId: number,
    isCurrent: () => boolean,
  ): Promise<{ messages: CustodianMessage[]; nextMessageId: number } | null> {
    const result = await this.read(client, epoch, isCurrent);
    return result?.ok && isCurrent()
      ? createCustodianTranscriptMessages(result.turns, firstMessageId)
      : null;
  }
}

/**
 * Sensitive turns are masked server-side before persistence: the engine pushes
 * only "<redacted secret>" into history (never raw input), so durable turns
 * cannot carry credentials. This mapping only localizes that marker to the
 * same display text live sensitive replies use.
 */
const SERVER_SENSITIVE_MASK = "<redacted secret>";

function createCustodianTranscriptMessages(
  turns: readonly SystemAgentChatHistoryTurn[],
  firstMessageId: number,
): { messages: CustodianMessage[]; nextMessageId: number } {
  let nextMessageId = firstMessageId;
  const messages = turns.map((turn) => ({
    id: nextMessageId++,
    role: turn.role,
    text:
      turn.role === "user" && turn.text === SERVER_SENSITIVE_MASK
        ? t("custodian.sensitiveReply")
        : turn.text,
    at: turn.at,
    question: null,
    step: null,
  }));
  return { messages, nextMessageId };
}

function renderCustodianEarlierDivider(message: CustodianMessage, boundaryAfterId: number | null) {
  return message.id === boundaryAfterId
    ? renderChatDivider({
        kind: "divider",
        key: "custodian-earlier",
        label: t("custodian.earlier"),
        timestamp: message.at,
      })
    : nothing;
}

export function renderCustodianTranscriptEntry(params: {
  message: CustodianMessage;
  boundaryAfterId: number | null;
  assistantAvatar: string;
  showQuestion: boolean;
  questionDisabled: boolean;
  showWizardStep: boolean;
  wizardValue: unknown;
  wizardDisabled: boolean;
  wizardSecretVisible: boolean;
  showWizardCancel: boolean;
  onSelect: (label: string) => void;
  onSkip: () => void;
  onWizardValueChange: (value: unknown) => void;
  onWizardAnswer: (value: unknown) => void;
  onWizardCancel: () => void;
  onToggleWizardSecretVisibility: () => void;
}) {
  const question = params.message.question;
  const step = params.message.step;
  return html`
    ${
      params.message.text
        ? renderMessageGroup(toCustodianMessageGroup(params.message), {
            showReasoning: false,
            showToolCalls: false,
            assistantName: t("custodian.title"),
            assistantAvatar: params.assistantAvatar,
          })
        : nothing
    }
    ${renderCustodianEarlierDivider(params.message, params.boundaryAfterId)}
    ${
      params.showQuestion && question
        ? renderCustodianQuestionCard({
            question,
            disabled: params.questionDisabled,
            onSelect: params.onSelect,
            onSkip: params.onSkip,
          })
        : nothing
    }
    ${
      params.showWizardStep && step
        ? html`<section
            class="custodian__wizard-step"
            aria-label=${formatUiExternalText(step.title ?? step.message, "Setup")}
          >
            ${
              step.title
                ? html`<strong class="custodian__wizard-title"
                    >${formatUiExternalText(step.title)}</strong
                  >`
                : nothing
            }
            ${renderWizardStepControls({
              step,
              value: params.wizardValue,
              busy: params.wizardDisabled,
              inputId: `custodian-wizard-input-${params.message.id}`,
              sensitiveRevealed: params.wizardSecretVisible,
              onValueChange: params.onWizardValueChange,
              onAnswer: params.onWizardAnswer,
              leadingAction: params.showWizardCancel
                ? html`<button
                    class="btn btn--ghost custodian__wizard-cancel"
                    type="button"
                    ?disabled=${params.wizardDisabled}
                    @click=${params.onWizardCancel}
                  >
                    ${t("custodian.cancel")}
                  </button>`
                : undefined,
              onToggleSensitiveVisibility: params.onToggleWizardSecretVisibility,
            })}
          </section>`
        : nothing
    }
  `;
}
