import type { SessionConfig } from "@github/copilot-sdk";
import {
  callGatewayTool,
  embeddedAgentLog,
  runAgentHarnessGatewayQuestion,
  type AgentHarnessQuestionGatewayCall,
  type AgentHarnessUserInputQuestion,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type CopilotUserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type CopilotUserInputRequest = Parameters<CopilotUserInputHandler>[0];
type CopilotUserInputResponse = Awaited<ReturnType<CopilotUserInputHandler>>;

type CopilotUserInputBridge = {
  onUserInputRequest: CopilotUserInputHandler;
  cancelPending: () => void;
};

const COPILOT_USER_INPUT_QUESTION_ID = "answer";
const DEFAULT_USER_INPUT_TIMEOUT_MS = 15 * 60_000;

export function createCopilotUserInputBridge(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  signal?: AbortSignal;
  gatewayCall?: AgentHarnessQuestionGatewayCall;
}): CopilotUserInputBridge {
  let pending: AbortController | undefined;
  const gatewayCall = params.gatewayCall ?? callGatewayTool;

  return {
    async onUserInputRequest(request) {
      pending?.abort(new Error("Copilot user input request replaced"));
      const abort = new AbortController();
      pending = abort;
      const abortFromRun = () => abort.abort(params.signal?.reason);
      params.signal?.addEventListener("abort", abortFromRun, { once: true });
      if (params.signal?.aborted) {
        abortFromRun();
      }
      try {
        const question = toQuestion(request);
        const result = await runAgentHarnessGatewayQuestion({
          questions: [question],
          sessionKey: params.paramsForRun.sessionKey ?? params.paramsForRun.sessionId,
          agentId: params.paramsForRun.agentId,
          timeoutMs: params.paramsForRun.timeoutMs ?? DEFAULT_USER_INPUT_TIMEOUT_MS,
          gatewayCall,
          delivery: params.paramsForRun,
          promptOptions: {
            intro: "Copilot needs input:",
            formatText: formatCopilotDisplayText,
          },
          signal: abort.signal,
        });
        if (result.status !== "answered") {
          return emptyCopilotUserInputResponse();
        }
        const selected = result.answers.answers[COPILOT_USER_INPUT_QUESTION_ID]?.answers[0] ?? "";
        return {
          answer: selected,
          wasFreeform: !isChoiceAnswer(question, selected),
        };
      } catch (error) {
        embeddedAgentLog.warn("failed to bridge copilot user input through gateway", { error });
        return emptyCopilotUserInputResponse();
      } finally {
        params.signal?.removeEventListener("abort", abortFromRun);
        if (pending === abort) {
          pending = undefined;
        }
      }
    },
    cancelPending() {
      pending?.abort(new Error("Copilot user input request cancelled"));
    },
  };
}

function toQuestion(request: CopilotUserInputRequest): AgentHarnessUserInputQuestion {
  return {
    id: COPILOT_USER_INPUT_QUESTION_ID,
    header: "Copilot",
    question: request.question,
    isOther: request.allowFreeform !== false,
    isSecret: false,
    options:
      request.choices && request.choices.length > 0
        ? request.choices.map((choice: string) => ({ label: choice }))
        : null,
  };
}

function emptyCopilotUserInputResponse(): CopilotUserInputResponse {
  return { answer: "", wasFreeform: true };
}

function isChoiceAnswer(question: AgentHarnessUserInputQuestion, answer: string): boolean {
  return Boolean(
    answer &&
    question.options?.some((option) => option.label.toLowerCase() === answer.toLowerCase()),
  );
}

function formatCopilotDisplayText(value: string): string {
  const safe = sanitizeCopilotDisplayText(value).trim();
  return escapeCopilotChatText(safe || "<unknown>");
}

function sanitizeCopilotDisplayText(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    safe += codePoint != null && isUnsafeDisplayCodePoint(codePoint) ? "?" : character;
  }
  return safe;
}

function escapeCopilotChatText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "\uff20")
    .replaceAll("`", "\uff40")
    .replaceAll("[", "\uff3b")
    .replaceAll("]", "\uff3d")
    .replaceAll("(", "\uff08")
    .replaceAll(")", "\uff09")
    .replaceAll("*", "\u2217")
    .replaceAll("_", "\uff3f")
    .replaceAll("~", "\uff5e")
    .replaceAll("|", "\uff5c");
}

function isUnsafeDisplayCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x001f ||
    (codePoint >= 0x007f && codePoint <= 0x009f) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  );
}
