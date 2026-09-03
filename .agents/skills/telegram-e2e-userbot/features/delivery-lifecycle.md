# Delivery lifecycle

Delivery lifecycle proves what one Telegram answer does over time: progress
creation, edits, tool activity, receipt finalization, and persistent answer delivery.

## Sub-features

- `lifecycle-message` records the first visible SUT message.
- `lifecycle-edit` records in-place preview revisions.
- `lifecycle-finalize` records the progress message collapsing into an activity receipt.
- `lifecycle-typing` records Telegram chat actions emitted before or during delivery.

## How to get to it (user POV)

- Send a prompt that makes the bot announce work, run a tool, and then answer.
- Watch the temporary progress message change before the final answer appears.

## Driving it with the Telegram userbot runner

Preconditions:

- Baseline doctor passes.
- OpenClaw's repo `mock-openai` fixture supports `OPENCLAW_E2E_DRAFTPROOF`.

- **Drive progress and finalization.** Run:

  ```bash
  mkdir -p "$TELEGRAM_E2E_PROOF_DIR/delivery-lifecycle"
  E2E_TELEGRAM_PROVIDER_API=openai-completions \
  E2E_TELEGRAM_CONFIG_PATCH='{"streaming":{"mode":"progress","progress":{"commentary":true}}}' \
  node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
    --dm --timeout-ms 30000 \
    --text 'Run the OPENCLAW_E2E_DRAFTPROOF scenario.' \
    --record "$TELEGRAM_E2E_PROOF_DIR/delivery-lifecycle/events.ndjson" \
    --output "$TELEGRAM_E2E_PROOF_DIR/delivery-lifecycle/summary.json"
  ```

  Require two model requests, SUT typing, one progress message with same-id edits
  containing commentary and tool activity, and a separate persistent final
  message containing `OPENCLAW_E2E_DRAFTPROOF`.

- **Confirm finalization.** Match progress edits by `botApiMessageId`. Its last
  revision is the activity receipt. Require no `delete` event on this happy path.

## Gotchas

- Older checkouts can collapse the Responses preamble into one final answer; the recipe pins the completions fixture for that reason.
- A fast one-turn response correctly creates no draft. Use the named fixture, not arbitrary text.
- `updateMessageEdited` is metadata; content revisions arrive as `edit`.
- TDLib may replay old updates. Judge only events after this recipe's sent message.
