// Feishu plugin module implements poll vote card action behavior.
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuCardActionEvent } from "./card-action.js";
import type { FeishuCardInteractionEnvelope } from "./card-interaction.js";
import { buildFeishuPollCard, createFeishuPollStoreState, extractFeishuPollVote } from "./polls.js";
import { editMessageFeishu } from "./send.js";

/**
 * Handle a vote-button click on a poll card. Records the voter's selection,
 * then re-renders the card with live tallies. Returns "ignored" when the poll
 * is unknown/expired or the payload is malformed so the caller can log it.
 */
export async function handleFeishuPollVoteAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  envelope: FeishuCardInteractionEnvelope;
  accountId?: string;
  log: (...args: unknown[]) => void;
}): Promise<"handled" | "ignored"> {
  const { cfg, event, envelope, accountId, log } = params;
  const voterOpenId = event.operator.open_id?.trim();
  const vote = extractFeishuPollVote(envelope);
  if (!voterOpenId || !vote) {
    return "ignored";
  }
  const pollStore = createFeishuPollStoreState();
  const poll = await pollStore.getPoll(vote.pollId);
  if (!poll) {
    log(`feishu poll vote ignored: unknown or expired poll ${vote.pollId}`);
    return "ignored";
  }
  const optionIndex = parseStrictNonNegativeInteger(vote.optionIndex);
  if (optionIndex === undefined || optionIndex < 0 || optionIndex >= poll.options.length) {
    return "ignored";
  }

  // Single-select replaces the voter's choice; multi-select toggles it up to
  // maxSelections so repeat taps cannot exceed the poll's selection budget.
  const selected = String(optionIndex);
  const current = poll.votes[voterOpenId] ?? [];
  const selections =
    poll.maxSelections > 1
      ? current.includes(selected)
        ? current.filter((entry) => entry !== selected)
        : [...current, selected].slice(-poll.maxSelections)
      : [selected];

  const updated = await pollStore.recordVote({
    pollId: vote.pollId,
    voterId: voterOpenId,
    selections,
  });
  if (!updated) {
    log(`feishu poll vote ignored: poll ${vote.pollId} not stored`);
    return "ignored";
  }
  if (!updated.messageId) {
    // A vote re-render needs the original card's message id; without it the
    // tallies cannot be refreshed in place, so the click is recorded as ignored.
    log(`feishu poll vote ignored: poll ${vote.pollId} has no message id to update`);
    return "ignored";
  }

  await editMessageFeishu({
    cfg,
    messageId: updated.messageId,
    card: buildFeishuPollCard({
      pollId: updated.id,
      question: updated.question,
      options: updated.options,
      maxSelections: updated.maxSelections,
      chatId: updated.conversationId,
      votes: updated.votes,
      voterOpenId,
    }),
    accountId,
  });
  return "handled";
}
