import type {
  SystemAgentChatParams,
  SystemAgentChatResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";

type SystemAgentChatReply = Awaited<ReturnType<SystemAgentChatEngine["handle"]>>;
type SystemAgentChatEngineInput = Pick<
  SystemAgentChatEngine,
  "answerWizard" | "cancelWizard" | "handle"
>;

export function getSystemAgentChatInputError(params: SystemAgentChatParams): string | undefined {
  if (params.message !== undefined && params.wizardAnswer !== undefined) {
    return "Send either message or wizardAnswer, not both.";
  }
  if (params.wizardAnswer !== undefined && params.delegation !== undefined) {
    return "Delegated OpenClaw sessions cannot submit structured wizard answers.";
  }
  if (params.wizardAnswer !== undefined && params.reset === true) {
    return "A wizard answer cannot reset its OpenClaw chat session.";
  }
  if (
    params.wizardCancel !== undefined &&
    (params.message !== undefined || params.wizardAnswer !== undefined)
  ) {
    return "Send wizardCancel without a message or wizardAnswer.";
  }
  if (params.wizardCancel !== undefined && params.delegation !== undefined) {
    return "Delegated OpenClaw sessions cannot cancel hosted wizards.";
  }
  if (params.wizardCancel !== undefined && params.reset === true) {
    return "A wizard cancel cannot reset its OpenClaw chat session.";
  }
  return undefined;
}

export async function runSystemAgentChatInput(params: {
  engine: SystemAgentChatEngineInput;
  input: SystemAgentChatParams;
}): Promise<SystemAgentChatReply | undefined> {
  if (params.input.wizardAnswer !== undefined) {
    return await params.engine.answerWizard(params.input.wizardAnswer);
  }
  if (params.input.wizardCancel !== undefined) {
    return await params.engine.cancelWizard(params.input.wizardCancel);
  }
  if (params.input.message === undefined) {
    return undefined;
  }
  return params.input.delegation === undefined && params.input.context
    ? await params.engine.handle(params.input.message, { uiContext: params.input.context })
    : await params.engine.handle(params.input.message);
}

export function buildSystemAgentChatResult(params: {
  sessionId: string;
  reply: SystemAgentChatReply;
  proposalId?: string;
}): SystemAgentChatResult {
  const action =
    params.reply.action === "open-tui"
      ? "open-agent"
      : params.reply.action === "open-setup"
        ? "none"
        : params.reply.action;
  return {
    sessionId: params.sessionId,
    reply:
      params.reply.text ||
      (action === "open-agent"
        ? "Setup here is done — continue with your agent."
        : "Nothing to change."),
    action,
    ...(action === "open-agent" && params.reply.agentDraft
      ? { agentDraft: params.reply.agentDraft }
      : {}),
    ...(action === "open-agent" &&
    params.reply.handoff?.kind === "open-tui" &&
    params.reply.handoff.agentId
      ? { agentId: params.reply.handoff.agentId }
      : {}),
    ...(params.reply.sensitive === true ? { sensitive: true } : {}),
    ...(params.reply.wizardInputPending === true ? { wizardInputPending: true } : {}),
    ...(params.reply.question ? { question: params.reply.question } : {}),
    ...(params.reply.step ? { step: params.reply.step } : {}),
    ...(params.proposalId ? { needsApproval: true, proposalId: params.proposalId } : {}),
  };
}
