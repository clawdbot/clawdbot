# Reaction lifecycle

Reaction lifecycle proves that the OpenClaw bot acknowledges a group mention on
the user's own Telegram message and that the user observes the emoji state.

## Sub-features

- `reaction-ack` records the configured acknowledgement emoji.
- `reaction-restore` records restoration of the initial ack after terminal status.
- `reaction-status` records later status emoji changes when enabled by config.

## How to get to it (user POV)

- In the QA group, mention the bot in a message.
- Watch reactions on that sent message while OpenClaw handles the turn.

## Driving it with the Telegram userbot runner

Preconditions:

- Baseline doctor passes.
- The configured QA group permits reactions from the SUT bot.
- OpenClaw's repo `mock-openai` fixture supports `OPENCLAW_E2E_DRAFTPROOF`.
- Use the group path; Telegram only reports these events to the user for the user's own message.

- **Drive an acknowledgement.** Run:

  ```bash
  mkdir -p "$TELEGRAM_E2E_PROOF_DIR/reaction-lifecycle"
  E2E_REQUIRE_MENTION=true \
  E2E_ROOT_CONFIG_PATCH='{"messages":{"ackReaction":"👀","ackReactionScope":"group-mentions","statusReactions":{"enabled":true}}}' \
  node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
    --timeout-ms 25000 \
    --text '@{sut} Run the OPENCLAW_E2E_DRAFTPROOF scenario.' \
    --record "$TELEGRAM_E2E_PROOF_DIR/reaction-lifecycle/events.ndjson" \
    --output "$TELEGRAM_E2E_PROOF_DIR/reaction-lifecycle/summary.json"
  ```

  The timeline contains reaction rows for the sent message: initial `👀`, a
  tool/status variant, a terminal done variant, then restored `👀`. Telegram
  may substitute group-allowed variants. Require the SUT's
  `OPENCLAW_E2E_DRAFTPROOF` final reply. Judge the lifecycle from the first
  `👀`; TDLib can emit an empty baseline row before the ack arrives.

- **Confirm ownership.** Match the reaction row's `messageId` to
  `sentMessageId`; a reaction on a bot-authored message is not observable proof.

## Gotchas

- `sutTotals.reaction` stays empty: the reaction update belongs to the QA user's message.
- An empty row before the first `👀` is baseline state, not terminal cleanup.
- Default `group-mentions` scope requires a group mention. It does not fire in DMs.
- Status reactions are opt-in through root `messages.statusReactions.enabled`.
- Group traffic may add unrelated rows. Match this run's sent message id.
- Telegram permissions can make this feature unreachable; report that prerequisite explicitly.
