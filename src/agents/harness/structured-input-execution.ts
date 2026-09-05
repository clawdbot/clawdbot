import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/schema/questions.js";
import { runAgentHarnessGatewayQuestion } from "./gateway-question.js";
import type {
  StructuredInputAnswerValue,
  StructuredInputCompileResult,
  StructuredInputField,
} from "./structured-input.js";
import {
  deliverAgentHarnessUserInputPrompt,
  type AgentHarnessUserInputPromptOptions,
  type AgentHarnessUserInputQuestion,
} from "./user-input-bridge.js";

const QUESTION_BATCH_SIZE = 3;
const STATUS_TEXT_LIMIT = 1_024;

type StructuredInputExecutionResult =
  | {
      status: "answered";
      answers: Record<string, string[]>;
      content: Record<string, StructuredInputAnswerValue>;
    }
  | { status: "declined"; message?: string }
  | { status: "cancelled"; message?: string }
  | { status: "unsupported"; message: string };

type StructuredInputExecutionParams = {
  input: StructuredInputCompileResult;
  sessionKey: string;
  agentId?: string;
  runId?: string;
  timeoutMs: number;
  gatewayCall?: Parameters<typeof runAgentHarnessGatewayQuestion>[0]["gatewayCall"];
  delivery: Parameters<typeof runAgentHarnessGatewayQuestion>[0]["delivery"];
  signal?: AbortSignal;
  isActive?: () => boolean;
  questionId?: (batch: number) => string | undefined;
  promptOptions?: AgentHarnessUserInputPromptOptions & {
    unsupportedIntro?: string;
    urlIntro?: string;
  };
};

/** Executes one compiled form or URL with shared batching, secret, and fencing semantics. */
export async function runStructuredInput(
  params: StructuredInputExecutionParams,
): Promise<StructuredInputExecutionResult> {
  if (params.input.kind === "unsupported") {
    await showStatus(params, params.input.message);
    return { status: "unsupported", message: params.input.message };
  }
  if (!isActive(params)) {
    return { status: "cancelled", message: "Input request is no longer active." };
  }
  return params.input.plan.kind === "url"
    ? runUrl(params, params.input.plan.question)
    : runForm(params, params.input.plan.intro, params.input.plan.fields);
}

async function runUrl(
  params: StructuredInputExecutionParams,
  question: AgentHarnessUserInputQuestion,
): Promise<StructuredInputExecutionResult> {
  const result = await ask(params, [question], 0, params.promptOptions?.urlIntro);
  if (!isActive(params)) {
    return { status: "cancelled", message: "URL confirmation was cancelled before commit." };
  }
  if (result.status !== "answered") {
    const cancellation = cancellationFor(result, "URL confirmation");
    if (cancellation.message) {
      await showStatus(params, cancellation.message);
    }
    return cancellation;
  }
  const answer = result.answers.answers[question.id]?.[0];
  return answer?.toLowerCase() === "continue"
    ? { status: "answered", answers: result.answers.answers, content: {} }
    : { status: "declined" };
}

async function runForm(
  params: StructuredInputExecutionParams,
  intro: string,
  fields: readonly StructuredInputField[],
): Promise<StructuredInputExecutionResult> {
  const answers: Record<string, string[]> = {};
  let index = 0;
  let batch = 0;
  while (index < fields.length) {
    if (!isActive(params)) {
      return { status: "cancelled", message: "Form input was cancelled before completion." };
    }
    const field = fields[index]!;
    if (field.question.isSecret) {
      index += 1;
      const result = await ask(params, [field.question], batch, intro);
      batch += 1;
      if (!isActive(params)) {
        return { status: "cancelled", message: "Secret input was cancelled before commit." };
      }
      if (result.status !== "answered") {
        const cancellation = cancellationFor(result, "Secret input");
        if (cancellation.message) {
          await showStatus(params, cancellation.message);
        }
        return cancellation;
      }
      answers[field.question.id] = result.answers.answers[field.question.id] ?? [];
      continue;
    }
    const ordinary: StructuredInputField[] = [];
    while (
      index < fields.length &&
      ordinary.length < QUESTION_BATCH_SIZE &&
      !fields[index]?.question.isSecret
    ) {
      ordinary.push(fields[index++]!);
    }
    const result = await ask(
      params,
      ordinary.map((entry) => entry.question),
      batch,
      intro,
    );
    batch += 1;
    if (!isActive(params)) {
      return { status: "cancelled", message: "Form input was cancelled before commit." };
    }
    if (result.status !== "answered") {
      const cancellation = cancellationFor(result, "Form input");
      if (cancellation.message) {
        await showStatus(params, cancellation.message);
      }
      return cancellation;
    }
    for (const entry of ordinary) {
      answers[entry.question.id] = result.answers.answers[entry.question.id] ?? [];
    }
  }

  const content: Array<[string, StructuredInputAnswerValue]> = [];
  for (const field of fields) {
    const decoded = field.decode(answers[field.question.id] ?? []);
    if (decoded.kind === "invalid") {
      await showStatus(params, decoded.message);
      return { status: "declined", message: decoded.message };
    }
    if (decoded.kind === "present") {
      content.push(...decoded.entries);
    }
  }
  if (!isActive(params)) {
    return { status: "cancelled", message: "Form input was cancelled before commit." };
  }
  return { status: "answered", answers, content: Object.fromEntries(content) };
}

function ask(
  params: StructuredInputExecutionParams,
  questions: readonly AgentHarnessUserInputQuestion[],
  batch: number,
  intro: string | undefined,
): Promise<QuestionWaitAnswerResult> {
  return runAgentHarnessGatewayQuestion({
    questions,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    runId: params.runId,
    timeoutMs: params.timeoutMs,
    gatewayCall: params.gatewayCall,
    delivery: params.delivery,
    promptOptions: {
      ...params.promptOptions,
      ...(intro ? { intro } : {}),
    },
    signal: params.signal,
    questionId: params.questionId?.(batch),
  });
}

function isActive(params: StructuredInputExecutionParams): boolean {
  return params.signal?.aborted !== true && (params.isActive?.() ?? true);
}

function cancellationFor(
  result: Exclude<QuestionWaitAnswerResult, { status: "answered" }>,
  subject: string,
): { status: "cancelled"; message: string } {
  return {
    status: "cancelled",
    message: result.status === "expired" ? `${subject} expired.` : `${subject} was cancelled.`,
  };
}

async function showStatus(params: StructuredInputExecutionParams, message: string): Promise<void> {
  const question: AgentHarnessUserInputQuestion = {
    id: "unsupported",
    header: "Unsupported",
    question: message.slice(0, STATUS_TEXT_LIMIT),
    isOther: false,
    isSecret: false,
    options: null,
  };
  try {
    await deliverAgentHarnessUserInputPrompt(params.delivery, [question], {
      ...params.promptOptions,
      intro: params.promptOptions?.unsupportedIntro ?? "Input request could not be shown:",
    });
  } catch {
    // The protocol response still reports the closed unsupported/declined outcome.
  }
}
