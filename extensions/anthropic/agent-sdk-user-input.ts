import type { PermissionResult as ClaudeAgentSdkPermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  CliBackendExecuteContext,
  CliBackendUserInputQuestion,
} from "openclaw/plugin-sdk/cli-backend";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function createClaudeAgentSdkUserInputAuthorizer(context: CliBackendExecuteContext) {
  const requests = new Map<string, Promise<ClaudeAgentSdkPermissionResult>>();
  return {
    authorize(params: {
      input: Record<string, unknown>;
      signal: AbortSignal;
      toolUseId?: string;
    }): Promise<ClaudeAgentSdkPermissionResult> {
      const existing = params.toolUseId ? requests.get(params.toolUseId) : undefined;
      if (existing) {
        return existing;
      }
      const request = runClaudeUserInput(context, params);
      if (params.toolUseId) {
        requests.set(params.toolUseId, request);
      }
      return request;
    },
  };
}

async function runClaudeUserInput(
  context: CliBackendExecuteContext,
  params: {
    input: Record<string, unknown>;
    signal: AbortSignal;
    toolUseId?: string;
  },
): Promise<ClaudeAgentSdkPermissionResult> {
  const parsed = readClaudeUserInputQuestions(params.input);
  if (!parsed.ok) {
    return {
      behavior: "deny",
      message: `OpenClaw rejected malformed Claude user questions: ${parsed.failure}. Correct the invalid field and retry AskUserQuestion.`,
    };
  }
  const questions = parsed.questions;
  const result = await context.requestUserInput({
    toolName: "AskUserQuestion",
    questions,
    intro: "Claude needs input:",
    ...(params.toolUseId ? { toolCallId: params.toolUseId } : {}),
    abortSignal: params.signal,
  });
  if (result.status !== "answered") {
    return {
      behavior: "deny",
      message: `${result.message} Continue with your best judgment.`,
    };
  }
  const answers: Record<string, string> = {};
  questions.forEach((question) => {
    answers[question.question] = (result.answers[question.id] ?? []).join(", ");
  });
  return { behavior: "allow", updatedInput: { ...params.input, answers } };
}

type ParsedQuestions =
  | { ok: true; questions: CliBackendUserInputQuestion[] }
  | { ok: false; failure: string };

function readClaudeUserInputQuestions(input: Record<string, unknown>): ParsedQuestions {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) {
    return { ok: false, failure: "questions must be an array of 1 to 4 questions" };
  }
  const questions: CliBackendUserInputQuestion[] = [];
  for (const [index, rawQuestion] of rawQuestions.entries()) {
    const questionPath = `questions[${index}]`;
    if (!isRecord(rawQuestion)) {
      return { ok: false, failure: `${questionPath} must be an object` };
    }
    const question = readBoundedText(rawQuestion.question, 4_096);
    if (!question.ok) {
      return { ok: false, failure: `${questionPath}.question ${question.failure}` };
    }
    const header = readBoundedText(rawQuestion.header, 12);
    if (!header.ok) {
      return { ok: false, failure: `${questionPath}.header ${header.failure}` };
    }
    const rawOptions = rawQuestion.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 4) {
      return { ok: false, failure: `${questionPath}.options must be an array of 2 to 4 options` };
    }
    if (typeof rawQuestion.multiSelect !== "boolean") {
      return { ok: false, failure: `${questionPath}.multiSelect must be a boolean` };
    }
    const options: Array<{ label: string; description?: string }> = [];
    for (const [optionIndex, rawOption] of rawOptions.entries()) {
      const optionPath = `${questionPath}.options[${optionIndex}]`;
      if (!isRecord(rawOption)) {
        return { ok: false, failure: `${optionPath} must be an object` };
      }
      const label = readBoundedText(rawOption.label, 256);
      if (!label.ok) {
        return { ok: false, failure: `${optionPath}.label ${label.failure}` };
      }
      const description = readBoundedText(rawOption.description, 1_024);
      if (!description.ok) {
        return { ok: false, failure: `${optionPath}.description ${description.failure}` };
      }
      options.push({ label: label.text, description: description.text });
    }
    questions.push({
      id: `question_${index + 1}`,
      header: header.text,
      question: question.text,
      multiSelect: rawQuestion.multiSelect,
      isOther: true,
      options,
    });
  }
  return { ok: true, questions };
}

function readBoundedText(
  value: unknown,
  maxLength: number,
): { ok: true; text: string } | { ok: false; failure: string } {
  if (typeof value !== "string") {
    return { ok: false, failure: "must be a string" };
  }
  if (value.length === 0) {
    return { ok: false, failure: "must not be empty" };
  }
  if (value.length > maxLength) {
    return { ok: false, failure: `must be at most ${maxLength} characters` };
  }
  return { ok: true, text: value };
}
