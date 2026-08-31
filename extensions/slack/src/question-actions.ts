// Slack-private ask_user button envelope and resolution feedback.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { SLACK_BUTTON_VALUE_MAX } from "./presentation.js";

const SLACK_QUESTION_VALUE_PREFIX = "slq1:";
const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

type SlackQuestionAction = {
  questionId: string;
  optionIndex: number;
};

export function encodeSlackQuestionAction(action: SlackQuestionAction): string | undefined {
  if (
    !QUESTION_RECORD_ID_PATTERN.test(action.questionId) ||
    !Number.isInteger(action.optionIndex) ||
    action.optionIndex < 0 ||
    action.optionIndex > 3
  ) {
    return undefined;
  }
  const value = `${SLACK_QUESTION_VALUE_PREFIX}${action.questionId}:${action.optionIndex}`;
  return value.length <= SLACK_BUTTON_VALUE_MAX ? value : undefined;
}

export function decodeSlackQuestionAction(value: unknown): SlackQuestionAction | null {
  if (typeof value !== "string" || value.length > SLACK_BUTTON_VALUE_MAX) {
    return null;
  }
  const match = /^slq1:(ask_[a-f0-9]{32}):([0-3])$/u.exec(value);
  return match?.[1] && match[2] ? { questionId: match[1], optionIndex: Number(match[2]) } : null;
}

type ResolveQuestionParams = Parameters<typeof questionGatewayRuntime.resolveOption>[0];
type QuestionResolver = (
  params: ResolveQuestionParams,
) => ReturnType<typeof questionGatewayRuntime.resolveOption>;

export async function resolveSlackQuestionAction(params: {
  action: SlackQuestionAction;
  cfg: ResolveQuestionParams["cfg"];
  accountId: string;
  userId: string;
  respond: (text: string) => Promise<void>;
  resolveQuestion?: QuestionResolver;
}): Promise<void> {
  let result: Awaited<ReturnType<QuestionResolver>>;
  try {
    result = await (params.resolveQuestion ?? questionGatewayRuntime.resolveOption)({
      cfg: params.cfg,
      questionId: params.action.questionId,
      optionIndex: params.action.optionIndex,
      senderId: params.userId,
      clientDisplayName: `Slack question (${params.accountId})`,
    });
  } catch {
    await params.respond("Could not submit this answer.").catch(() => {});
    return;
  }
  await params
    .respond(
      result.status === "answered" ? "Answer submitted." : "This question was already answered.",
    )
    .catch(() => {});
}
