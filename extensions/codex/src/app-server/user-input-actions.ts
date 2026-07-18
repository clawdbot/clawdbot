import crypto from "node:crypto";
import type { AgentHarnessUserInputQuestion } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";

export type CodexUserInputActionAnswer =
  | { type: "choice"; optionIndex: number }
  | { type: "answers"; answers: Record<string, string> };

type PendingAnswer = (answer: CodexUserInputActionAnswer) => boolean;

const pendingAnswers = new Map<string, PendingAnswer>();

export function registerCodexUserInputActions(answer: PendingAnswer): {
  token: string;
  dispose: () => void;
} {
  const token = crypto.randomUUID();
  pendingAnswers.set(token, answer);
  return {
    token,
    dispose: () => pendingAnswers.delete(token),
  };
}

export function resolveCodexUserInputAction(
  token: string,
  answer: CodexUserInputActionAnswer,
): boolean {
  const pending = pendingAnswers.get(token);
  if (!pending || !pending(answer)) {
    return false;
  }
  pendingAnswers.delete(token);
  return true;
}

export function buildCodexUserInputPresentation(
  questions: readonly AgentHarnessUserInputQuestion[],
  token: string,
): MessagePresentation | undefined {
  const question = questions.length === 1 ? questions[0] : undefined;
  if (!question || question.isSecret || !question.options?.length) {
    return undefined;
  }
  return {
    title: question.header,
    tone: "info",
    blocks: [
      {
        type: "buttons",
        buttons: question.options.map((option, index) => {
          const action = {
            type: "command",
            command: `/codex answer ${token} choice:${index}`,
          } as const;
          return index === 0
            ? { label: option.label, action, style: "primary" as const }
            : { label: option.label, action };
        }),
      },
    ],
  };
}

export function parseCodexUserInputActionAnswer(
  encoded: string,
): CodexUserInputActionAnswer | undefined {
  const choiceMatch = encoded.match(/^choice:(\d+)$/u);
  if (choiceMatch) {
    const optionIndex = Number(choiceMatch[1]);
    return Number.isSafeInteger(optionIndex) ? { type: "choice", optionIndex } : undefined;
  }
  if (!encoded.startsWith("answers:")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(encoded.slice("answers:".length)));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.some(([key, value]) => !key || typeof value !== "string")) {
    return undefined;
  }
  return { type: "answers", answers: Object.fromEntries(entries) };
}
