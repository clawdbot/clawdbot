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
  const questions = readClaudeUserInputQuestions(params.input);
  if (!questions) {
    return { behavior: "deny", message: "OpenClaw rejected malformed Claude user questions." };
  }
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

function readClaudeUserInputQuestions(
  input: Record<string, unknown>,
): CliBackendUserInputQuestion[] | undefined {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) {
    return undefined;
  }
  const questions: CliBackendUserInputQuestion[] = [];
  for (const [index, rawQuestion] of rawQuestions.entries()) {
    if (!isRecord(rawQuestion)) {
      return undefined;
    }
    const question = readBoundedText(rawQuestion.question, 4_096);
    const header = readBoundedText(rawQuestion.header, 12);
    const rawOptions = rawQuestion.options;
    if (
      !question ||
      !header ||
      !Array.isArray(rawOptions) ||
      rawOptions.length < 2 ||
      rawOptions.length > 4 ||
      typeof rawQuestion.multiSelect !== "boolean"
    ) {
      return undefined;
    }
    const options: Array<{ label: string; description?: string }> = [];
    for (const rawOption of rawOptions) {
      if (!isRecord(rawOption)) {
        return undefined;
      }
      const label = readBoundedText(rawOption.label, 256);
      const description = readBoundedText(rawOption.description, 1_024);
      if (!label || !description) {
        return undefined;
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
  return questions;
}

function readBoundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  return value;
}
