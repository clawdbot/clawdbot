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
  channelData: { askUser: { questionId: string } };
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
    await params.onBlockReply({ text, presentation: options.presentation });
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
  // Button taps resolve atomically, so v1 keeps multi-question records text-only.
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
  // adapters can keep it while replacing the tap-only guidance below.
  const optionGuidance = [
    ...options.map(
      (option) =>
        `- ${formatText(option.label)}${option.description ? `: ${formatText(option.description)}` : ""}`,
    ),
    "",
    question.isOther
      ? "Tap an option, or reply with the option text or your own answer."
      : "Tap an option, or reply with the option number or text.",
  ].join("\n");
  return {
    blocks: [
      { type: "text", text: formatText(question.question) },
      { type: "text", text: optionGuidance },
      {
        type: "buttons",
        buttons: options.map((option) => ({
          label: formatText(option.label),
          action: {
            type: "question",
            questionId: params.questionId,
            optionValue: option.label,
          },
        })),
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
  return {
    text: `${prompt}\n\n${questionReplyGuidance(params.questions)}`,
    ...(presentation ? { presentation, presentationTextMode: "fallback" as const } : {}),
    channelData: { askUser: { questionId: params.questionId } },
  };
}

function questionReplyGuidance(questions: readonly AgentHarnessUserInputQuestion[]): string {
  if (questions.length !== 1) {
    return "Reply by number or question id. Use a declared option where choices are fixed.";
  }
  const [question] = questions;
  if (!question || (question.options?.length ?? 0) === 0) {
    return "Reply with your answer.";
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
    await params.onBlockReply(payload, signal ? { abortSignal: signal } : undefined);
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
      const answer = normalizeAgentHarnessUserInputAnswer(inputText, question);
      answers[question.id] = { answers: answer ? [answer] : [] };
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
    const normalized = answer ? normalizeAgentHarnessUserInputAnswer(answer, question) : undefined;
    answers[question.id] = { answers: normalized ? [normalized] : [] };
  });
  return { answers };
}

export function normalizeAgentHarnessUserInputAnswer(
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
  if (options.length > 0 && !question.isOther) {
    return undefined;
  }
  return trimmed || undefined;
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
