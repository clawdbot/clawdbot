---
summary: "Mantis captures visual end-to-end evidence for live transport comparisons and focused candidate-only browser proofs, then attaches the artifacts to PRs."
title: "Mantis"
read_when:
  - Building or running live visual QA for OpenClaw bugs
  - Adding before and after verification for a pull request
  - Adding Discord, Slack, WhatsApp, or other live transport scenarios
  - Running focused Control UI browser proof for a candidate ref
  - Debugging QA runs that need screenshots, browser automation, or VNC access
---

Mantis publishes visual CI evidence and a PR comment for OpenClaw behavior.
Live transport scenarios compare a known-bad baseline with a candidate ref;
focused browser lanes may instead prove one candidate against a deterministic
mocked transport. Discord shipped first with real bot auth, guild channels, reactions, threads,
and a browser witness. Slack and focused Control UI chat lanes exist too;
WhatsApp and Matrix are unimplemented.

## Ownership

- OpenClaw (`extensions/qa-lab/src/mantis/*`): scenario runtime, `pnpm openclaw qa mantis <command>` CLI, evidence schema.
- QA Lab (`extensions/qa-lab/src/live-transports/*`): live transport harness, driver/SUT bots, report/evidence writers.
- Crabbox (`openclaw/crabbox`): warmed Linux machines, leases, VNC, `crabbox media preview`.
- GitHub Actions (`.github/workflows/mantis-*.yml`): remote entrypoints, artifact retention.
- ClawSweeper: independently reviews proof and owns review/readiness policy. Mantis workflow dispatch and evidence publication are separate from ordinary review publication; a Mantis result does not itself grant readiness or merge permission.

## CLI commands

All commands are `pnpm openclaw qa mantis <command>`, defined in
`extensions/qa-lab/src/mantis/cli.ts`. Requires `OPENCLAW_ENABLE_PRIVATE_QA_CLI=1`
at build/run time (bundled workflows set `OPENCLAW_BUILD_PRIVATE_QA=1` and
`OPENCLAW_ENABLE_PRIVATE_QA_CLI=1` before building).

| Command                         | Purpose                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discord-smoke`                 | Verify the Mantis Discord bot can see the guild/channel, post, and react.                                                                                 |
| `run`                           | Run a before/after scenario against baseline and candidate refs (Discord only).                                                                           |
| `desktop-browser-smoke`         | Lease/reuse a Crabbox desktop, open a visible browser, capture screenshot + video.                                                                        |
| `slack-desktop-smoke`           | Lease/reuse a Crabbox desktop, run Slack QA inside it, open Slack Web, capture evidence.                                                                  |
| `visual-task` / `visual-driver` | Generic Crabbox desktop capture with optional image-understanding assertions; `visual-driver` is the driver half launched under `crabbox record --while`. |

Every command accepts `--repo-root <path>` and `--output-dir <path>`; Crabbox
commands also accept `--crabbox-bin`, `--provider`, `--machine-class`/`--class`,
`--lease-id`, `--idle-timeout`, `--ttl`, and `--keep-lease`. Local CLI defaults
for provider/class are `hetzner`/`beast` unless noted otherwise; CI workflows
usually override both.

### `discord-smoke`

```bash
pnpm openclaw qa mantis discord-smoke \
  --output-dir .artifacts/qa-e2e/mantis/discord-smoke
```

Calls the Discord REST API (`https://discord.com/api/v10`) to fetch the bot
user, the guild, the guild's channels, and the target channel, asserts the
channel belongs to the guild, then (unless `--skip-post`) posts a message and
adds a `👀` reaction. Writes `mantis-discord-smoke-summary.json` and
`mantis-discord-smoke-report.md`.

Token resolution order: `--token-file` value, then `OPENCLAW_QA_DISCORD_MANTIS_BOT_TOKEN`
(override with `--token-env`), then a file named by `OPENCLAW_QA_DISCORD_MANTIS_BOT_TOKEN_FILE`
(override with `--token-file-env`). Guild/channel ids come from
`OPENCLAW_QA_DISCORD_GUILD_ID` / `OPENCLAW_QA_DISCORD_CHANNEL_ID` (override with
`--guild-id` / `--channel-id`) and must be 17-20 digit Discord snowflakes. Set
`OPENCLAW_QA_REDACT_PUBLIC_METADATA=1` to replace bot/guild/channel/message ids
and names with `<redacted>` in the published summary and report.

### `run`

```bash
pnpm openclaw qa mantis run \
  --transport discord \
  --scenario discord-status-reactions-tool-only \
  --baseline origin/main \
  --candidate HEAD \
  --output-dir .artifacts/qa-e2e/mantis/local-discord-status-reactions
```

`--transport` currently only accepts `discord`. `--scenario` is one of two
built-in ids, each with its own default baseline ref and expected before/after
labels (`extensions/qa-lab/src/mantis/run.runtime.ts`):

| Scenario                                   | Default baseline                           | Baseline expects                         | Candidate expects            |
| ------------------------------------------ | ------------------------------------------ | ---------------------------------------- | ---------------------------- |
| `discord-status-reactions-tool-only`       | `0bf06e953fdda290799fc9fb9244a8f67fdae593` | `queued-only`                            | `queued -> thinking -> done` |
| `discord-thread-reply-filepath-attachment` | `81349cdc2a9d5143fd0991ed858b739e7d96e05c` | thread reply omits `filePath` attachment | thread reply includes it     |

`--candidate` defaults to `HEAD`. Other flags: `--credential-source`
(default `convex`), `--credential-role` (default `ci`), `--provider-mode`
(default `live-frontier`), `--fast` (default on), `--skip-install`, `--skip-build`.

The runner creates detached `git worktree` checkouts for baseline and
candidate under `<output-dir>/worktrees/`, runs `pnpm install`/`pnpm build` in
each (unless skipped), then runs
`pnpm openclaw qa discord --scenario <id> --model openai/gpt-5.4 --alt-model openai/gpt-5.4 --allow-failures`
against each worktree. Each lane writes `discord-qa-reaction-timelines.json`
plus a `<scenario-id>-timeline.html`/`.png` pair; the runner copies this
evidence back under `baseline/`/`candidate/`, writes `comparison.json`,
`mantis-report.md`, and `mantis-evidence.json` in the output directory, and
exits nonzero if the comparison did not pass (baseline `fail` and candidate
`pass`).

The second Discord scenario (`discord-thread-reply-filepath-attachment`) posts
a parent message with the driver bot, creates a real thread, calls the SUT's
`message.thread-reply` action with a repo-local `filePath`, then polls the
thread for the reply and the attachment filename. It expects an attachment
named `mantis-thread-report.md`.

### `desktop-browser-smoke`

```bash
pnpm openclaw qa mantis desktop-browser-smoke \
  --output-dir .artifacts/qa-e2e/mantis/desktop-browser
```

Leases or reuses a Crabbox desktop, launches a browser inside the VNC session
pointed at `--browser-url` (default `https://openclaw.ai`) or a rendered
`--html-file`, waits, screenshots with `scrot`, optionally records an MP4 with
`ffmpeg`, and rsyncs `desktop-browser-smoke.png` / `.mp4` / `remote-metadata.json`
back to `--output-dir`.

Flags:

- `--lease-id <cbx_...>` reuses a warmed desktop instead of creating one.
- `--browser-profile-dir <remote-path>` reuses a remote Chrome user-data-dir so a persistent desktop stays logged in between runs (used for a long-lived Discord Web viewer profile).
- `--browser-profile-archive-env <name>` restores a base64 `.tgz` Chrome profile archive from that env var before launch (default `OPENCLAW_MANTIS_BROWSER_PROFILE_TGZ_B64`); used for logged-in witnesses like Discord Web.
- `--video-duration <seconds>` controls MP4 capture length (default 10s).
- `--keep-lease` (or `OPENCLAW_MANTIS_KEEP_VM=1`) keeps a lease this run created open for VNC inspection; failed runs that created a lease also keep it by default.

For Discord Web evidence, Mantis uses a dedicated viewer account, not a bot
token. The Discord REST oracle (via `qa discord`) remains authoritative; when
`OPENCLAW_QA_DISCORD_CAPTURE_UI_METADATA=1` is set, the scenario also writes a
Discord Web URL artifact, and `OPENCLAW_QA_DISCORD_KEEP_THREADS=1` leaves the
thread open long enough for the browser to open it.

The GitHub workflow prefers a persistent viewer profile via
`MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR` (full profile archives can outgrow
GitHub's secret size limit); for small/bootstrap profiles it can restore a
base64 `.tgz` from `MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64` instead. With
neither source configured, the workflow still publishes the deterministic
baseline/candidate screenshots and logs that the logged-in witness was
skipped.

### `slack-desktop-smoke`

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --output-dir .artifacts/qa-e2e/mantis/slack-desktop \
  --gateway-setup \
  --scenario slack-canary \
  --keep-lease
```

Leases or reuses a Crabbox desktop, syncs the checkout into the VM, runs
`pnpm openclaw qa slack` inside it, opens Slack Web in the VNC browser,
captures the desktop, and copies both the Slack QA artifacts (`slack-qa/`) and
the VNC screenshot/video back locally. This is the only Mantis shape where the
SUT gateway and the browser both run inside the same VM.

With `--gateway-setup`, the command creates a persistent disposable OpenClaw
home at `$HOME/.openclaw-mantis/slack-openclaw` in the VM, patches Slack
Socket Mode config for the target channel, starts
`openclaw gateway run --dev --allow-unconfigured --port 38973`, and leaves
Chrome running in the VNC session; omitting `--gateway-setup` runs the normal
bot-to-bot Slack QA lane instead.

Required env for `--credential-source env` (local default is `env`; role
default is `maintainer`):

- `OPENCLAW_QA_SLACK_CHANNEL_ID`
- `OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_APP_TOKEN`
- `OPENCLAW_LIVE_OPENAI_KEY` for the remote model lane (if only `OPENAI_API_KEY`
  is set locally, Mantis copies it to `OPENCLAW_LIVE_OPENAI_KEY` before
  invoking Crabbox)

With `--credential-source convex`, Mantis leases the Slack SUT credential from
the shared pool before creating the VM and forwards channel id, app token, and
bot token into the VM as `OPENCLAW_MANTIS_SLACK_*` env vars, so GitHub
workflows only need the Convex broker secret, not raw Slack tokens.

Other flags: `--slack-url <url>` opens a specific URL (otherwise Mantis derives
`https://app.slack.com/client/<team>/<channel>` from `auth.test`);
`--slack-channel-id <id>` sets the gateway allowlist channel;
`OPENCLAW_MANTIS_SLACK_BROWSER_PROFILE_DIR` controls the persistent Chrome
profile inside the VM (default `$HOME/.config/openclaw-mantis/slack-chrome-profile`);
`--approval-checkpoints` runs the native Slack approval scenarios
(`slack-approval-exec-native`, `slack-approval-plugin-native`) and renders
pending/resolved checkpoint screenshots instead of gateway setup (mutually
exclusive with `--gateway-setup`); `--hydrate-mode source|prehydrated`,
`--provider-mode`, `--model`, `--alt-model`, and `--fast` pass through to the
Slack live lane.

Approval checkpoint screenshots are rendered from the Slack API message the
scenario observed, not the live Slack UI; `slack-desktop-smoke.png` is only
proof of Slack Web itself when the lease's browser profile was already logged
in.

## Evidence manifest

The publisher requires schema version 2 of `mantis-evidence.json` next to
the report. Each included lane must declare `expectationMet`; the publisher
downgrades a claimed pass when a lane's expectation was not met. For example:

```json
{
  "schemaVersion": 2,
  "id": "discord-status-reactions",
  "title": "Mantis Discord Status Reactions QA",
  "summary": "Human-readable top summary for the PR comment.",
  "scenario": "discord-status-reactions-tool-only",
  "comparison": {
    "baseline": {
      "sha": "<baseline-sha>",
      "status": "fail",
      "expected": "queued-only",
      "expectationMet": true
    },
    "candidate": {
      "sha": "<candidate-sha>",
      "status": "pass",
      "expected": "queued -> thinking -> done",
      "expectationMet": true
    },
    "pass": true,
    "outcome": "pass"
  },
  "artifacts": [
    {
      "kind": "timeline",
      "lane": "baseline",
      "label": "Baseline queued-only",
      "path": "baseline/timeline.png",
      "targetPath": "baseline.png",
      "alt": "Baseline Discord timeline",
      "width": 420
    }
  ]
}
```

This manifest is a presentation contract, not an authenticated proof receipt.
It does not independently establish repository/PR ownership, current-head
freshness, execution authority, or the truth of an assertion. A video, process
exit code, or declared expectation alone is not sufficient behavioral proof.
Review the underlying observations and execution provenance before relying on
the result. Infrastructure failures and missing observations are inconclusive,
not evidence that the baseline reproduced the bug.

The local `qa mantis run` producer still emits schema version 1, which the
publisher rejects. Do not relabel that output as version 2 without deriving
its lane expectations from observations; the workflow producers emit version 2.

Artifact `path` is relative to the manifest's directory; `targetPath` is
relative to the configured R2/S3 artifact prefix. `scripts/mantis/publish-pr-evidence.mjs`
rejects path traversal and skips entries with `"required": false` when the
file is missing.

Artifact kinds: `timeline` (deterministic before/after screenshot),
`desktopScreenshot` (VNC/browser screenshot), `motionPreview` (inline animated
GIF from the recording), `motionClip` (motion-trimmed MP4), `fullVideo` (full
recording), `metadata` (JSON/log sidecar), `report` (Markdown report).

A run's on-disk artifact layout:

```text
.artifacts/qa-e2e/mantis/<run-id>/
  mantis-report.md
  mantis-evidence.json
  baseline/
  candidate/
  comparison.json
```

Screenshots are evidence, not secrets, but still need redaction discipline:
private channel names, usernames, or message content may appear. Set
`OPENCLAW_QA_REDACT_PUBLIC_METADATA=1` for public artifact uploads; it is
enabled by default in the Discord and Slack GitHub workflows.

## GitHub automation

`scripts/mantis/publish-pr-evidence.mjs` is the reusable publisher. Workflows
call it with the manifest, target PR, artifact target root, comment marker,
artifact URL, run URL, and request source. It uploads declared artifacts to
the Mantis R2 bucket, builds a summary-first PR comment with inline
images/previews and linked videos, then updates the existing marker comment or
creates a new one. Required env:

- `MANTIS_ARTIFACT_R2_ACCESS_KEY_ID`
- `MANTIS_ARTIFACT_R2_SECRET_ACCESS_KEY`
- `MANTIS_ARTIFACT_R2_BUCKET` (workflows set `openclaw-crabbox-artifacts`)
- `MANTIS_ARTIFACT_R2_ENDPOINT`
- `MANTIS_ARTIFACT_R2_REGION` (workflows set `auto`)
- `MANTIS_ARTIFACT_R2_PUBLIC_BASE_URL` (workflows set `https://artifacts.openclaw.ai`)

Comments post through the Mantis GitHub App (`MANTIS_GITHUB_APP_ID` /
`MANTIS_GITHUB_APP_PRIVATE_KEY`), not `github-actions[bot]`, using a hidden
marker comment as the upsert key.

| Workflow                          | Trigger         | What it does                                                                                                                                                                                                                                                                           |
| --------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Mantis Discord Smoke`            | manual dispatch | Runs `discord-smoke` against a chosen ref.                                                                                                                                                                                                                                             |
| `Mantis Discord Status Reactions` | manual dispatch | Builds separate baseline/candidate worktrees, runs `discord-status-reactions-tool-only` on each, renders each lane's timeline in a Crabbox desktop browser, generates motion-trimmed GIF/MP4 previews with `crabbox media preview`, uploads artifacts, posts inline PR evidence.       |
| `Mantis Scenario`                 | manual dispatch | Generic dispatcher: takes `scenario_id` (`discord-status-reactions-tool-only`, `discord-thread-reply-filepath-attachment`, `slack-desktop-smoke`, `web-ui-chat-proof`), `baseline_ref`, `candidate_ref`, `pr_number`, and forwards to the matching scenario workflow.                  |
| `Mantis Slack Desktop Smoke`      | manual dispatch | Leases a Crabbox Linux desktop (defaults to `aws`, choice of `hetzner`), runs `slack-desktop-smoke --gateway-setup` against the candidate, records the desktop, generates a motion preview, uploads artifacts, posts PR evidence when a PR number is given.                            |
| `Mantis Web UI Chat Proof`        | manual dispatch | Runs the focused OpenClaw Control UI chat Playwright proof against the candidate, verifies the browser sends through the mocked Gateway, captures screenshot/video artifacts, and posts PR evidence. This lane is web chat proof only, not WinUI/native-app or arbitrary visual proof. |

`Mantis Discord Status Reactions` accepts `baseline_ref`/`candidate_ref` and
validates that the resolved SHA is either an
ancestor of `origin/main`, a release tag (`v*`), or the head of an open PR
before running with secret-bearing credentials.

The legacy scenario workflows above remain available through manual Actions dispatch.

Do not rely on the former `@clawsweeper mantis ...` example as a dedicated
dispatch command. ClawSweeper's current command parser routes an unrecognized
mention to general assistance, not a typed Mantis dispatch.

The separate request-bound integration in
[ClawSweeper #1425](https://github.com/openclaw/clawsweeper/pull/1425) and
[OpenClaw #138953](https://github.com/openclaw/openclaw/pull/138953) lets the
reviewer select relevant proof before completing its original review. It does
not restore automatic post-review recording or require every check on every PR.
Hosted execution requires the trusted producer workflows on `main` and the
matching ClawSweeper Worker/runtime deployment; merging documentation does not
activate it. The existing Convex credential service is still required, but its
APIs are reused without a Convex schema change or deployment.

Once that integration is deployed, a human maintainer can request a review with
proof available, without supplying a SHA:

```text
@clawsweeper proof
@clawsweeper proof web-ui-chat-proof
@clawsweeper proof telegram-bot-e2e-proof
@clawsweeper proof web-ui-chat-proof,telegram-bot-e2e-proof
```

The bare command lets the reviewer select useful checks; explicit selections
request each named check. The review resolves the current PR head. Control UI
supports the fixed chat smoke against a mocked Gateway; Telegram supports a
bounded, data-only Test Server plan. The legacy Crabline recipe is not a third
inline tool. Missing, late, or incomplete observations remain inconclusive.
The reviewer assesses results in the same review; successful execution alone
does not clear proof, other readiness blockers, or merge requirements.

Selected checks share a 20-minute proof ceiling, further bounded by the original
review's remaining time minus its final-decision reserve. With the default
20-minute review timeout and 90-second reserve, that is at most 18m30s if invoked
immediately, less after analysis. This is a ceiling, not a fixed wait or a fresh
budget per check. A consumer timeout does not itself cancel a dispatched producer;
producer cleanup and credential/lease limits remain separate.

### Telegram proof is a separate QA entrypoint

Telegram is not an option in `mantis-scenario.yml` or `qa mantis run`.
`pnpm openclaw qa telegram` uses the QA Lab Telegram adapter and the repository
skill at `.agents/skills/telegram-e2e-userbot/SKILL.md`. The skill also supports
focused real-user recordings through its own runner.

The skill uses TDLib against Telegram's Test Server, with an exclusively leased
Convex QA credential, a fresh Gateway, and an independent user observer.
Prerequisites include a dependency-ready exact-ref runtime, the pinned TDLib
setup, authenticated broker access, and distinct unused Gateway/provider ports.
Its doctor acquires a lease and contacts Telegram: it is a live operation, not
an offline readiness check. Do not run it without authorization for test-account
activity.

The recorder can observe messages, edits, deletions, reactions, and typing.
Judge events after the recorded stimulus from the selected SUT, correlate
message IDs and expected provider requests, and verify cleanup. The QA adapter's
current driver exposes a narrower message/edit stream; choose the entrypoint
whose observations actually cover the claim. A generic successful reply does
not prove formatting, reaction, lifecycle, or threading behavior.

Read the skill and its feature verification map before a Telegram exercise.
The credential lease is not a scenario sandbox: custom command actions can use
the leased test identity. Keep credential handling and execution in an explicitly
authorized, isolated worker, never an ordinary read-only review.

### Selected proof inside a ClawSweeper review

The request-bound proof integration lets ClawSweeper choose a relevant check
before finishing its current review. It does not run every check on every PR.
The exact PR head is resolved by the review, not typed by the maintainer.
`@clawsweeper proof` requests one review with proof available as a manual override;
the result is evaluated in that review rather than generating a second review.

The automatic surfaces are:

- Telegram Test Server: a bounded, data-only plan of tester messages and button
  clicks, deterministic model replies, streaming/native-command settings, and
  the behavior the reviewer needs to observe. This can cover more than a generic
  greeting, including selected formatting or command behavior.
- Control UI: the existing fixed chat smoke recipe against a mocked Gateway.
  This is not an arbitrary browser-task runner or proof of all UI behavior.

The separate fixed Crabline recipe remains a producer entrypoint; it is not a
third automatic tool or a mandatory three-check batch.

A trusted external controller owns the Telegram userbot and real bot token.
The candidate receives a disposable token alias and a restricted DM API proxy,
not the QA lease, Telegram session, GitHub token, or deployment credentials.
The candidate runs in a disposable Crabbox local-container on an internal
network without a Docker socket. Deployment requires a Linux/Podman environment
where this isolated Crabbox SSH lifecycle has been verified; a generic Docker
smoke run does not establish that compatibility.

The controller reuses the existing Convex acquire, heartbeat, payload, and
release APIs. No Convex schema update, quarantine endpoint, or broker deployment
is required. Review ownership and one-run authorization are checked by the
ClawSweeper service using the trusted workflow's GitHub Actions OIDC identity.
Expired or revoked authority stops privileged sends and proxy forwarding.
A recorder parent-death guard stops the recorder if its controller exits.
These safeguards do not claim that native TDLib background traffic is zero.

The Telegram artifact contains the bounded complete timeline, provider requests,
formatting entities, and button labels with known private values redacted.
Oversized or incomplete observations fail closed. Its assertion outcome stays
`inconclusive`: the original reviewer must assess the observations against the
claim. A green process exit, canned reply, or video does not automatically clear
proof or other readiness blockers. Bot registration/webhook operations are
simulated; live production Telegram, groups, media, and unrestricted agent
commands are outside this bounded plan.
Transport profile display names are synthetic, while routing IDs and the selected
bot username are retained where required. Message text is not rewritten by this
projection. Tests of real profile names or username-based tester routing are
outside this proof surface.

## Machines and secrets

Local CLI Crabbox defaults are `--provider hetzner --class beast`; override
with `--provider`, `--class`/`--machine-class`, or
`OPENCLAW_MANTIS_CRABBOX_PROVIDER` / `OPENCLAW_MANTIS_CRABBOX_CLASS`. GitHub
workflows commonly override both (for example `--class standard`, and the
Slack workflow's `aws`/`hetzner` provider choice input). If a provider is too
slow or unavailable, add it behind the same Crabbox interface rather than
hardcoding a fallback.

VM baseline: Linux with a desktop-capable Chrome/Chromium, CDP access, VNC/
noVNC, Node 24.16+ or 26.1+ and pnpm, an OpenClaw checkout, and
outbound access to the target transport, GitHub, model providers, and the
credential broker.

Credential and environment names used across Mantis commands and workflows:

- `OPENCLAW_QA_DISCORD_MANTIS_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_GUILD_ID`
- `OPENCLAW_QA_DISCORD_CHANNEL_ID`
- Local `qa mantis run --credential-source env` also requires
  `OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN`, `OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN`,
  and `OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID`. GitHub workflows normally use
  `--credential-source convex` and the broker credentials below instead of raw
  Discord bot tokens.
- `OPENCLAW_QA_REDACT_PUBLIC_METADATA=1` for public artifact uploads
- `OPENCLAW_QA_CONVEX_SITE_URL`, `OPENCLAW_QA_CONVEX_SECRET_CI`
- `OPENAI_API_KEY`
- `CRABBOX_COORDINATOR` / `CRABBOX_COORDINATOR_TOKEN` (workflows also accept
  `OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR` / `_TOKEN` as a fallback and map
  them onto the plain names before invoking Crabbox)
- `CRABBOX_ACCESS_CLIENT_ID`, `CRABBOX_ACCESS_CLIENT_SECRET`
- `MANTIS_GITHUB_APP_ID`, `MANTIS_GITHUB_APP_PRIVATE_KEY`

The Mantis runner must never print Discord or Slack bot tokens,
provider API keys, browser cookies, auth profile contents, VNC passwords, or
raw credential payloads. If a token leaks into an issue, PR, chat, or log,
rotate it after the replacement secret is stored.

## Run outcomes

Before/after transport scenarios distinguish these outcomes so a flaky
environment does not read as a product regression:

- **Bug reproduced**: baseline failed the way the scenario expects.
- **Harness failure**: environment setup, credentials, transport API, browser,
  or provider failed before the oracle was meaningful.

Candidate-only browser proof reports whether the candidate passed the mocked
Gateway and visible UI assertions; it does not claim baseline reproduction.

## Adding a scenario

Live transport scenarios are TypeScript-defined per transport (see
`MANTIS_SCENARIO_CONFIGS` in `extensions/qa-lab/src/mantis/run.runtime.ts` for
the Discord before/after shape), not a standalone declarative file format.
Each scenario needs: id and title, transport, required credentials, baseline
ref policy, candidate ref policy, OpenClaw config patch, setup/stimulus steps,
expected baseline and candidate oracle, visual capture targets, timeout
budget, and cleanup steps.

Focused candidate-only browser proof can use a dedicated deterministic E2E test
and workflow. Keep its scope explicit, validate the candidate ref before
execution, isolate secret-backed publishing, and emit the same evidence
manifest contract.

Prefer small, typed oracles over vision checks: Discord reaction state or
message references, Slack thread `ts`/reaction API state, email message ids
and headers. Use browser screenshots when UI is the only reliable observable,
and keep vision checks additive to a platform-API oracle where one exists.

After Discord and Slack, the same runner shape extends to WhatsApp (QR login,
re-identification, delivery, media, reactions) and Matrix (encrypted rooms,
thread/reply relations, restart resume); neither is implemented yet.

## Open questions

- Which Discord bot should be the driver vs. the SUT when the existing Mantis
  bot is reused?
- How long should GitHub retain Mantis artifacts for PRs?
- Should screenshots be redacted or cropped before upload for public PRs?
