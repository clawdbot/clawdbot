import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type {
  ControlModelConversationSnapshot,
  ControlModelRequestOptions,
} from "../../../../packages/gateway-client/src/model/index.js";
import type { QuestionPromptCommand } from "../../app/question-prompt-command.ts";
import {
  cancelQuestionPrompt,
  submitQuestionPrompt,
  type QuestionPrompt,
} from "../../app/question-prompt.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  selectedControlModelConversationForRoute,
  type ChatControlModelConversationState,
} from "./chat-control-model.ts";

type QuestionConversation = {
  getSnapshot(): Pick<ControlModelConversationSnapshot, "questions" | "commandAvailability">;
  answerQuestion(
    id: string,
    answers: Readonly<Record<string, readonly string[]>>,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>>;
  cancelQuestion(
    id: string,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>>;
};

export function controlModelQuestionPromptCommand(
  conversation: QuestionConversation | null,
  id: string,
  action: "answer" | "cancel",
): QuestionPromptCommand | undefined {
  const snapshot = conversation?.getSnapshot();
  const available =
    action === "answer"
      ? snapshot?.commandAvailability.answerQuestion
      : snapshot?.commandAvailability.cancelQuestion;
  if (
    !conversation ||
    !snapshot ||
    !available ||
    !snapshot.questions.some((question) => question.id === id && question.status === "pending")
  ) {
    return undefined;
  }
  return async (request) => {
    const timeoutMs = Math.min(
      DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
      Math.max(0, request.expiresAtMs - Date.now()),
    );
    return action === "answer"
      ? conversation.answerQuestion(id, request.answers?.answers ?? {}, { timeoutMs })
      : conversation.cancelQuestion(id, { timeoutMs });
  };
}

type QuestionPromptState = Parameters<typeof submitQuestionPrompt>[0];

export function questionPromptsForRoute(
  prompts: readonly QuestionPrompt[],
  sessionKey: string,
  agentId?: string,
): QuestionPrompt[] {
  const normalizedAgentId = agentId?.trim().toLowerCase();
  return prompts.filter(
    (prompt) =>
      prompt.sessionKey !== undefined &&
      areUiSessionKeysEquivalent(prompt.sessionKey, sessionKey) &&
      (normalizedAgentId
        ? !prompt.agentId || prompt.agentId.trim().toLowerCase() === normalizedAgentId
        : !prompt.agentId),
  );
}

export function controlModelChatInteractionProps(
  state: ChatControlModelConversationState,
  questionState: QuestionPromptState,
  sessionKey: string,
  agentId?: string,
) {
  const conversation = selectedControlModelConversationForRoute(state, sessionKey, agentId);
  return {
    controlModelArtifacts: conversation?.getSnapshot().artifacts,
    onGatewayQuestionSubmit: (id: string, answers: Record<string, string[]>) =>
      submitQuestionPrompt(
        questionState,
        id,
        answers,
        controlModelQuestionPromptCommand(conversation, id, "answer"),
      ),
    onGatewayQuestionSkip: (id: string) =>
      cancelQuestionPrompt(
        questionState,
        id,
        controlModelQuestionPromptCommand(conversation, id, "cancel"),
      ),
  };
}
