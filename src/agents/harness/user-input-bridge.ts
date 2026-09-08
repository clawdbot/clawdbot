import { markReplyPayloadForSourceSuppressionDelivery } from "../../auto-reply/reply-payload.js";
import { runWithQuestionChannelDeliveries } from "../../infra/question-channel-runtime.js";
import type { MessagePresentation } from "../../interactive/payload.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";

export type AgentHarnessUserInputOption = {
  label: string;
  description?: string;
};

export type AgentHarnessUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  options?: readonly AgentHarnessUserInputOption[] | null;
};

export type AgentHarnessUserInputAnswers = {
  answers: Record<string, { answers: string[] }>;
};

export type AgentHarnessUserInputPromptOptions = {
  intro?: string;
  formatText?: (text: string) => string;
  secretWarning?: string;
  otherLabel?: string;
  presentation?: MessagePresentation;
};

type AgentHarnessQuestionPromptPayload = {
  text: string;
  presentation?: MessagePresentation;
  presentationTextMode?: "fallback";
  channelData: {
    askUser: { questionId: string; optionValues?: string[] };
  };
};

type PromptDeliveryParams = Pick<EmbeddedRunAttemptParams, "onBlockReply" | "onPartialReply">;

export function emptyAgentHarnessUserInputAnswers(): AgentHarnessUserInputAnswers {
  return { answers: {} };
}

export function formatAgentHarnessUserInputPrompt(
  questions: readonly AgentHarnessUserInputQuestion[],
  options: AgentHarnessUserInputPromptOptions = {},
): string {
  const formatText = options.formatText ?? ((text: string) => text);
  const lines = [options.intro ?? "Agent needs input:"];
  questions.forEach((question, index) => {
    if (questions.length > 1) {
      lines.push("", `${index + 1}. ${formatText(question.header)}`, formatText(question.question));
    } else {
      lines.push("", formatText(question.header), formatText(question.question));
    }
    if (question.isSecret) {
      lines.push(
        options.secretWarning ?? "This channel may show your reply to other participants.",
      );
    }
    question.options?.forEach((option, optionIndex) => {
      lines.push(
        `${optionIndex + 1}. ${formatText(option.label)}${
          option.description ? ` - ${formatText(option.description)}` : ""
        }`,
      );
    });
    if (question.isOther) {
      lines.push(options.otherLabel ?? "Other: reply with your own answer.");
    }
  });
  return lines.join("\n");
}

export async function deliverAgentHarnessUserInputPrompt(
  params: PromptDeliveryParams,
  questions: readonly AgentHarnessUserInputQuestion[],
  options: AgentHarnessUserInputPromptOptions = {},
): Promise<void> {
  const text = formatAgentHarnessUserInputPrompt(questions, options);
  if (params.onBlockReply) {
    await params.onBlockReply(
      markReplyPayloadForSourceSuppressionDelivery({ text, presentation: options.presentation }),
    );
    return;
  }
  await params.onPartialReply?.({ text });
}

/** Builds the portable one-question presentation shared by tools and harnesses. */
function buildAgentHarnessQuestionPresentation(params: {
  questionId: string;
  questions: readonly AgentHarnessUserInputQuestion[];
  formatText?: (text: string) => string;
}): MessagePresentation | undefined {
  // Button taps resolve atomically, so multi-question and multi-select records
  // remain text-only until partial answer state has one shared owner.
  if (params.questions.length !== 1) {
    return undefined;
  }
  const [question] = params.questions;
  const options = question?.options ?? [];
  const formatText = params.formatText ?? ((text: string) => text);
  if (!question || question.multiSelect || question.isSecret || options.length === 0) {
    return undefined;
  }
  // The question stays in its own leading text block so reaction/native
  // adapters can keep it while replacing the reply guidance below.
  const optionGuidance = [
    ...options.map(
      (option) =>
        `- ${formatText(option.label)}${option.description ? `: ${formatText(option.description)}` : ""}`,
    ),
    "",
    questionReplyGuidance(params.questions),
  ].join("\n");
  return {
    blocks: [
      { type: "text", text: formatText(question.question) },
      { type: "text", text: optionGuidance },
      {
        type: "buttons",
        buttons: [
          ...options.map((option) => ({
            label: formatText(option.label),
            action: {
              type: "question" as const,
              questionId: params.questionId,
              optionValue: option.label,
            },
          })),
          ...(question.isOther
            ? [
                {
                  label: "Other…",
                  action: {
                    type: "question" as const,
                    questionId: params.questionId,
                    intent: "custom-input" as const,
                  },
                },
              ]
            : []),
        ],
      },
    ],
  };
}

/** Builds the exact question payload consumed by web chat and native channels. */
export function buildAgentHarnessQuestionPromptPayload(params: {
  questionId: string;
  questions: readonly AgentHarnessUserInputQuestion[];
  options?: AgentHarnessUserInputPromptOptions;
}): AgentHarnessQuestionPromptPayload {
  const prompt = formatAgentHarnessUserInputPrompt(params.questions, params.options);
  // Callers may supply a fully-authored presentation; only build one otherwise.
  const presentation =
    params.options?.presentation ??
    buildAgentHarnessQuestionPresentation({
      ...params,
      formatText: params.options?.formatText,
    });
  const [question] = params.questions;
  const candidateOptionValues =
    params.questions.length === 1 && question && !question.multiSelect && !question.isSecret
      ? (question.options?.map((option) => option.label) ?? [])
      : [];
  const normalizedOptionValues = candidateOptionValues.map((option) => option.trim().toLowerCase());
  const optionValues =
    candidateOptionValues.length >= 2 &&
    candidateOptionValues.length <= 4 &&
    normalizedOptionValues.every(Boolean) &&
    new Set(normalizedOptionValues).size === candidateOptionValues.length
      ? candidateOptionValues
      : undefined;
  return markReplyPayloadForSourceSuppressionDelivery({
    text: `${prompt}\n\n${questionReplyGuidance(params.questions)}`,
    ...(presentation ? { presentation, presentationTextMode: "fallback" as const } : {}),
    // Native callbacks need Gateway option order even when presentation controls are reordered.
    channelData: {
      askUser: { questionId: params.questionId, ...(optionValues ? { optionValues } : {}) },
    },
  });
}

function questionReplyGuidance(questions: readonly AgentHarnessUserInputQuestion[]): string {
  if (questions.length !== 1) {
    return "Reply by number or question id. Use a declared option where choices are fixed.";
  }
  const [question] = questions;
  if (!question || (question.options?.length ?? 0) === 0) {
    return "Reply with your answer.";
  }
  if (question.multiSelect) {
    return "Reply with comma-separated option numbers or text, or your own answer.";
  }
  return question.isOther
    ? "Reply with the number, the option text, or your own answer."
    : "Reply with the number or option text.";
}

/** Delivers a gateway-backed question through the harness block-reply surface. */
export async function deliverAgentHarnessQuestionPrompt(
  params: PromptDeliveryParams,
  questionId: string,
  questions: readonly AgentHarnessUserInputQuestion[],
  options?: AgentHarnessUserInputPromptOptions,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const payload = buildAgentHarnessQuestionPromptPayload({ questionId, questions, options });
  if (params.onBlockReply) {
    // The agent cannot finish until this prompt is answered. Give channel delivery
    // an independent stable intent so it does not wait behind the blocked stream.
    await runWithQuestionChannelDeliveries([questionId], () =>
      params.onBlockReply?.(payload, {
        ...(signal ? { abortSignal: signal } : {}),
        deliveryIntentId: `block-reply:v1:agent-question:${questionId}`,
      }),
    );
    return;
  }
  signal?.throwIfAborted();
  await params.onPartialReply?.({ text: payload.text });
}

export function buildAgentHarnessUserInputAnswers(
  questions: readonly AgentHarnessUserInputQuestion[],
  inputText: string,
): AgentHarnessUserInputAnswers {
  const answers: AgentHarnessUserInputAnswers["answers"] = {};
  if (questions.length === 1) {
    const question = questions[0];
    if (question) {
      answers[question.id] = {
        answers: normalizeAgentHarnessUserInputAnswers(inputText, question),
      };
    }
    return { answers };
  }

  const keyed = parseKeyedAnswers(inputText);
  // Unkeyed multi-question replies are positional. Preserve blank lines so a
  // skipped answer cannot shift every later response onto the wrong question.
  const fallbackLines = inputText.split(/\r?\n/).map((line) => line.trim());
  questions.forEach((question, index) => {
    const key =
      keyed.get(question.id.toLowerCase()) ??
      keyed.get(question.header.toLowerCase()) ??
      keyed.get(question.question.toLowerCase()) ??
      keyed.get(String(index + 1));
    const answer = key ?? fallbackLines[index] ?? "";
    answers[question.id] = {
      answers: answer ? normalizeAgentHarnessUserInputAnswers(answer, question) : [],
    };
  });
  return { answers };
}

function normalizeAgentHarnessUserInputAnswers(
  answer: string,
  question: AgentHarnessUserInputQuestion,
): string[] {
  if (!question.multiSelect) {
    const normalized = normalizeAgentHarnessUserInputAnswer(answer, question);
    return normalized ? [normalized] : [];
  }
  // A declared label can contain list delimiters. Match it whole before
  // splitting a reply that selects several options.
  const declaredAnswer = normalizeAgentHarnessUserInputOption(answer, question);
  if (declaredAnswer) {
    return [declaredAnswer];
  }
  const normalized = answer
    .split(/[,;\n]/u)
    .map((part) => normalizeAgentHarnessUserInputAnswer(part, question))
    .filter((part): part is string => Boolean(part));
  return [...new Set(normalized)];
}

export function normalizeAgentHarnessUserInputAnswer(
  answer: string,
  question: AgentHarnessUserInputQuestion,
): string | undefined {
  const trimmed = answer.trim();
  const declaredAnswer = normalizeAgentHarnessUserInputOption(trimmed, question);
  if (declaredAnswer) {
    return declaredAnswer;
  }
  if ((question.options?.length ?? 0) > 0 && !question.isOther) {
    return undefined;
  }
  return trimmed || undefined;
}

function normalizeAgentHarnessUserInputOption(
  answer: string,
  question: AgentHarnessUserInputQuestion,
): string | undefined {
  const trimmed = answer.trim();
  const options = question.options ?? [];
  // Numeric replies use the one-based option numbers emitted in the prompt.
  // Convert to zero-based only at the options-array boundary.
  const optionIndex = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
  const indexed = optionIndex >= 0 ? options[optionIndex] : undefined;
  if (indexed) {
    return indexed.label;
  }
  const exact = options.find((option) => option.label.toLowerCase() === trimmed.toLowerCase());
  if (exact) {
    return exact.label;
  }
  return undefined;
}

function parseKeyedAnswers(inputText: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const line of inputText.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:=-]+?)\s*[:=-]\s*(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const key = match[1]?.trim().toLowerCase();
    const value = match[2]?.trim();
    if (key && value) {
      answers.set(key, value);
    }
  }
  return answers;
}
