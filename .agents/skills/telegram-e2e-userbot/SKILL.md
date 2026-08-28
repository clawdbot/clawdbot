---
name: telegram-e2e-userbot
description: "Run OpenClaw Telegram E2E on Telegram's Test Server with Convex-leased team credentials; drive real-user turns and record messages, edits, deletions, reactions, typing, or rich content."
metadata:
  short-description: Telegram E2E via real-user driver
  argument-hint: "<message-or-command?>"
---

# Telegram E2E (Userbot)

Prove OpenClaw behavior against Telegram's Test Server as a dedicated QA user.
The user driver sees edits, deletions, reactions, and typing that a second bot
cannot observe.

Each credential contains one SUT bot and one independent TDLib authorization
for the shared QA user identity. Independent authorizations keep parallel runs
from splitting Telegram updates between observers.

Pool creation, session repair, and credential publication remain owner-only
operations outside this repository skill.

## 1. Prepare

Run from the OpenClaw checkout and ref under test. Point to the repository skill:

```bash
TELEGRAM_E2E_SKILL_DIR="${TELEGRAM_E2E_SKILL_DIR:-$PWD/.agents/skills/telegram-e2e-userbot}"
export TELEGRAM_E2E_SKILL_DIR
```

The runner starts `pnpm openclaw` from this checkout. Before acquiring a
credential, verify that the exact ref has a dependency-ready runtime and usable
build output without an implicit install or build. A bare worktree with missing
dependencies or a missing or stale build stamp is not ready. Move to a trusted
dependency-ready checkout or exact-head artifact first.

On hosts where builds are prohibited, `--source-gateway` runs a dependency-ready
TypeScript checkout through the repository's existing development launcher.

Use two unused ports for every run on a shared host:

```bash
: "${TELEGRAM_GATEWAY_PORT:?set an unused Gateway port}"
: "${TELEGRAM_MOCK_PORT:?set an unused provider port}"
export TELEGRAM_GATEWAY_PORT TELEGRAM_MOCK_PORT
```

Team and ClawSweeper runs use Convex. Confirm the CI role is available without
printing it:

```bash
: "${OPENCLAW_QA_CONVEX_SITE_URL:?missing Convex QA site}"
: "${OPENCLAW_QA_CONVEX_SECRET_CI:?missing Convex QA CI credential}"
```

Done when the checkout contains `scripts/e2e/mock-openai-server.mjs`, the skill
directory resolves, the exact runtime can start without setup work, and the
Convex broker settings are present.

## 2. Select the proof

Read [the verification map](features/README.md), then read only the recipe for
the behavior under test. Prefer a DM for isolation. Use the shared group only
when group policy, mentions, commands, topics, or reactions are part of the
claim.

The generic `OPENCLAW_E2E_OK` turn proves only the default message path. A
channel-visible change needs a recipe whose timeline exposes that change. If the
diff is not channel-visible, state that boundary and use the generic turn.

For a non-default backend or timed scenario, read the matching section of the
[runtime reference](features/runtime-reference.md).

Done when the prompt, chat type, config patch, and expected event sequence each
map to the behavior being proved.

## 3. Run the doctor

```bash
node "$TELEGRAM_E2E_SKILL_DIR/scripts/telegram-test-doctor.mjs"
```

Require `ok: true`. The doctor leases one credential, restores its private TDLib
state, confirms the pinned TDLib version on the Test Server, verifies the SUT
through the Test Bot API proxy, then removes the state and releases the lease.

Done when the doctor reports Convex source, loaded credentials, isolated TDLib
state, Test Server, authorized user, Bot API proxy, disabled group privacy,
active group membership, and the SUT bot.

## 4. Drive and record

Create a durable proof directory outside runner scratch state:

```bash
TELEGRAM_E2E_PROOF_DIR="$(mktemp -d /tmp/telegram-e2e-proof.XXXXXX)"
node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
  --gateway-port "$TELEGRAM_GATEWAY_PORT" --mock-port "$TELEGRAM_MOCK_PORT" \
  --dm --text 'Please answer with OPENCLAW_E2E_OK only.' \
  --record "$TELEGRAM_E2E_PROOF_DIR/events.ndjson" \
  --output "$TELEGRAM_E2E_PROOF_DIR/summary.json"
```

The runner owns one Convex lease, the Test Bot API proxy, a
fresh gateway, the selected provider, the real-user action, recording, teardown,
and cleanup. The default gateway and mock-provider ports are `19879` and `19882`;
managed workloads on one host always pass distinct `--gateway-port` and
`--mock-port` values instead of using defaults.

Convex selects and exclusively leases any free credential. An exhausted pool
waits briefly for a release. The runner heartbeats during the run and releases
the credential during cleanup.

Recording captures facts and rejects probe assertions such as `--expect` and
`--any-sut-reply`. Use probe mode only for a quick reply check.

Done when the runner exits zero and the proof directory contains
`events.ndjson`, `summary.json`, `gateway.log`, and
`mock-openai-requests.ndjson`.

## 5. Judge the evidence

Start at the sent action in `summary.json`. Judge only later events from the
selected SUT. Use stable `botApiMessageId` values to connect messages, edits,
reactions, and deletions. Require a provider request when the path should reach
the model; native commands can correctly produce none. Read the
[event model](features/runtime-reference.md#evidence-model) only when normalized
fields need interpretation.

Report the exact command with secrets omitted, the sent action and message id,
the relevant timeline rows, the provider request count, and the claim those
facts prove. A bare success marker or final screenshot is not sufficient.

Done when every part of the claim has one Telegram-observable fact and every
expected model boundary has matching provider evidence.

## Cleanup

The runner stops only its own process groups and removes credential and gateway
scratch state. An explicit proof directory survives.
Keep it until the review or repro no longer needs it.

Done when no runner-owned process or listener remains, credential scratch state
is gone, the Convex lease is released, assigned ports are free, and the named
proof files remain readable.

Use the dedicated QA user and Test Server bots. Keep every credential in its
source, active lease, or private runner scratch, and redact bot ids and
usernames when evidence leaves the local task.
