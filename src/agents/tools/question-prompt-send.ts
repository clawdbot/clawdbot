/**
 * Publishes a question tool's prompt into the conversation it will be answered from.
 *
 * A question tool blocks its turn until a person answers, so the prompt has to reach
 * that conversation whichever harness is running the agent. Harnesses that run tools
 * through the embedded tool lifecycle publish it from their tool-start handler;
 * harnesses that dispatch tools themselves hand the tool this sender instead. Both
 * arrive here, so the prompt is identical either way.
 */
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
  type DurableMessageBatchSendResult,
} from "../../channels/message/runtime.js";
import { resolveControlUiSessionLinkBase } from "../../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithQuestionChannelDeliveries } from "../../infra/question-channel-runtime.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel-normalize.js";
import { buildAgentHarnessQuestionPromptPayload } from "../harness/user-input-bridge.js";

/** Tools whose call opens a question a person must answer before the turn continues. */
export type QuestionPromptToolName = "ask_user" | "secrets";

/** Publishes one prompt into the originating conversation. */
export type QuestionPromptSend = (
  payload: ReplyPayload,
  options?: { signal?: AbortSignal },
) => void | Promise<void>;

/** A run's own way to show a question prompt, plus the channel it would appear in. */
export type QuestionPromptDelivery = {
  send: QuestionPromptSend;
  messageChannel?: string;
};

/** Builds a portable prompt sender for Gateway-scoped / loopback tool construction. */
export function createChannelQuestionPromptDelivery(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  to?: string | number | null;
  accountId?: string;
  threadId?: string | number | null;
}): QuestionPromptDelivery | undefined {
  const cfg = params.cfg;
  const channel = normalizeMessageChannel(params.channel);
  const to = params.to?.toString().trim();
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  return {
    messageChannel: channel,
    send: async (payload, options) => {
      const send = await sendDurableMessageBatchCore({
        cfg,
        channel,
        to,
        accountId: params.accountId,
        threadId: params.threadId ?? undefined,
        payloads: [payload],
        bestEffort: false,
        durability: "required",
        deliveryRetryOwner: "caller",
        signal: options?.signal,
      });
      settleChannelQuestionPromptSend(send);
    },
  };
}

function settleChannelQuestionPromptSend(send: DurableMessageBatchSendResult): void {
  // Fail closed when the durable batch did not reach the chat. ask_user then
  // cancels instead of waiting on Control UI after a suppressed or failed send.
  if (durableMessageBatchMayHaveReachedRecipient(send)) {
    return;
  }
  if (send.status === "failed") {
    throw send.error;
  }
  throw new Error(
    send.status === "suppressed"
      ? `question prompt delivery was suppressed: ${send.reason}`
      : "question prompt delivery did not reach the conversation",
  );
}

/**
 * Publishes the prompt for an already-committed gateway question record.
 *
 * Rejects when the question cannot become answerable where it was asked, which is
 * what tells the caller to cancel the pending record instead of waiting it out.
 */
export async function sendQuestionToolPrompt(params: {
  toolName: QuestionPromptToolName;
  questionId: string;
  questions: readonly QuestionRequestQuestion[];
  config?: OpenClawConfig;
  send: QuestionPromptSend;
  signal?: AbortSignal;
}): Promise<void> {
  const { questionId, questions } = params;
  const send: QuestionPromptSend = (payload) =>
    runWithQuestionChannelDeliveries([questionId], () =>
      params.signal ? params.send(payload, { signal: params.signal }) : params.send(payload),
    );
  if (params.toolName === "secrets") {
    const binding = questions[0]?.secretStore;
    if (!binding) {
      return;
    }
    const controlUiBase = resolveControlUiSessionLinkBase(params.config);
    const text = controlUiBase
      ? `🔑 Agent requests credential ${binding.name} (${binding.kind}). Reply is disabled for secrets — open to provide it: ${controlUiBase}/ask/${encodeURIComponent(questionId)}`
      : "Credential request unavailable here: no reachable Control UI link. Open a trusted Control UI or native app and retry, or ask the operator to enable Control UI and configure gateway.publicOrigin. Never send credentials in chat.";
    // Correlation keeps this durable without adding answer controls or a plaintext claim.
    await send({ text, channelData: { askUser: { questionId } } });
    if (!controlUiBase) {
      // A visible blocker is not a delivered entry form; cancel the pending wait.
      throw new Error(text);
    }
    return;
  }
  await send(
    buildAgentHarnessQuestionPromptPayload({
      questionId,
      questions: questions.map(({ questionId: id, ...question }) =>
        Object.assign(question, { id }),
      ),
      options: { intro: "Question for you:" },
    }),
  );
}
