# Basic turns

Basic turns prove that a dedicated Telegram user can reach the OpenClaw bot and
receive the deterministic provider response in the same chat.

## Sub-features

- `turn-dm` sends an isolated direct-message turn.
- `turn-group` sends a mention-targeted group turn.
- `turn-command` sends a native slash command targeted at the SUT bot.

## How to get to it (user POV)

- Open the bot's direct chat and send a normal message.
- Open the QA group, mention the bot, and send a normal message.
- Open the QA group and send `/status@<bot username>`.

## Driving it with the Telegram userbot runner

Preconditions:

- Baseline doctor passes.
- The QA user and SUT bot share a direct chat; use the configured QA group for group paths.

- **Drive a DM.** Run:

  ```bash
  mkdir -p "$TELEGRAM_E2E_PROOF_DIR/basic-turns"
  node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
    --dm --timeout-ms 25000 \
    --text 'Please answer with OPENCLAW_E2E_BASIC only.' \
    --record "$TELEGRAM_E2E_PROOF_DIR/basic-turns/events.ndjson" \
    --output "$TELEGRAM_E2E_PROOF_DIR/basic-turns/summary.json"
  ```

  `summary.json` names the sent message, records at least one SUT message, and
  includes `OPENCLAW_E2E_BASIC` in `sutRevisionTexts`.

- **Confirm the boundary.** Require at least one `POST /v1/responses` row in
  `mock-openai-requests.ndjson`. The real Telegram event and provider request
  together prove the turn crossed both boundaries.

- **Drive a group turn.** Run:

  ```bash
  mkdir -p "$TELEGRAM_E2E_PROOF_DIR/basic-group"
  node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
    --timeout-ms 25000 \
    --text '@{sut} Please answer with OPENCLAW_E2E_GROUP only.' \
    --record "$TELEGRAM_E2E_PROOF_DIR/basic-group/events.ndjson" \
    --output "$TELEGRAM_E2E_PROOF_DIR/basic-group/summary.json"
  ```

  Require the sent group message, a SUT reply containing
  `OPENCLAW_E2E_GROUP`, and one logged model request.

- **Drive a native command.** Run:

  ```bash
  mkdir -p "$TELEGRAM_E2E_PROOF_DIR/basic-command"
  node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
    --timeout-ms 25000 --text '/status@{sut}' \
    --record "$TELEGRAM_E2E_PROOF_DIR/basic-command/events.ndjson" \
    --output "$TELEGRAM_E2E_PROOF_DIR/basic-command/summary.json"
  ```

  Require a SUT status reply and an empty `mock-openai-requests.ndjson`;
  `/status` answers before model execution.

## Gotchas

- Shared groups contain unrelated traffic. Prefer `--dm` unless group policy is the claim.
- A normal group prompt needs `@{sut}`. A native group command needs `/status@{sut}`.
- Model-request proof applies to normal turns. Native `/status` proves its fast path with no request.
- Keep proof artifacts after the runner removes its scratch gateway state.
