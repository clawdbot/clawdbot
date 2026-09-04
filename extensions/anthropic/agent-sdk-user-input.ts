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
  const read = readClaudeUserInputQuestions(params.input);
  if ("error" in read) {
    return {
      behavior: "deny",
      message: `OpenClaw rejected malformed Claude user questions: ${read.error}.`,
    };
  }
  const questions = read.questions;
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

type ClaudeUserInputQuestionsRead =
  | { questions: CliBackendUserInputQuestion[] }
  | { error: string };

function readClaudeUserInputQuestions(
  input: Record<string, unknown>,
): ClaudeUserInputQuestionsRead {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) {
    return { error: "questions must be an array of 1 to 4 items" };
  }
  const questions: CliBackendUserInputQuestion[] = [];
  for (const [index, rawQuestion] of rawQuestions.entries()) {
    const at = `questions[${index}]`;
    if (!isRecord(rawQuestion)) {
      return { error: `${at} must be an object` };
    }
    const question = readBoundedText(rawQuestion.question, 4_096);
    if (!question) {
      return { error: describeBoundedTextError(`${at}.question`, rawQuestion.question, 4_096) };
    }
    const header = readBoundedText(rawQuestion.header, 12);
    if (!header) {
      return { error: describeBoundedTextError(`${at}.header`, rawQuestion.header, 12) };
    }
    const rawOptions = rawQuestion.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 4) {
      return { error: `${at}.options must be an array of 2 to 4 items` };
    }
    if (typeof rawQuestion.multiSelect !== "boolean") {
      return { error: `${at}.multiSelect must be a boolean` };
    }
    const options: Array<{ label: string; description?: string }> = [];
    for (const [optionIndex, rawOption] of rawOptions.entries()) {
      const optionAt = `${at}.options[${optionIndex}]`;
      if (!isRecord(rawOption)) {
        return { error: `${optionAt} must be an object` };
      }
      const label = readBoundedText(rawOption.label, 256);
      if (!label) {
        return { error: describeBoundedTextError(`${optionAt}.label`, rawOption.label, 256) };
      }
      const description = readBoundedText(rawOption.description, 1_024);
      if (!description) {
        return {
          error: describeBoundedTextError(`${optionAt}.description`, rawOption.description, 1_024),
        };
      }
      options.push({ label, description });
    }
    questions.push({
      id: `question_${index + 1}`,
      header,
      question,
      multiSelect: rawQuestion.multiSelect,
      isOther: true,
      options,
    });
  }
  return { questions };
}

function readBoundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  return value;
}

function describeBoundedTextError(at: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return `${at} must be a string`;
  }
  if (value.length === 0) {
    return `${at} must not be empty`;
  }
  return `${at} must be at most ${maxLength} characters (received ${value.length})`;
}
