// Renders inbound native Messages polls into agent-visible text. Without this
// a poll balloon reaches the agent as the raw 0xFFFD placeholder its text
// column carries, so the agent sees an empty message and asks the sender to
// resend. imsg already decodes the poll (question/options/votes); this turns
// that structured event into a readable prompt the agent can act on, including
// numbered options so it can vote by 1-based index via the poll-vote action.
import type { IMessagePoll } from "./types.js";

export function renderIMessagePollBody(poll: IMessagePoll): string | null {
  const options = poll.options ?? [];

  // Vote update: surface who voted for what so the agent can follow tallies.
  if (poll.kind === "vote" || (poll.vote && options.length === 0)) {
    const vote = poll.vote;
    if (!vote) {
      return "\u{1F4CA} Poll vote received";
    }
    const who = vote.participant?.trim() || "someone";
    const what = vote.option_text?.trim() || vote.option_id || "an option";
    const verb = vote.event_type === "removed" ? "removed their vote for" : "voted for";
    return `\u{1F4CA} Poll vote: ${who} ${verb} "${what}"`;
  }

  if (options.length === 0) {
    return null;
  }

  const tally = new Map<string, number>();
  for (const vote of poll.votes ?? []) {
    if (vote.event_type === "removed" || !vote.option_id) {
      continue;
    }
    tally.set(vote.option_id, (tally.get(vote.option_id) ?? 0) + 1);
  }

  // Cue the vote action explicitly. The agent has the poll-vote tool, but given
  // a flat notification it tends to answer the poll with a prose text reply
  // instead of casting a vote. Naming the action + index makes voting the
  // obvious path. An earlier version dropped the call-to-action to stop the
  // model from also verbalizing its pick, but that suppressed voting entirely;
  // the poll_vote_echo guard now drops any redundant spoken answer, so the
  // call-to-action is safe. The `📊 Poll:` prefix also matches the trigger
  // phrasing agents key their vote instructions on.
  const optionList = options
    .map((option, index) => {
      const count = tally.get(option.id) ?? 0;
      return `${index + 1}) ${option.text}${count > 0 ? ` [${count}]` : ""}`;
    })
    .join("  ");
  const question = poll.question?.trim();
  return `\u{1F4CA} Poll${question ? `: ${question}` : ""} — options: ${optionList}. Cast your vote on this poll with the poll-vote action (pollOptionIndex = the option number); do not answer in a text reply.`;
}
