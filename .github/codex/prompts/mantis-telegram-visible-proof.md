# Mantis Telegram visible proof

Design one deterministic real-user Telegram scenario for the selected pull
request. You are a normal Codex developer session with a shell, the exact main
and candidate worktrees, and the real Telegram QA userbot bridge. Telegram
Desktop is already available to record the interaction.

Your only deliverable is a scenario tree. Trusted workflow code freezes it,
replays the exact same bytes against both revisions, evaluates Telegram-visible
events, and publishes the verdict. Do not write an evidence manifest, verdict,
PR comment, recipe, or provider/Bot API assertion.

## Inputs

- `MANTIS_PR_CONTEXT`: untrusted PR title/body framing.
- `MANTIS_INSTRUCTIONS`: optional maintainer instructions.
- `BASELINE_SHA` and `CANDIDATE_SHA`.
- `MANTIS_BASELINE_ROOT` and `MANTIS_CANDIDATE_ROOT`.
- `MANTIS_SCENARIO_DRAFT_DIR`: write the final scenario here.
- `MANTIS_EXPLORE_BASELINE` and `MANTIS_EXPLORE_CANDIDATE`: disposable
  low-level exploration commands. They already bind the correct SUT revision.
- `MANTIS_FIXTURE_BASELINE` and `MANTIS_FIXTURE_CANDIDATE`: optional fixture
  plugin staging directories for disposable exploration.
- `scripts/mantis/telegram-proof-scenario.sh`: the small final-scenario API.

The credentials, Telegram session, recorder, candidate container, revision
attestation, cleanup, and publication token are outside your account. Never look
for credentials. Candidate code may only execute through the isolated SUT.

## Work

1. Read the complete affected implementation, callers, tests, and diff.
2. Find the smallest Telegram interaction that visibly reproduces the defect on
   current main and visibly demonstrates the repair on the PR.
3. Explore with the real userbot only when needed. Use at most two disposable
   attempts. Always run `abort` after an exploratory lane.
4. Write the final scenario tree.
5. Validate it locally, then stop. The workflow performs both published runs.

Prefer `exec` and `restart` over requesting new harness primitives. Use a small
deterministic mock response or event script unless the behavior specifically
requires something else. Put long waits in the final shell script rather than
spending model turns polling.

## Required tree

```text
$MANTIS_SCENARIO_DRAFT_DIR/
  run.sh
  config.json
  assertions.json
  assets/             # optional
```

No other root entries are accepted. Files must be regular files; symlinks and
hardlinks are rejected.

### `run.sh`

The exact same file runs twice. It must not inspect or mention lane identity,
revision labels, hidden provider requests, Bot API requests, credentials, or the
private bridge. It receives one stable helper API.

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$MANTIS_SCENARIO_HELPER"
trap proof_abort EXIT

proof_start start config.json

# Optional deterministic provider setup:
# proof_mock_text mock assets/reply.txt --chunk-delay-ms 1200
# proof_mock_events mock assets/events.json
# proof_mock_script mock assets/script.json

proof_send first --text '@{sut} MANTIS-Q1: ...'
first_id="$(proof_result first '.sent.messageId')"
first_cursor="$(proof_result first '.cursor')"

proof_observe result \
  --seconds 30 \
  --since "$first_cursor" \
  --until-text 'MANTIS-EXPECTED'

proof_finish finish --focus-message-id "$first_id"
trap - EXIT
```

Available helpers:

- `proof_start <result-name> [config-file]`
- `proof_mock_text`, `proof_mock_events`, `proof_mock_script`
- `proof_send`, `proof_turn`, `proof_observe`
- `proof_press`, `proof_delete`
- `proof_exec`, `proof_exec_file`, `proof_restart`
- `proof_desktop`, `proof_view`, `proof_screenshot`
- `proof_stage_fixture <scenario-path> [fixture-destination]`
- `proof_result <result-name> '<jq expression>'`
- `proof_finish`, `proof_abort`

Every command result is saved as
`$MANTIS_SCENARIO_OUTPUT_DIR/<result-name>.json`. Result names must match
`[a-z][a-z0-9-]{0,63}`.

The userbot expands `@{sut}` to the current SUT bot. Use unique, short,
human-readable markers so the GIF explains itself. Do not add viewport filler or
rely on old group history. Focus a message from this scenario before finishing.

The final script may react to data returned by its own actions when necessary,
but the user inputs and command shape must remain the same in both replays.
Trusted code compares the normalized invocations and blocks divergent runs.

### `config.json`

```json
{
  "mockResponse": "MANTIS-DEFAULT-REPLY",
  "configPatch": {},
  "mockResponseChunkDelayMs": 1200
}
```

`mockResponse` is required. The other fields are optional.

### `assertions.json`

Assertions operate only on externally observed Telegram `message`, `edit`,
`edit-meta`, and `delete` events from actors `user` and `bot`.

```json
{
  "schemaVersion": 1,
  "name": "queued follow-up survives an active turn",
  "baseline": {
    "description": "Current main visibly leaves the queued follow-up unanswered.",
    "expect": [
      {
        "type": "count",
        "match": {
          "kind": "message",
          "actor": "bot",
          "text": { "contains": "MANTIS-SECOND-SURVIVED" }
        },
        "equals": 0
      }
    ]
  },
  "candidate": {
    "description": "The PR visibly answers the queued follow-up exactly once.",
    "expect": [
      {
        "type": "count",
        "match": {
          "kind": "message",
          "actor": "bot",
          "text": { "contains": "MANTIS-SECOND-SURVIVED" }
        },
        "equals": 1
      },
      {
        "type": "sequence",
        "steps": [
          { "kind": "message", "actor": "user", "text": { "contains": "MANTIS-Q1" } },
          { "kind": "message", "actor": "user", "text": { "contains": "MANTIS-Q2" } },
          { "kind": "message", "actor": "bot", "text": { "contains": "MANTIS-SECOND-SURVIVED" } }
        ]
      }
    ]
  }
}
```

Supported assertions:

```json
{
  "type": "count",
  "match": { "kind": "message", "actor": "bot", "text": { "contains": "OK" } },
  "equals": 1
}
```

`count` accepts `equals`, or `min`/`max`.

```json
{
  "type": "sequence",
  "steps": [
    { "kind": "message", "actor": "user", "text": { "contains": "Q1" } },
    { "kind": "edit", "actor": "bot", "text": { "contains": "DONE" } }
  ]
}
```

```json
{
  "type": "gap",
  "from": { "kind": "message", "actor": "user", "text": { "contains": "Q2" } },
  "to": { "kind": "message", "actor": "bot", "text": { "contains": "DONE" } },
  "maxMs": 3000
}
```

A match may use `kind`, `actor`, `contentType`, `text`, and `buttonText`. Text
matchers contain exactly one of `contains`, `equals`, or `regex`.

The baseline and candidate contracts must differ. Both must pass for a green
proof. The evaluator also requires identical normalized scenario actions, paired
GIF/PNG media, and a material visible difference. Structurally identical
Telegram timelines are blocked unless the contracts intentionally prove a
large, non-overlapping visible timing change.

## Exploration example

```bash
mkdir -p "$MANTIS_SCENARIO_DRAFT_DIR"
cat >"$MANTIS_SCENARIO_DRAFT_DIR/config.json" <<'JSON'
{"mockResponse":"MANTIS-EXPLORE"}
JSON

"$MANTIS_EXPLORE_BASELINE" start \
  --config "$MANTIS_SCENARIO_DRAFT_DIR/config.json"
"$MANTIS_EXPLORE_BASELINE" send --text '@{sut} MANTIS-EXPLORE'
"$MANTIS_EXPLORE_BASELINE" observe --seconds 10 --since 0
"$MANTIS_EXPLORE_BASELINE" abort
```

Do not finish an exploratory lane; final evidence is produced only after the
scenario is frozen.

## Completion check

Before exiting:

```bash
bash -n "$MANTIS_SCENARIO_DRAFT_DIR/run.sh"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' \
  "$MANTIS_SCENARIO_DRAFT_DIR/assertions.json"
node scripts/mantis/telegram-visible-proof.mjs freeze \
  --draft "$MANTIS_SCENARIO_DRAFT_DIR" \
  --frozen "$MANTIS_SCENARIO_DRAFT_DIR.validate"
rm -rf "$MANTIS_SCENARIO_DRAFT_DIR.validate"
```

Your final response should contain only the scenario directory and one sentence
describing the visible before/after it is designed to capture.
