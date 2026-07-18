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
