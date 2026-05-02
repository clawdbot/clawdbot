import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

type PendingUserInput = {
  requestId: number | string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  resolve: (value: JsonValue) => void;
  cleanup: () => void;
};

type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
};

type UserInputOption = {
  label: string;
  description: string;
};

type CodexUserInputBridge = {
  handleRequest: (request: {
    id: number | string;
    params?: JsonValue;
  }) => Promise<JsonValue | undefined>;
  handleQueuedMessage: (text: string) => boolean;
  handleNotification: (notification: CodexServerNotification) => void;
  cancelPending: () => void;
};

export function createCodexUserInputBridge(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): CodexUserInputBridge {
  let pending: PendingUserInput | undefined;

  const resolvePending = (value: JsonValue) => {
    const current = pending;
    if (!current) {
      return;
    }
    pending = undefined;
    current.cleanup();
    current.resolve(value);
  };

  return {
    async handleRequest(request) {
      const requestParams = readUserInputParams(request.params);
      if (!requestParams) {
        return undefined;
      }
      if (requestParams.threadId !== params.threadId || requestParams.turnId !== params.turnId) {
        return undefined;
      }

      resolvePending(emptyUserInputResponse());

      return new Promise<JsonValue>((resolve) => {
        const abortListener = () => resolvePending(emptyUserInputResponse());
        const cleanup = () => params.signal?.removeEventListener("abort", abortListener);
        pending = {
          requestId: request.id,
          threadId: requestParams.threadId,
          turnId: requestParams.turnId,
          itemId: requestParams.itemId,
          questions: requestParams.questions,
          resolve,
          cleanup,
        };
        params.signal?.addEventListener("abort", abortListener, { once: true });
        if (params.signal?.aborted) {
          resolvePending(emptyUserInputResponse());
          return;
        }
        void deliverUserInputPrompt(params.paramsForRun, requestParams.questions).catch((error) => {
          embeddedAgentLog.warn("failed to deliver codex user input prompt", { error });
        });
      });
    },
    handleQueuedMessage(text) {
      const current = pending;
      if (!current) {
        return false;
      }
      resolvePending(buildUserInputResponse(current.questions, text));
      return true;
    },
    handleNotification(notification) {
      if (notification.method !== "serverRequest/resolved" || !pending) {
        return;
      }
      const notificationParams = isJsonObject(notification.params)
        ? notification.params
        : undefined;
      const requestId = notificationParams ? readRequestId(notificationParams) : undefined;
      if (
        notificationParams &&
        readString(notificationParams, "threadId") === pending.threadId &&
        requestId !== undefined &&
        String(requestId) === String(pending.requestId)
      ) {
        resolvePending(emptyUserInputResponse());
      }
    },
    cancelPending() {
      resolvePending(emptyUserInputResponse());
    },
  };
}

function readUserInputParams(value: JsonValue | undefined):
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      questions: UserInputQuestion[];
    }
  | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const threadId = readString(value, "threadId");
  const turnId = readString(value, "turnId");
  const itemId = readString(value, "itemId");
  const questionsRaw = value.questions;
  if (!threadId || !turnId || !itemId || !Array.isArray(questionsRaw)) {
    return undefined;
  }
  const questions = questionsRaw
    .map(readQuestion)
    .filter((question): question is UserInputQuestion => Boolean(question));
  return { threadId, turnId, itemId, questions };
}

function readQuestion(value: JsonValue): UserInputQuestion | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const id = readString(value, "id");
  const header = readString(value, "header");
  const question = readString(value, "question");
  if (!id || !header || !question) {
    return undefined;
  }
  return {
    id,
    header,
    question,
    isOther: value.isOther === true,
    isSecret: value.isSecret === true,
    options: readOptions(value.options),
  };
}

function readOptions(value: JsonValue | undefined): UserInputOption[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const options = value
    .map(readOption)
    .filter((option): option is UserInputOption => Boolean(option));
  return options.length > 0 ? options : null;
}

function readOption(value: JsonValue): UserInputOption | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const label = readString(value, "label");
  const description = readString(value, "description") ?? "";
  return label ? { label, description } : undefined;
}

async function deliverUserInputPrompt(
  params: EmbeddedRunAttemptParams,
  questions: UserInputQuestion[],
): Promise<void> {
  const text = formatUserInputPrompt(questions);
  if (params.onBlockReply) {
    await params.onBlockReply({ text });
    return;
  }
  await params.onPartialReply?.({ text });
}

function formatUserInputPrompt(questions: UserInputQuestion[]): string {
  const lines = ["Codex needs input:"];
  questions.forEach((question, index) => {
    if (questions.length > 1) {
      lines.push("", `${index + 1}. ${question.header}`, question.question);
    } else {
      lines.push("", question.header, question.question);
    }
    if (question.isSecret) {
      lines.push("This channel may show your reply to other participants.");
    }
    question.options?.forEach((option, optionIndex) => {
      lines.push(
        `${optionIndex + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`,
      );
    });
    if (question.isOther) {
      lines.push("Other: reply with your own answer.");
    }
  });
  return lines.join("\n");
}

function buildUserInputResponse(questions: UserInputQuestion[], inputText: string): JsonObject {
  const answers: JsonObject = {};
  if (questions.length === 1) {
    const question = questions[0];
    if (question) {
      answers[question.id] = { answers: [normalizeAnswer(inputText, question)] };
    }
    return { answers };
  }

  const keyed = parseKeyedAnswers(inputText);
  const fallbackLines = inputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  questions.forEach((question, index) => {
    const key =
      keyed.get(question.id.toLowerCase()) ??
      keyed.get(question.header.toLowerCase()) ??
      keyed.get(question.question.toLowerCase()) ??
      keyed.get(String(index + 1));
    const answer = key ?? fallbackLines[index] ?? "";
    answers[question.id] = { answers: answer ? [normalizeAnswer(answer, question)] : [] };
  });
  return { answers };
}

function normalizeAnswer(answer: string, question: UserInputQuestion): string {
  const trimmed = answer.trim();
  const options = question.options ?? [];
  const optionIndex = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
  const indexed = optionIndex >= 0 ? options[optionIndex] : undefined;
  if (indexed) {
    return indexed.label;
  }
  const exact = options.find((option) => option.label.toLowerCase() === trimmed.toLowerCase());
  return exact?.label ?? trimmed;
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

function emptyUserInputResponse(): JsonObject {
  return { answers: {} };
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRequestId(record: JsonObject): string | number | undefined {
  const value = record.requestId;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
