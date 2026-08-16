import type {
  SystemAgentChatHistoryResult,
  SystemAgentChatHistoryTurn,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { renderChatDivider } from "../chat/components/chat-divider.ts";
import { renderMessageGroup } from "../chat/components/chat-message.ts";
import { renderCustodianQuestionCard } from "./custodian-question-card.ts";
import type { CustodianStructuredQuestion } from "./structured-question.ts";

const CUSTODIAN_TRANSCRIPT_TIMEOUT_MS = 15_000;

export type CustodianMessage = {
  id: number;
  role: "assistant" | "user";
  text: string;
  at: number;
  question: CustodianStructuredQuestion | null;
  step: WizardStep | null;
};

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
    messages.some(
      (message) =>
        message.question !== null &&
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

export function createCustodianSessionId(): string {
  if (typeof crypto.randomUUID === "function") {
    return `control-ui-onboarding-${crypto.randomUUID()}`;
  }
  const suffix = [...crypto.getRandomValues(new Uint32Array(4))]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
  return `control-ui-onboarding-${suffix}`;
}

export function custodianErrorMessage(error: unknown): string {
  return formatUiError(error, t("custodian.requestFailed"));
}

function toCustodianMessageGroup(message: CustodianMessage): MessageGroup {
  const key = `msg-${message.id}`;
  return {
    kind: "group",
    key,
    role: message.role,
    messages: [{ message: { role: message.role, content: message.text }, key }],
    timestamp: message.at,
    isStreaming: false,
  };
}

export async function readCustodianTranscript(
  client: GatewayBrowserClient,
): Promise<SystemAgentChatHistoryResult["turns"] | null> {
  try {
    return (
      await client.request<SystemAgentChatHistoryResult>(
        "openclaw.chat.history",
        {},
        {
          timeoutMs: CUSTODIAN_TRANSCRIPT_TIMEOUT_MS,
        },
      )
    ).turns;
  } catch {
    return null;
  }
}

/**
 * Sensitive turns are masked server-side before persistence: the engine pushes
 * only "<redacted secret>" into history (never raw input), so durable turns
 * cannot carry credentials. This mapping only localizes that marker to the
 * same display text live sensitive replies use.
 */
const SERVER_SENSITIVE_MASK = "<redacted secret>";

export function createCustodianTranscriptMessages(
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
    ${params.message.text
      ? renderMessageGroup(toCustodianMessageGroup(params.message), {
          showReasoning: false,
          showToolCalls: false,
          assistantName: t("custodian.title"),
          assistantAvatar: params.assistantAvatar,
        })
      : nothing}
    ${renderCustodianEarlierDivider(params.message, params.boundaryAfterId)}
    ${params.showQuestion && question
      ? renderCustodianQuestionCard({
          question,
          disabled: params.questionDisabled,
          onSelect: params.onSelect,
          onSkip: params.onSkip,
        })
      : nothing}
    ${params.showWizardStep && step
      ? html`<section
          class="custodian__wizard-step"
          aria-label=${step.title ?? step.message ?? "Setup"}
        >
          ${step.title
            ? html`<strong class="custodian__wizard-title">${step.title}</strong>`
            : nothing}
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
      : nothing}
  `;
}
