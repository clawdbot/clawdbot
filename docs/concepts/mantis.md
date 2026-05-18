---
summary: "Mantis is the visual end-to-end verification system for reproducing OpenClaw bugs on live transports, capturing before and after evidence, and attaching artifacts to PRs."
title: "Mantis"
read_when:
  - Building or running live visual QA for OpenClaw bugs
  - Adding before and after verification for a pull request
  - Adding Discord, Slack, WhatsApp, or other live transport scenarios
  - Debugging QA runs that need screenshots, browser automation, or VNC access
---

Mantis is the OpenClaw end-to-end verification system for bugs that need a real
runtime, a real transport, and visible proof. It runs a scenario against a known
bad ref, captures evidence, runs the same scenario against a candidate ref, and
publishes the comparison as artifacts that a maintainer can inspect from a PR or
from a local command.

Mantis starts with Discord because Discord gives us a high-value first lane:
real bot auth, real guild channels, reactions, threads, native commands, and a
browser UI where humans can visually confirm what the transport showed.

## Goals

- Reproduce a bug from a GitHub issue or PR with the same transport shape users
  see.
- Capture a **before** artifact on the baseline ref before applying the fix.
- Capture an **after** artifact on the candidate ref after applying the fix.
- Use a deterministic oracle whenever possible, such as a Discord REST reaction
  read or channel transcript check.
- Capture screenshots when the bug has a visible UI surface.
- Run locally from an agent-controlled CLI and remotely from GitHub.
- Preserve enough machine state for VNC rescue when login, browser automation, or
  provider auth gets stuck.
- Post concise status to an operator Discord channel when the run is blocked,
  needs manual VNC help, or finishes.

## Non goals

- Mantis is not a replacement for unit tests. A Mantis run should usually become
  a smaller regression test after the fix is understood.
- Mantis is not the normal fast CI gate. It is slower, uses live credentials, and
  is reserved for bugs where the live environment matters.
- Mantis should not require a human for normal operation. Manual VNC is a rescue
  path, not the happy path.
- Mantis does not store raw secrets in artifacts, logs, screenshots, Markdown
  reports, or PR comments.

## Ownership

Mantis lives in the OpenClaw QA stack.

- OpenClaw owns the scenario runtime, transport adapters, evidence schema, and
  local CLI under `pnpm openclaw qa mantis`.
- QA Lab owns the live transport harness pieces, browser capture helpers, and
  artifact writers.
- Crabbox owns warmed Linux machines when a remote VM is needed.
- GitHub Actions owns the remote workflow entrypoint and artifact retention.
- ClawSweeper owns GitHub comment routing: parsing maintainer commands,
  dispatching the workflow, and posting the final PR comment.
- OpenClaw agents drive Mantis through Codex when a scenario needs agentic setup,
  debugging, or stuck-state reporting.

This boundary keeps transport knowledge in OpenClaw, machine scheduling in
Crabbox, and maintainer workflow glue in ClawSweeper.

## Command shape

The first local command verifies the Discord bot, guild, channel, message send,
reaction send, and artifact path:

```bash
pnpm openclaw qa mantis discord-smoke \
  --output-dir .artifacts/qa-e2e/mantis/discord-smoke
```

The local before and after runner accepts this shape:

```bash
pnpm openclaw qa mantis run \
  --transport discord \
  --scenario discord-status-reactions-tool-only \
  --baseline origin/main \
  --candidate HEAD \
  --output-dir .artifacts/qa-e2e/mantis/local-discord-status-reactions
```

The runner creates detached baseline and candidate worktrees under the output
directory, installs dependencies, builds each ref, runs the scenario with
`--allow-failures`, then writes `baseline/`, `candidate/`, `comparison.json`,
and `mantis-report.md`. For the first Discord scenario, a successful verification
means baseline status is `fail` and candidate status is `pass`.

The second Discord before/after probe targets thread attachments:

```bash
pnpm openclaw qa mantis run \
  --transport discord \
  --scenario discord-thread-reply-filepath-attachment \
  --baseline <bug-ref> \
  --candidate <fix-ref> \
  --output-dir .artifacts/qa-e2e/mantis/local-discord-thread-attachment
```

That scenario posts a parent message with the driver bot, creates a real Discord
thread, calls OpenClaw's `message.thread-reply` action with a repo-local
`filePath`, then polls the thread for the SUT reply and attachment filename. The
baseline screenshot shows the reply with no attachment; the candidate screenshot
shows the expected `mantis-thread-report.md` attachment.

The first VM/browser primitive is the desktop smoke:

```bash
pnpm openclaw qa mantis desktop-browser-smoke \
  --output-dir .artifacts/qa-e2e/mantis/desktop-browser
```

It leases or reuses a Crabbox desktop machine, starts a visible browser inside the
VNC session, captures the desktop, pulls artifacts back to the local output
directory, and writes the reconnect command into the report. The command defaults
to the Hetzner provider because it is the first provider with working desktop/VNC
coverage in the Mantis lane. Override it with `--provider`, `--crabbox-bin`, or
`OPENCLAW_MANTIS_CRABBOX_PROVIDER` when running against another Crabbox fleet.

Useful desktop smoke flags:

- `--lease-id <cbx_...>` or `OPENCLAW_MANTIS_CRABBOX_LEASE_ID` reuses a warmed desktop.
- `--browser-url <url>` changes the page opened in the visible browser.
- `--html-file <path>` renders a repo-local HTML artifact in the visible browser. Mantis uses this to capture the generated Discord status-reaction timeline through a real Crabbox desktop.
- `--browser-profile-dir <remote-path>` reuses a remote Chrome user-data-dir so a persistent Mantis desktop can stay logged in between runs. Use this for the long-lived Discord Web viewer profile.
- `--browser-profile-archive-env <name>` restores a base64 `.tgz` Chrome user-data-dir archive from the named environment variable before launching the browser. Use this for logged-in witnesses such as Discord Web. The default env var is `OPENCLAW_MANTIS_BROWSER_PROFILE_TGZ_B64`.
- `--video-duration <seconds>` controls the MP4 capture length. Use a longer duration for slow logged-in web apps that need time to settle.
- `--keep-lease` or `OPENCLAW_MANTIS_KEEP_VM=1` keeps a newly created passing lease open for VNC inspection. Failed runs keep the lease by default when one was created so an operator can reconnect.
- `--class`, `--idle-timeout`, and `--ttl` tune machine size and lease lifetime.

For Discord Web evidence, Mantis uses a dedicated viewer account instead of a
bot token. The live Discord API scenario remains the oracle: it creates the real
thread, sends the SUT `thread-reply`, and checks the attachment through Discord
REST. When `OPENCLAW_QA_DISCORD_CAPTURE_UI_METADATA=1` is set, the scenario also
writes a Discord Web URL artifact. When `OPENCLAW_QA_DISCORD_KEEP_THREADS=1` is
set, it leaves that thread available long enough for a logged-in browser to open
and record it.

The GitHub workflow opens the candidate thread URL in Discord Web, captures a
screenshot, records an MP4, and generates a trimmed GIF preview when Crabbox
media tooling is available. Prefer a persistent viewer profile path configured
through `MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR`, because full Chrome profile
archives can outgrow GitHub's secret-size limit. For small/bootstrap profiles,
the workflow can also restore a base64 `.tgz` archive from
`MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64`. If neither profile source is
configured, the workflow still publishes the deterministic baseline/candidate
attachment screenshots and logs a notice that the logged-in Discord Web witness
was skipped.

The first full desktop transport primitive is the Slack desktop smoke:

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --output-dir .artifacts/qa-e2e/mantis/slack-desktop \
  --gateway-setup \
  --scenario slack-canary \
  --keep-lease
```

It leases or reuses a Crabbox desktop machine, syncs the current checkout into
the VM, runs `pnpm openclaw qa slack` inside that VM, opens Slack Web in the VNC
browser, captures the visible desktop, and copies both the Slack QA artifacts and
the VNC screenshot back to the local output directory. This is the first Mantis
shape where the SUT OpenClaw gateway and the browser both live inside the same
Linux desktop VM.

With `--gateway-setup`, the command prepares a persistent disposable OpenClaw
home at `$HOME/.openclaw-mantis/slack-openclaw`, patches Slack Socket Mode
configuration for the selected channel, starts `openclaw gateway run` on port
`38973`, and keeps Chrome running in the VNC session. This is the "leave me a
Linux desktop with Slack and a claw running" mode; the bot-to-bot Slack QA lane
remains the default when `--gateway-setup` is omitted.

Required inputs for `--credential-source env`:

- `OPENCLAW_QA_SLACK_CHANNEL_ID`
- `OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_APP_TOKEN`
- `OPENCLAW_LIVE_OPENAI_KEY` for the remote model lane. If only
  `OPENAI_API_KEY` is set locally, Mantis maps it to `OPENCLAW_LIVE_OPENAI_KEY`
  before invoking Crabbox so Crabbox's `OPENCLAW_*` env forwarding can carry it
  into the VM.

With `--gateway-setup --credential-source convex`, Mantis leases the Slack SUT
credential from the shared pool before creating the VM and forwards the leased
channel id, Socket Mode app token, and bot token as the `OPENCLAW_MANTIS_SLACK_*`
runtime env inside the desktop. That keeps GitHub workflows thin: they only need
the Convex broker secret, not raw Slack bot or app tokens.

Useful Slack desktop flags:

- `--lease-id <cbx_...>` reruns against a machine where an operator already logged in to Slack Web through VNC.
- `--gateway-setup` starts a persistent OpenClaw Slack gateway in the VM instead of only running the bot-to-bot QA lane.
- `--keep-lease` keeps the gateway VM open for VNC inspection after success; `--no-keep-lease` stops it after collecting artifacts.
- `--slack-url <url>` opens a specific Slack Web URL. Without it, Mantis derives `https://app.slack.com/client/<team>/<channel>` from Slack `auth.test` when the SUT bot token is available.
- `--slack-channel-id <id>` controls the Slack channel allowlist used by gateway setup.
- `OPENCLAW_MANTIS_SLACK_BROWSER_PROFILE_DIR` controls the persistent Chrome profile inside the VM. The default is `$HOME/.config/openclaw-mantis/slack-chrome-profile`, so a manual Slack Web login survives reruns on the same lease.
- `--credential-source convex --credential-role ci` uses the shared credential pool instead of direct Slack env tokens.
- `--provider-mode`, `--model`, `--alt-model`, and `--fast` pass through to the Slack live lane.

The GitHub smoke workflow is `Mantis Discord Smoke`. The before and after GitHub
workflow for the first real scenario is `Mantis Discord Status Reactions`. It
accepts:

- `baseline_ref`: the ref expected to reproduce queued-only behavior.
- `candidate_ref`: the ref expected to show `queued -> thinking -> done`.

It checks out the workflow harness ref, builds separate baseline and candidate
worktrees, runs `discord-status-reactions-tool-only` against each worktree, and
uploads `baseline/`, `candidate/`, `comparison.json`, and `mantis-report.md` as
Actions artifacts. It also renders each lane's timeline HTML in a Crabbox
desktop browser and publishes those VNC screenshots beside the deterministic
timeline PNGs in the PR comment. The same PR comment embeds lightweight
motion-trimmed GIF previews generated by `crabbox media preview`, links to the
matching motion-trimmed MP4 clips, and keeps the full desktop MP4 files for deep
inspection. Screenshots stay inline for quick review. The workflow builds the
Crabbox CLI from
`openclaw/crabbox` main so it can use the current desktop/browser lease flags
before the next Crabbox binary release is cut.

`Mantis Scenario` is the generic manual entrypoint. It takes a `scenario_id`,
`candidate_ref`, optional `baseline_ref`, and optional `pr_number`, then
dispatches the scenario-owned workflow. The wrapper is intentionally thin:
scenario workflows still own their transport setup, credentials, VM class,
expected oracle, and artifact manifest.

`Mantis Slack Desktop Smoke` is the first Slack VM workflow. It checks out the
trusted candidate ref in a separate worktree, leases a Crabbox Linux desktop,
runs `pnpm openclaw qa mantis slack-desktop-smoke --gateway-setup` against that
candidate, opens Slack Web in the VNC browser, records the desktop, generates a
motion-trimmed preview with `crabbox media preview`, uploads the full artifact
directory, and optionally posts the inline evidence comment on the target PR.
It defaults to AWS for the desktop lease and exposes a manual provider input so
operators can switch to Hetzner when AWS capacity is slow or unavailable. Use
this lane when you want "a Linux desktop with Slack and a claw running" instead
of only a bot-to-bot Slack transcript.

`Mantis Telegram Live` wraps the existing Telegram live QA lane in the same PR
evidence pipeline. It checks out the trusted candidate ref in a separate
worktree, runs `pnpm openclaw qa telegram --credential-source convex
--credential-role ci`, writes a `mantis-evidence.json` manifest from the
Telegram QA summary and observed-message artifact, renders the redacted
transcript HTML through a Crabbox desktop browser, generates a motion-trimmed GIF
with `crabbox media preview`, and posts the inline PR evidence comment when a PR
number is available. This lane is transcript-visual rather than logged-in
Telegram Web proof: the Telegram Bot API gives stable live message evidence, but
Telegram Web login state is not required for normal Mantis automation.

`Mantis Telegram Desktop Proof` is the agentic native Telegram Desktop
before/after wrapper. A maintainer can trigger it from a PR comment with
`@openclaw-mantis telegram desktop proof`, from the Actions UI with freeform
instructions, or through the generic `Mantis Scenario` dispatcher. The workflow
hands the PR, baseline ref, candidate ref, and maintainer instructions to Codex.
The agent reads the PR, decides what Telegram-visible behavior proves the
change, runs the real-user Crabbox Telegram Desktop proof lane for baseline and
candidate, iterates until the native GIFs are useful, writes paired
`motionPreview` artifacts into `mantis-evidence.json`, uploads the bundle, and
posts a 2-column PR evidence table when a PR number is available.

For human-in-the-loop Telegram desktop setup, use the scenario builder:

```bash
pnpm openclaw qa mantis telegram-desktop-builder \
  --credential-source convex \
  --credential-role maintainer \
  --keep-lease
```

The builder leases or reuses a Crabbox desktop, installs the native Linux
Telegram Desktop binary, optionally restores a user-session archive, configures
OpenClaw with the leased Telegram SUT bot token, starts `openclaw gateway run`
on port `38974`, posts a driver-bot readiness message to the leased private
group, then captures a screenshot and MP4 from the visible VNC desktop. A bot
token never logs Telegram Desktop in; it only configures OpenClaw. The desktop
viewer is a separate Telegram user session restored from
`--telegram-profile-archive-env <name>` or created manually through VNC and kept
alive with `--keep-lease`.

Useful Telegram desktop builder flags:

- `--lease-id <cbx_...>` reruns against a VM where an operator already logged in to Telegram Desktop.
- `--telegram-profile-archive-env <name>` reads a base64 `.tgz` Telegram Desktop profile archive from that env var and restores it before launch.
- `--telegram-profile-dir <remote-path>` controls the remote Telegram Desktop profile directory. The default is `$HOME/.local/share/TelegramDesktop`.
- `--no-gateway-setup` installs and opens Telegram Desktop without configuring OpenClaw.
- `--credential-source convex --credential-role ci` uses the shared credential broker instead of direct Telegram env tokens.

Every PR-publishing scenario writes `mantis-evidence.json` next to its report.
This schema is the handoff between scenario code and GitHub comments:

```json
{
  "schemaVersion": 1,
  "id": "discord-status-reactions",
  "title": "Mantis Discord Status Reactions QA",
  "summary": "Human-readable top summary for the PR comment.",
  "scenario": "discord-status-reactions-tool-only",
  "comparison": {
    "baseline": { "sha": "...", "status": "fail", "expected": "queued-only" },
    "candidate": { "sha": "...", "status": "pass", "expected": "queued -> thinking -> done" },
    "pass": true
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

Artifact `path` values are relative to the manifest directory. `targetPath`
values are relative paths under the configured Mantis R2/S3 artifact prefix. The
publisher rejects path traversal and skips entries marked `"required": false`
when optional previews or videos are unavailable.

Supported artifact kinds:

- `timeline`: deterministic scenario screenshot, usually before/after.
- `desktopScreenshot`: VNC/browser desktop screenshot.
- `motionPreview`: inline animated GIF generated from the desktop recording.
- `motionClip`: motion-trimmed MP4 that removes static lead-in and tail.
- `fullVideo`: full MP4 recording for deep inspection.
- `metadata`: JSON/log sidecar.
- `report`: Markdown report.

The reusable publisher is `scripts/mantis/publish-pr-evidence.mjs`. Workflows
call it with the manifest, target PR, artifact target root, comment marker,
Actions artifact URL, run URL, and request source. It uploads declared artifacts
to the configured Mantis R2/S3 bucket, builds a summary-first PR comment with
inline images/previews and linked videos, then updates the existing marker
comment or creates one. The workflows publish to `openclaw-crabbox-artifacts`
with public URLs under `https://artifacts.openclaw.ai`. They provide bucket,
region, and public URL values directly. The reusable publisher requires:

- `MANTIS_ARTIFACT_R2_ACCESS_KEY_ID`
- `MANTIS_ARTIFACT_R2_SECRET_ACCESS_KEY`
- `MANTIS_ARTIFACT_R2_BUCKET`
- `MANTIS_ARTIFACT_R2_ENDPOINT`
- `MANTIS_ARTIFACT_R2_REGION`
- `MANTIS_ARTIFACT_R2_PUBLIC_BASE_URL`

You can also trigger the status-reactions run directly from a PR comment:

```text
@openclaw-mantis discord status reactions
```

The comment trigger is intentionally narrow. It only runs on pull request
comments from users with write, maintain, or admin access, and it only recognizes
Discord status-reaction requests. By default it uses the known bad baseline ref
and the current PR head SHA as the candidate. Maintainers can override either
ref:

```text
@openclaw-mantis discord status reactions baseline=origin/main candidate=HEAD
```

Telegram live QA can also be triggered from a PR comment:

```text
@openclaw-mantis telegram
@openclaw-mantis telegram scenario=telegram-status-command
@openclaw-mantis telegram scenarios=telegram-status-command,telegram-mentioned-message-reply
```

By default it uses the current PR head SHA as the candidate and runs
`telegram-status-command`. Maintainers can override `candidate=...`,
`provider=aws|hetzner`, and `lease=<cbx_...>` when they need a specific ref or a
pre-warmed Crabbox desktop.

ClawSweeper command examples:

```text
@clawsweeper mantis discord discord-status-reactions-tool-only
@clawsweeper verify e2e discord
```

The first command is explicit and scenario-focused. The second can later map a PR
or issue to recommended Mantis scenarios from labels, changed files, and
ClawSweeper review findings.

## Run lifecycle

1. Acquire credentials.
2. Allocate or reuse a VM.
3. Prepare the desktop/browser profile when the scenario needs UI evidence.
4. Prepare a clean checkout for the baseline ref.
5. Install dependencies and build only what the scenario needs.
6. Start a child OpenClaw Gateway with an isolated state directory.
7. Configure the live transport, provider, model, and browser profile.
8. Run the scenario and capture baseline evidence.
9. Stop the gateway and preserve logs.
10. Prepare the candidate ref in the same VM.
11. Run the same scenario and capture candidate evidence.
12. Compare the oracle results and visual evidence.
13. Write Markdown, JSON, logs, screenshots, and optional trace artifacts.
14. Upload GitHub Actions artifacts.
15. Post a concise PR or Discord status message.

The scenario should be able to fail in two different ways:

- **Bug reproduced**: baseline failed in the expected way.
- **Harness failure**: environment setup, credentials, Discord API, browser, or
  provider failed before the bug oracle was meaningful.

The final report must separate these cases so maintainers do not confuse a flaky
environment with product behavior.

## Discord MVP

The first scenario should target Discord status reactions in guild channels where
the source reply delivery mode is `message_tool_only`.

Why it is a good Mantis seed:

- It is visible in Discord as reactions on the triggering message.
- It has a strong REST oracle through Discord message reaction state.
- It exercises a real OpenClaw Gateway, Discord bot auth, message dispatch,
  source reply delivery mode, status reaction state, and model turn lifecycle.
- It is narrow enough to keep the first implementation honest.

Expected scenario shape:

```yaml
id: discord-status-reactions-tool-only
transport: discord
baseline:
  expect:
    reproduced: true
candidate:
  expect:
    fixed: true
config:
  messages:
    ackReaction: "👀"
    ackReactionScope: "group-mentions"
    groupChat:
      visibleReplies: "message_tool"
    statusReactions:
      enabled: true
      timing:
        debounceMs: 0
discord:
  requireMention: true
  notifyChannel: operator-notify
evidence:
  rest:
    messageReactions: true
  browser:
    screenshotMessageRow: true
```

Baseline evidence should show the queued acknowledgement reaction but no
lifecycle transition in tool-only mode. Candidate evidence should show lifecycle
status reactions running when `messages.statusReactions.enabled` is explicitly
true.

The executable first slice is the opt-in Discord live QA scenario:

```bash
pnpm openclaw qa discord \
  --scenario discord-status-reactions-tool-only \
  --provider-mode live-frontier \
  --model openai/gpt-5.4 \
  --alt-model openai/gpt-5.4 \
  --fast \
  --output-dir .artifacts/qa-e2e/mantis/discord-status-reactions-candidate
```

It configures the SUT with always-on guild handling, `visibleReplies:
"message_tool"`, `ackReaction: "👀"`, and explicit status reactions. The oracle
polls the real Discord triggering message and expects the observed sequence
`👀 -> 🤔 -> 👍`. Artifacts include `discord-qa-reaction-timelines.json`,
`discord-status-reactions-tool-only-timeline.html`, and
`discord-status-reactions-tool-only-timeline.png`.

## Existing QA pieces

Mantis should build on the existing private QA stack instead of starting from
zero:

- `pnpm openclaw qa discord` already runs a live Discord lane with driver and
  SUT bots.
- The live transport runner already writes reports and observed-message
  artifacts under `.artifacts/qa-e2e/`.
- Convex credential leases already provide exclusive access to shared live
  transport credentials.
- The browser control service already supports screenshots, snapshots,
  headless managed profiles, and remote CDP profiles.
- QA Lab already has a debugger UI and bus for transport-shaped testing.

The first Mantis implementation can be a thin before/after runner over these
pieces, plus one visual evidence layer.

## Evidence model

Every run writes a stable artifact directory:

```text
.artifacts/qa-e2e/mantis/<run-id>/
  mantis-report.md
  mantis-summary.json
  baseline/
    summary.json
    discord-message.json
    screenshot-message-row.png
    gateway-debug/
  candidate/
    summary.json
    discord-message.json
    screenshot-message-row.png
    gateway-debug/
  comparison.json
  run.log
```

`mantis-summary.json` should be the machine-readable source of truth. The
Markdown report is for PR comments and human review.

The summary must include:

- refs and SHAs tested
- transport and scenario id
- machine provider and machine id or lease id
- credential source without secret values
- baseline result
- candidate result
- whether the bug reproduced on baseline
- whether the candidate fixed it
- artifact paths
- sanitized setup or cleanup issues

Screenshots are evidence, not secrets. They still need redaction discipline:
private channel names, user names, or message content may appear. For public PRs,
prefer GitHub Actions artifact links over inline images until the redaction story
is stronger.

## Browser and VNC

The browser lane has two modes:

- **Headless automation**: default for CI. Chrome runs with CDP enabled, and
  Playwright or OpenClaw browser control captures screenshots.
- **VNC rescue**: enabled on the same VM when login, MFA, Discord anti-automation,
  or visual debugging needs a human.

The Discord observer browser profile should be persistent enough to avoid
logging in for every run, but isolated from personal browser state. A profile
belongs to the Mantis machine pool, not to a developer laptop.

When Mantis gets stuck, it posts a Discord status message with:

- run id
- scenario id
- machine provider
- artifact directory
- VNC or noVNC connection instructions if available
- short blocker text

The first private deployment can post these messages to the existing operator
channel and move to a dedicated Mantis channel later.

## Machines

Mantis should prefer AWS through Crabbox for the first remote implementation.
Crabbox gives us warmed machines, lease tracking, hydration, logs, results, and
cleanup. If AWS capacity is too slow or unavailable, add a Hetzner provider
behind the same machine interface.

Minimum VM requirements:

- Linux with a desktop-capable Chrome or Chromium install
- CDP access for browser automation
- VNC or noVNC for rescue
- Node 22 and pnpm
- OpenClaw checkout and dependency cache
- Playwright Chromium browser cache when Playwright is used
- enough CPU and memory for one OpenClaw Gateway, one browser, and one model run
- outbound access to Discord, GitHub, model providers, and the credential broker

The VM should not keep long-lived raw secrets outside the expected credential or
browser profile stores.

## Secrets

Secrets live in GitHub organization or repository secrets for remote runs, and in
a local operator-controlled secret file for local runs.

Recommended secret names:

- `OPENCLAW_QA_DISCORD_MANTIS_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_GUILD_ID`
- `OPENCLAW_QA_DISCORD_CHANNEL_ID`
- `OPENCLAW_QA_DISCORD_NOTIFY_CHANNEL_ID`
- `OPENCLAW_QA_REDACT_PUBLIC_METADATA=1` for public GitHub artifact uploads
- `OPENCLAW_QA_CONVEX_SITE_URL`
- `OPENCLAW_QA_CONVEX_SECRET_CI`
- `OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR`
- `OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR_TOKEN`

Long term, the Convex credential pool should remain the normal source for live
transport credentials. GitHub secrets bootstrap the broker and fallback lanes.
The Discord status-reactions workflow maps the Mantis Crabbox secrets back to
the `CRABBOX_COORDINATOR` and `CRABBOX_COORDINATOR_TOKEN` environment variables
that the Crabbox CLI expects. The plain `CRABBOX_*` GitHub secret names remain
accepted as a compatibility fallback.

The Mantis runner must never print:

- Discord bot tokens
- provider API keys
- browser cookies
- auth profile contents
- VNC passwords
- raw credential payloads

Public artifact uploads should also redact Discord target metadata such as bot,
guild, channel, and message ids. The GitHub smoke workflow enables
`OPENCLAW_QA_REDACT_PUBLIC_METADATA=1` for this reason.

If a token is accidentally pasted into an issue, PR, chat, or log, rotate it
after the new secret has been stored.

## GitHub artifacts and PR comments

Mantis workflows should upload the full evidence bundle as a short-lived Actions
artifact. When the workflow is run for a bug report or fix PR, it should also
publish redacted inline media to the configured Mantis R2/S3 bucket and upsert a
comment on that bug or fix PR with inline before/after screenshots. Do not post
the primary proof only on a generic QA automation PR. Raw logs, observed
messages, and other bulky evidence stay in the Actions artifact.

Production workflows should post those comments with the Mantis GitHub App, not
with `github-actions[bot]`. Store the app id and private key as
`MANTIS_GITHUB_APP_ID` and `MANTIS_GITHUB_APP_PRIVATE_KEY` GitHub Actions
secrets. The workflow uses a hidden marker as the upsert key, updates that
comment when the token can edit it, and creates a new Mantis-owned comment when
an older bot-owned marker cannot be edited.

The PR comment should be short and visual:

```md
Mantis Discord Status Reactions QA

Summary: Mantis reran the reported Discord status-reaction bug against the known
bad baseline and the candidate fix. The baseline reproduced the bug, while the
candidate showed the expected queued -> thinking -> done sequence.

- Scenario: `discord-status-reactions-tool-only`
- Run: <workflow run link>
- Artifact: <artifact link>
- Baseline: `<status>` at `<sha>`
- Candidate: `<status>` at `<sha>`

| Baseline            | Candidate           |
| ------------------- | ------------------- |
| <inline screenshot> | <inline screenshot> |
```

When the run fails because the harness failed, the comment must say that instead
of implying the candidate failed.

## Private deployment notes

A private deployment may already have a Mantis Discord application. Reuse that
application instead of creating another app when it has the right bot
permissions and can be safely rotated.

Set the initial operator notification channel through secrets or deployment
configuration. It can point at an existing maintainer or operations channel
first, then move to a dedicated Mantis channel once one exists.

Do not put guild ids, channel ids, bot tokens, browser cookies, or VNC passwords
in this document. Store them in GitHub secrets, the credential broker, or the
operator's local secret store.

## Adding a scenario

A Mantis scenario should declare:

- id and title
- transport
- required credentials
- baseline ref policy
- candidate ref policy
- OpenClaw config patch
- setup steps
- stimulus
- expected baseline oracle
- expected candidate oracle
- visual capture targets
- timeout budget
- cleanup steps

Scenarios should prefer small, typed oracles:

- Discord reaction state for reaction bugs
- Discord message references for threading bugs
- Slack thread ts and reaction API state for Slack bugs
- email message ids and headers for email bugs
- browser screenshots when UI is the only reliable observable

Vision checks should be additive. If a platform API can prove the bug, use the
API as the pass/fail oracle and keep screenshots for human confidence.

## Provider expansion

After Discord, the same runner can add:

- Slack: reactions, threads, app mentions, modals, file uploads.
- Email: Gmail auth and message threading using `gog` where connectors are not
  enough.
- WhatsApp: QR login, re-identification, message delivery, media, reactions.
- Telegram: group mention gating, commands, reactions where available.
- Matrix: encrypted rooms, thread or reply relations, restart resume.

Each transport should have one cheap smoke scenario and one or more bug-class
scenarios. Expensive visual scenarios should stay opt-in.

## Open questions

- Which Discord bot should be the driver, and which should be the SUT, when the
  existing Mantis bot is reused?
- Should the observer browser login use a human Discord account, a test account,
  or only bot-readable REST evidence for the first phase?
- How long should GitHub retain Mantis artifacts for PRs?
- When should ClawSweeper automatically recommend Mantis instead of waiting for a
  maintainer command?
- Should screenshots be redacted or cropped before upload for public PRs?
