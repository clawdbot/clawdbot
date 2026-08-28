# Telegram E2E runtime reference

Read this file only for a non-default backend, manual driver operation, event
interpretation, or a failed run. The primary proof sequence stays in
[`SKILL.md`](../SKILL.md).

## Chat selection

`--chat` accepts a TDLib chat id, `@username`, invite link, or `t.me` link.
`--dm` targets the selected SUT directly.

Prefer DMs for isolated turns. A shared group records unrelated traffic and all
privacy-disabled pool bots can see its messages. Use a group only when its
behavior is part of the claim.

In probe mode, pair `--dm` with `--any-sut-reply`. A bot normally answers a DM
without a native quote, while the default probe filter requires one. Recording
mode captures facts and rejects that flag.

## Backends

| Backend         | Use                                                                     |
| --------------- | ----------------------------------------------------------------------- |
| `mock`          | Default deterministic OpenClaw `mock-openai` turn.                      |
| `qa-mock`       | QA fixtures for tools, delays, and scenario actions.                    |
| `codex-fixture` | Deterministic Codex app-server interaction fixtures.                    |
| `claude-cli`    | Real Claude CLI path for progress behavior the mock lane cannot render. |

`claude-cli` uses the operator's Claude credentials and costs real usage. Its
default model is `claude-haiku-4-5`; set `E2E_TELEGRAM_CLI_MODEL` to override it.

```bash
node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
  --backend claude-cli --dm \
  --text 'Use Bash to run: echo alpha. Then reply with only the output.' \
  --record /tmp/events.ndjson --output /tmp/summary.json
```

## Evidence model

Each recognized event keeps its raw TDLib update in NDJSON. The summary adds a
normalized timeline:

```json
{
  "recordingComplete": true,
  "totals": { "message": 1, "edit": 2, "delete": 1 },
  "sutTotals": { "message": 1, "edit": 2, "delete": 1 },
  "timeline": [{ "elapsedMs": 8159, "kind": "message", "botApiMessageId": 46145, "isSut": true }]
}
```

`kind` is `message`, `edit`, `edit-meta`, `delete`, `typing`, or `reaction`.
Message and edit rows include SUT identity, reply target, quote text, topic,
content type, and extracted rich-message text. Reaction rows include emoji and
count.

| Claim                    | Required fact                                    |
| ------------------------ | ------------------------------------------------ |
| Draft changed over time  | Successive `edit` rows on one `botApiMessageId`. |
| Final replaced the draft | Final `edit` on that same id.                    |
| Draft was removed        | A later `delete` for that id.                    |
| Bot typed before reply   | A `typing` row before the message.               |
| Ack reaction changed     | Reaction rows on the QA user's sent message id.  |

Telegram sends reaction updates for messages authored by the QA user. A bot
reacting to its own message produces no user-visible reaction update.

## Manual driver operation

The routine runner supplies all state through one Convex lease. Use low-level
commands only inside runner-owned credential state:

```bash
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" doctor --json
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" status --json
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" chats --json
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" send --text '/status@{sut}'
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" transcript --limit 20
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" probe \
  --text '@{sut} Reply exactly: USER-E2E-{run}' --expect USER-E2E-
```

The leased credential supplies the group id, SUT token and identity, tester id,
TDLib configuration, and authorized session. Credential state lives in a
private runner directory. The shared cache at
`~/.cache/openclaw/telegram-e2e-userbot/tdlib` contains only the TDLib binary.

`TELEGRAM_USER_DRIVER_TDLIB_PATH` selects a deliberate custom TDLib build.
`login --qr` is an owner-repair action for a session that cannot be restored; it
is not a routine maintainer step.

## Config controls

[The verification map](README.md#reaching-non-default-config) is the source of
truth for environment knobs and scenario actions. Read that section when the
proof needs non-default channel or root config, prior history, timed actions,
gateway restarts, cron delivery, or health sampling.

## Failure triage

The runner must own the gateway under test. A gateway from another checkout can
use the wrong token, config, or code.

If no SUT reply appears, inspect these boundaries in order:

1. The credential restored and `status --json` reports `testDc: true` and TDLib `1.8.67`.
2. The SUT Test Bot API reports no webhook and no stale pending updates.
3. The gateway log shows the selected Telegram provider and an inbound update.
4. `mock-openai-requests.ndjson` contains the expected provider request.
5. The gateway log contains an outbound send for the same chat.

Zero provider requests means the turn never reached the model. A `401` from
`api.openai.com` means the gateway did not use the mock base URL. An outbound
send plus no observed reply points to TDLib authorization or chat selection,
not the model.

## Runtime facts

- TDLib ids are shifted: raw TDLib message id equals Bot API id `<< 20`; compare `botApiMessageId`.
- TDLib replays cached updates after connect; judge only events after the run's sent action.
- The driver pins `@prebuilt-tdlib` `0.1008067.0`, which reports TDLib `1.8.67`.
- TDLib 1.8.6 and later take the existing base64 database key in `setTdlibParameters`; re-encoding changes the key.
- OpenClaw does not expose grammY's Test Server option, so the loopback proxy inserts `/test` after the bot token.
- Broker calls time out after 15 seconds. A failed heartbeat fences the runner before later actions and stops an active probe.
- Chunked broker payloads are authenticated per chunk and bounded to 64 MiB and 4096 chunks before JSON parsing.
- Scope gateway logs with `logging.file`; the default `/tmp/openclaw/<date>.log` mixes concurrent runs.
- Gateway logs do not prove edit versus send; TDLib events do.
- Progress drafts are provider-shaped; a single final-answer fixture correctly records no progress revisions.
