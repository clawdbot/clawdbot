---
name: openclaw-release-validation
description: "Test the latest OpenClaw main commit through an isolated OCM copy or an explicitly approved in-place gateway update, then guide structured release feedback."
user-invocable: true
disable-model-invocation: true
---

# OpenClaw Release Validation

Help a human validate the latest main commit against a real gateway's state. By
default, protect the source with an isolated OCM copy; allow an explicitly
approved in-place update when the tester prefers less setup. Automate only
preparation, finding triage, and reporting. Let the human drive OpenClaw and
judge quality.

For a ready gateway, use one editable Markdown worksheet as the entire
candidate-validation record. A blocked upgrade has no worksheet or
surface-testing phase; its final report draft is the only local candidate
record. A redacted tooling-feedback packet is the one exception: create it only
when OCM, setup, build, backup, or cleanup tooling fails, and never treat it as
candidate feedback. Do not create `run.json`, mission state, receipts, or other
tracking files.

## Check this skill before an interactive workflow

When `RELEASE_VALIDATION_ARTIFACT_PATH` is present, this is the non-interactive
**Campaign artifact** workflow. Skip this section entirely: do not make a
network request or prompt for a skill update.

For **Validate release** and **Update campaign**, before the introduction or
checklist, resolve this loaded skill's directory from the available skill
catalog and run:

```sh
node <skill-directory>/scripts/check-update.mjs
```

Read its JSON and show one concise status line with the installed ClawHub
source and version, the current canonical ClawHub version, and the comparison
status. Do not show local paths. This check is read-only.

When `status` is `update-available` and `localModifications` is `false`, ask:

```text
A newer canonical release-validation skill is available. Would you like me to
upgrade it before validation?

Reply exactly `upgrade release-validation skill` or `continue with current skill`.
```

When `status` is `update-available` and `localModifications` is `true`, say that
the installed copy has local modifications and ask:

```text
A newer canonical release-validation skill is available, but this installed
copy has local modifications. Upgrading will replace those modifications.

Reply exactly `upgrade release-validation skill and replace local modifications`
or `continue with current skill`.
```

Wait for the applicable reply. On either approved upgrade reply, run the
checker's exact `update.command` arguments from `update.cwd`; do not construct a
different install command. Rerun the checker and require `status: current`.
Then stop this run and tell the tester to start a fresh task and invoke the
skill again, because the current task has already loaded the old instructions.
Never continue release validation in that task after changing the skill.

On `continue with current skill`, continue normally. For `current`, continue
without asking. For `ahead-of-latest`, `local-modifications`,
`different-source`, `untracked`, or `check-failed`, report the installed source
and version plus the status briefly and continue without offering an automated
update; the checker could not prove that replacing this copy is safe.

## Start the run

At the start of every **Validate release** run, give a concise introduction:
this skill finds a gateway, asks whether to protect it with an isolated OCM
copy or update it in place, moves the selected test gateway to an immutable
build of the latest `origin/main`, reports update problems, then helps the
tester manually check it, triage findings, and submit one consolidated report
to the stable release train's shared issue. OCM isolation is recommended and
must pass containment checks before any candidate runs; in-place mode modifies
the selected real gateway only after explicit approval.

Use the agent's available native checklist or plan tool to show progress and
check items off as they complete. Start with this visible checklist:

1. Confirm the release campaign and main test target
2. Choose a gateway and test mode
3. Prepare, update, and verify readiness
4. Optionally capture local diagnostics
5. Create the testing worksheet
6. Test surfaces and record feedback
7. Draft, review, and publish feedback

For **Update campaign**, instead explain that the run dispatches the isolated
GitHub workflow which refreshes the stable release train's shared testing
dashboard, waits for its result, then ends. Use a three-item checklist:
identify release train, dispatch the campaign runner, verify the issue.
**Campaign artifact** is non-interactive CI work and does not show a checklist.

## Workflows

Choose the workflow from the request:

- **Update campaign** dispatches `release-validation-skill-runner.yml` on the
  default branch for an explicit beta or stable tag, waits for it, prints the
  resulting issue URL, and stops. It never analyzes or writes the issue itself.
- **Campaign artifact** runs only when `RELEASE_VALIDATION_ARTIFACT_PATH` is
  present. It analyzes the selected release using the instructions below and
  writes the publisher artifact. GitHub is read-only in this workflow.
- **Validate release** is the default human-testing path. Join the existing
  campaign issue, choose an isolated-copy or in-place lane, move the selected
  test gateway to the latest immutable `origin/main`, then guide testing and
  finding triage. This workflow never creates or rewrites the canonical issue
  body.

Before the upgrade reaches a terminal ready or blocked result, keep tester-facing
output to the campaign issue, current-beta identity, gateway choice, and upgrade
progress or errors. The worksheet, priority surfaces, testing instructions, and
`finish validation` phrase are disclosed only after that gate.

## 1. Release train and shared issue

Normalize a beta tag `vYYYY.M.D-beta.N` to the stable train `vYYYY.M.D`. The
canonical issue, label, title, and hidden marker belong to that train; the body
also records the current beta. Testing still targets an immutable latest
`origin/main` SHA.

When the request supplies an issue URL or number in **Validate release**,
resolve it directly with `gh issue view`. Accept it only when it is open, has
the exact `release-validation` label, and contains
`<!-- openclaw-release-validation:<stable-train> -->`. Read the current beta
from the body. Do not search releases or issues first.

When no issue is supplied, use an explicit beta or stable tag when supplied.
Otherwise run `gh api 'repos/openclaw/openclaw/releases?per_page=100'` once and
select the newest published `vYYYY.M.D-beta.N` locally. Do not paginate. If the
bounded response has no beta, ask for an explicit tag.

Without a supplied issue, find the campaign with one bounded lookup:

```sh
gh api 'repos/openclaw/openclaw/issues?state=open&labels=release-validation&per_page=2'
```

Ignore pull requests. Require at most one issue with the label. The label is
the fast index; the stable-train marker is the identity check. Multiple issues
or a different marker are conflicts: show their URLs and stop. Never fall back
to an unbounded issue scan.

In **Validate release**, compare the selected latest beta with the issue's
exact `- Current beta:` line. If the issue is absent or names an older beta,
dispatch the runner. Generate a request id containing UTC time plus a short
random suffix, then run:

```sh
gh workflow run release-validation-skill-runner.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f tag=<selected-beta> \
  -f request_id=<request-id>
```

When the tester supplied an existing issue that still has a legacy
beta-specific marker, also pass `-f campaign_issue=<number>` for that one-time
migration. Never infer an unlabeled issue number from search results.

Find the run by that request id with one bounded `gh run list --workflow
release-validation-skill-runner.yml --event workflow_dispatch --limit 20`, then
wait with `gh run watch <run-id> --exit-status`. On success, repeat the bounded
issue lookup and require the marker and current-beta line to match. If dispatch
is forbidden, stop with the exact permission error and say that a repository
operator must run the workflow. If the workflow fails, show its URL and stop.
Do not prepare or update a gateway without a current campaign.

In **Update campaign**, always dispatch the same workflow for the selected
explicit tag, wait for it by request id, and verify the resulting issue state.
This is intentionally independent of beta publication and never blocks a
release.

Whenever the workflow reaches its issue announcement, use this exact shape with
one raw URL and no commentary about discovery or campaign counts:

```text
Issue: https://github.com/openclaw/openclaw/issues/<number>
```

In **Validate release**, announce the issue once, read the current beta tag and
commit from its body, and copy the exact bytes between
`<!-- validation-guidance:start -->` and `<!-- validation-guidance:end -->` into
the private worksheet. After announcing it, resolve the test target and show
`Test target: origin/main at <full SHA>`. The campaign beta describes the
guidance; that immutable main SHA is the runtime being tested.

In **Campaign artifact**, use the exact tag, release commit, and guidance-main
SHA supplied in `RELEASE_VALIDATION_TAG`,
`RELEASE_VALIDATION_RELEASE_COMMIT`, and
`RELEASE_VALIDATION_GUIDANCE_MAIN_SHA`. For a beta tag:

1. Resolve its stable train, release URL, commit, the previous stable release,
   and one immutable guidance SHA from the current `origin/main`. Record that
   exact SHA; both analysis windows end there.
2. Fetch `https://docs.openclaw.ai/maturity/scorecard.md`. Extract the live
   surface names, taxonomy links, M-levels, maturity labels, and score-band
   guidance. Stop if it cannot be parsed; never use a hardcoded catalog.
3. Read complete release notes and source history. Group all user-visible and
   upgrade-sensitive changes under live scorecard surfaces for two windows:
   previous stable through the guidance-main SHA, and the current beta commit
   through that same guidance-main SHA. The first window describes the release
   train overall; the second highlights what has landed on main since the
   current beta was cut. Use PR and commit details for analysis, but publish
   themes rather than a misleading sample of links.
4. Rank exactly three surfaces for each window using change volume, size,
   complexity, impact, upgrade sensitivity, and maturity expectations. A
   Stable or Clawesome surface carries more regression weight. Duplicate
   surfaces across the two lists are allowed. Do not publish numeric scores.
5. Render each selected surface as:

   ```md
   ### [surface](taxonomy-url)

   | **Maturity score**      | <M-level and label>                                          |
   | ----------------------- | ------------------------------------------------------------ |
   | **What changed**        | <dominant themes>                                            |
   | **Recommended testing** | <action and pass condition, with command or URL when useful> |
   | **Testing notes**       |                                                              |
   ```

   Keep **Testing notes** empty. Escape table pipes. Recommended testing must
   be one bounded, human-driven action with an observable pass condition. Use
   `{{OPENCLAW}}` wherever the tester should invoke the selected gateway and
   `{{RESTART_GATEWAY}}` for its restart command. Do not assume OCM, add other
   execution placeholders, or say only "use" or "verify."

6. Replace the issue title with `OpenClaw <YYYY.M.D> beta feedback`. Render the
   body in this order, with no beta-history section:

   ```md
   <!-- openclaw-release-validation:<stable-train> -->

   - Current beta: [<beta-tag>](release-url)
   - Beta commit: `<full-commit>`
   - Guidance main commit: `<full-guidance-main-sha>`
   - Test target: latest immutable `origin/main`

   > [!NOTE]
   > <live scorecard and maturity-band explanation; any surface may be tested>

   <!-- validation-guidance:start -->

   ## Priority surfaces for this release

   <exactly three surface tables>

   ## Priority surfaces since <current-beta>

   <exactly three surface tables>
   <!-- validation-guidance:end -->

   ## Participate

   <concise instruction to run this skill>
   ```

7. Write this exact JSON shape to `RELEASE_VALIDATION_ARTIFACT_PATH`:

   ```json
   {
     "schema": "openclaw.release-validation-campaign/v1",
     "operation": "upsert",
     "tag": "<exact beta tag>",
     "stableTrain": "<vYYYY.M.D>",
     "releaseUrl": "https://github.com/openclaw/openclaw/releases/tag/<tag>",
     "releaseCommit": "<exact supplied release commit>",
     "guidanceMainSha": "<exact supplied guidance SHA>",
     "title": "OpenClaw <YYYY.M.D> beta feedback",
     "body": "<rendered body>"
   }
   ```

   Write valid JSON, not a Markdown fence. Create no other files and do not
   call a GitHub mutation API.

For a stable tag, skip analysis and write this exact JSON shape to
`RELEASE_VALIDATION_ARTIFACT_PATH`:

```json
{
  "schema": "openclaw.release-validation-campaign/v1",
  "operation": "close",
  "tag": "<exact stable tag>",
  "stableTrain": "<same exact stable tag>",
  "releaseUrl": "https://github.com/openclaw/openclaw/releases/tag/<tag>"
}
```

The trusted publisher validates every field, creates the two release-validation
labels when needed, updates or creates the campaign, preserves comments, and
closes older campaigns. Campaign publishing is deliberately last-writer-simple;
release orchestration does not launch overlapping update tasks.

## 2. Choose a real gateway and test mode

Gateway discovery does not require OCM. Check whether `ocm` is available. If it
is, read `ocm --version` and discover managed environments once with `ocm env
list --json`; otherwise continue without installing it. In parallel, inspect
the plain personal gateway with `openclaw --version` and `openclaw gateway
status --json --no-probe`. When OCM is available, also use `ocm adopt inspect
~/.openclaw --json` to resolve aliases safely.

Read only each gateway's display name, OpenClaw version, and running/stopped
state. Do not expose commands, paths, configuration, credentials, plugins, or
other internals. If the plain home's resolved path is an OCM environment's
`stateDir`, show it once as that environment's personal-state alias. Otherwise
show `Personal ~/.openclaw` with its known version and state. Ask which gateway
the tester wants to use. Never silently select or modify the personal gateway.

After selection, inspect only that gateway and record its version and commit.
Then ask:

```text
How should I test this gateway?

1. Use an isolated OCM copy (recommended) — tests a disposable copy and fails
   closed if OCM cannot prove candidate-writable paths stay inside it.
2. Update the selected gateway in place — changes this real gateway to the
   latest main build, restarts it, and may update its plugins and state.

Reply exactly `use isolated OCM copy` or `update selected gateway in place`.
```

Do not infer the mode. The second reply selects the in-place lane but does not
yet authorize mutation; show its backup/snapshot and dry-run result first, then
obtain the separate approval required in section 3.

### Isolated OCM copy

If OCM is unavailable only after the tester chooses isolation, say:

```text
OCM is required for the isolated-copy option and is not installed.

Reply exactly `install OCM` to let me install the OpenClaw Manager CLI, or
install it yourself and reply `OCM installed`.
```

Install OCM only after `install OCM`, using the official installer, then verify
it before continuing:

```sh
curl -fsSL https://github.com/openclaw/ocm/releases/latest/download/install.sh | bash
ocm --version
```

If the binary lands in `~/.local/bin` outside the current PATH, use its absolute
path for this run and tell the tester how to update future shells. On an install
or verification failure, report the exact error and pause. Never replace OCM
with a manual state copy.

If the source is already an OCM environment, clone it through OCM. If the
source is the plain personal gateway, preview and import that plain home:

```sh
ocm env clone <source-env> <test-env> --json
# Plain source only:
ocm adopt plan --name <test-env> ~/.openclaw --json
ocm adopt import --name <test-env> ~/.openclaw --json
```

Do not import an OCM environment through its underlying state path. Let OCM
create the stopped environment and assign a non-conflicting port; do not make
an additional staged copy. Use the returned environment name in every command.
If OCM cannot isolate an include, workspace, or source path, pause and report
that setup blocker conversationally. Never make a manual copy or put an OCM
setup failure in campaign feedback.

Treat containment as a hard gate, not a warning. Capture stderr even when using
`--json`. If adopt/import reports `could not be isolated inside the env state`,
or clone/import/plugin inventory reveals any absolute plugin install or source
path outside the target environment, do not build, upgrade, or start the
candidate. Do not normalize or copy the path manually. State that OCM isolation
could not be proven and offer the tester the mode choice again, including the
explicit in-place lane. This protects against the unresolved source-state escape
tracked in `openclaw/ocm#98`.

Before activating copied channel credentials, stop the current credential
owner and restore it when validation ends. For an OCM source, use `ocm service
stop <source-env>`; for the plain source, use `openclaw gateway stop`. There is
no `ocm stop` command.

### In-place gateway

Do not copy the selected gateway. A plain gateway will use its own `openclaw`
CLI and a managed OCM environment will use that environment's OCM commands.
Do not install OCM merely for a plain in-place update. Do not stop another
credential owner: this gateway keeps ownership while its own service restarts.

## 3. Move to the latest main target and report errors

For every **Validate release** run, resolve a fresh immutable main target after
the campaign issue and test mode are known. Never use the caller's active
checkout. Resolve exactly one SHA. For either OCM lane, also create a run-owned
isolated checkout at that SHA and prove it did not move:

```sh
main_sha="$(git ls-remote https://github.com/openclaw/openclaw.git refs/heads/main | awk 'NR == 1 { print $1 }')"
test "$(printf '%s' "$main_sha" | wc -c | tr -d ' ')" = 40
main_checkout="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-validation-main.XXXXXX")"
git -C "$main_checkout" init -q
git -C "$main_checkout" remote add origin https://github.com/openclaw/openclaw.git
git -C "$main_checkout" fetch --depth 1 origin "$main_sha"
git -C "$main_checkout" checkout --detach -q FETCH_HEAD
test "$(git -C "$main_checkout" rev-parse HEAD)" = "$main_sha"
```

If main resolution, fetch, checkout, or SHA verification fails, report the setup
blocker conversationally and pause. Do not fall back to a moving branch, caller
checkout, or current beta package.

### OCM isolated or OCM-managed in-place lane

Give the run-owned runtime a unique name containing the short main SHA and a UTC
timestamp, then build and verify the exact checkout:

```sh
ocm runtime build-local <run-runtime-name> --repo <main-checkout> --force
ocm runtime verify <run-runtime-name>
ocm upgrade <test-env> --runtime <run-runtime-name> --dry-run --json
```

For an OCM-managed in-place gateway, explain that OCM will create a pre-upgrade
snapshot and retain a rollback transaction. Show the dry-run summary, then wait
for the tester to reply exactly `approve in-place update`. Without that reply,
do not mutate or start anything. The isolated lane needs no additional approval.

Then run:

```sh
ocm upgrade <test-env> --runtime <run-runtime-name> --json
ocm service start <test-env>
```

In the isolated lane, stop any current owner of copied channel credentials
immediately before `ocm service start`. Skip the explicit start when the upgrade
already preserved a running service. Verify `ocm service status <test-env>`,
`ocm @<test-env> -- --version`, and `ocm logs <test-env> --tail 100`. OCM's
successful managed upgrade already requires HTTP health and gateway
reachability.

### Plain in-place lane

First inspect `openclaw update status --json`. Create a full verified backup in
a private owner-only directory outside `~/.openclaw`, retain its resulting
archive path, and never expose that path in GitHub output:

```sh
openclaw backup create --output <private-backup-dir> --verify
OPENCLAW_UPDATE_DEV_TARGET_REF="$main_sha" openclaw update --channel dev --dry-run --json
```

Explain that the update switches this real installation to the dev channel,
builds the pinned main commit, may migrate state and plugins, and restarts the
gateway. Show the verified backup result and dry-run summary, then wait for the
tester to reply exactly `approve in-place update`. Without that reply, do not
mutate the gateway.

Apply and verify:

```sh
OPENCLAW_UPDATE_DEV_TARGET_REF="$main_sha" openclaw update --channel dev --yes --json
openclaw update status --json
openclaw --version
openclaw gateway status --json
openclaw plugins list --json
```

Require the update result to succeed, its `after.sha` and the status result's
Git SHA to equal `main_sha`, and the managed gateway to be healthy. If any are
missing or disagree, do not call the gateway ready.

For every lane, record `origin/main` and the full `main_sha` as the tested target
and commit. Keep the stable train, current beta tag, and beta commit separate.

Report every error immediately, including errors recovered by a retry. OpenClaw
config migration, update, plugin convergence, startup, and readiness failures
from the selected test target are eligible **Upgrade findings**. Add them to the
worksheet only when readiness is later verified. OCM tooling, copying, backup
plumbing, local build setup, and cleanup failures never enter the worksheet,
candidate finding drafts, campaign report, hidden payload, or Discord summary
details. On the first such failure, read and apply
[the tooling-feedback packet procedure](references/tooling-feedback.md). A
tooling-only blocker is not an Upgrade finding.

As soon as an eligible upgrade finding is concrete, run the related-issue
investigation from section 6 and queue its private draft. Do this before manual
surface testing; do not wait until wrap-up.

Complete this step only when test-target readiness is either verified or blocked
with a concrete terminal finding. Do not continue to testing while the upgrade
or gateway readiness is unresolved.

If candidate-owned readiness is **blocked**, this is a terminal
upgrade-validation result: mark the optional diagnostics, worksheet, and
surface-testing checklist items as skipped. Do not create, open, mention, or
ask the tester to use a worksheet; there is no running gateway to test. State
plainly:

```text
Upgrade blocked — the selected test gateway never became ready, so manual surface testing cannot begin.
Reply exactly `finish validation` to prepare a reviewable report of this upgrade finding, or tell me any final feedback to include.
```

Then wait for final feedback or `finish validation`.

If tooling blocked preparation before candidate-owned readiness could be
evaluated, follow the tooling-feedback procedure instead. Do not use the
Upgrade finding prompt above or prepare candidate feedback.

## 4. Optional local diagnostics capture

Offer this step only after an isolated OCM target is ready. For either in-place
lane, mark diagnostics skipped and say no telemetry plugin will be installed on
the tester's real gateway. For an isolated target, say:

```text
Optional local diagnostics can capture traces, metrics, and logs from this
test gateway. It installs OpenClaw's diagnostics-otel plugin only in the
disposable copy and sends OTLP only to a collector on this machine. Content
capture stays off. Nothing is sent to a hosted endpoint, and you will review
the exact release-report draft before any GitHub comment is posted.

Reply exactly `enable local diagnostics` to enable it, or `skip local diagnostics` to continue without it.
```

Do nothing until the tester chooses. If they skip it, record no diagnostic
state and continue to the worksheet. If Docker is unavailable or its daemon is
not running, state that local diagnostics are unavailable and continue without
it. Do not install Docker, use a hosted collector, or fall back to a remote
endpoint.

When the tester replies `enable local diagnostics`:

1. Create a `telemetry/` directory beside the private local worksheet artifact
   directory. It is private run data, not worksheet content and never GitHub
   content. Create this collector configuration as `otel-collector.yaml` in
   that directory:

   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318
   processors:
     batch:
       timeout: 1s
       send_batch_size: 256
   exporters:
     file/traces:
       path: /telemetry/traces.jsonl
       rotation:
         max_megabytes: 8
         max_backups: 1
     file/metrics:
       path: /telemetry/metrics.jsonl
       rotation:
         max_megabytes: 8
         max_backups: 1
     file/logs:
       path: /telemetry/logs.jsonl
       rotation:
         max_megabytes: 8
         max_backups: 1
   service:
     telemetry:
       logs:
         level: warn
     pipelines:
       traces:
         receivers: [otlp]
         processors: [batch]
         exporters: [file/traces]
       metrics:
         receivers: [otlp]
         processors: [batch]
         exporters: [file/metrics]
       logs:
         receivers: [otlp]
         processors: [batch]
         exporters: [file/logs]
   ```

2. Start one run-owned collector with the maintained, pinned
   `otel/opentelemetry-collector-contrib:0.104.0` image. Mount the configuration
   read-only and the private telemetry directory read-write. Use
   `-p 127.0.0.1::4318` so Docker chooses an unused host port and publishes it
   only on loopback. Use `--read-only`, `--cap-drop=ALL`,
   `--security-opt no-new-privileges`, `--pids-limit 128`, and a small `/tmp`
   tmpfs. Inspect the running container and resolve its assigned host port with
   `docker port <collector-name> 4318/tcp`. Require a `127.0.0.1:<port>`
   binding; stop the collector and skip capture if anything else is exposed.
   The collector configuration has file exporters only: never add an exporter,
   endpoint, header, or credential supplied by the source gateway.
3. Install the current official ClawHub package into the fixture only:
   `ocm @<test-env> -- plugins install clawhub:@openclaw/diagnostics-otel`.
   The test target verifies the plugin API compatibility during installation.
   Require a successful `plugins inspect diagnostics-otel --json` that reports
   the official ClawHub source and an accepted compatible version. If that
   compatibility check fails, stop the collector, report capture unavailable,
   and continue without diagnostics. Do not force the install, use a local code
   checkout, or select an unverified package version. Enable it with
   `ocm @<test-env> -- plugins enable diagnostics-otel`.
4. Replace only the fixture's `diagnostics.otel` object with this exact JSON
   value using
   `ocm @<test-env> -- config set diagnostics.otel <json> --strict-json`. Do not
   merge, so old signal-specific or remote endpoints cannot survive:

   ```json
   {
     "enabled": true,
     "endpoint": "http://127.0.0.1:<assigned-port>",
     "protocol": "http/protobuf",
     "serviceName": "openclaw-release-validation",
     "traces": true,
     "metrics": true,
     "logs": true,
     "logsExporter": "otlp",
     "sampleRate": 1,
     "flushIntervalMs": 1000,
     "captureContent": false
   }
   ```

   Also set `diagnostics.enabled` to `true`, validate the fixture config, then
   restart it through `ocm service restart <test-env>`. Verify the plugin is
   enabled, the collector remains loopback-only, and the fixture is healthy.
   On any failure, disable the plugin, set `diagnostics.otel.enabled` to
   `false`, stop the collector, and continue the release test without local
   diagnostics. Keep these setup failures out of the worksheet and GitHub.

Keep the collector running only while the fixture is under test. It captures
traces, metrics, and logs locally with bounded file rotation. The source
gateway, personal OpenClaw home, and shared GitHub issue remain untouched.

## 5. Create and reveal the worksheet (ready runs only)

Only when readiness is verified, copy
[the worksheet asset](assets/validation-worksheet.md) to
`.artifacts/openclaw-release-validation/<stable-train>-<timestamp>.md`. Fill its
run identity, test mode, source, issue URL, terminal upgrade result, eligible
upgrade findings, and the current tester's authored PRs between the previous
stable and current beta. Insert the campaign body's exact marked guidance bytes
at `{{VALIDATION_GUIDANCE}}`. In those bytes, replace `{{OPENCLAW}}` with
`ocm @<test-env> --` for either OCM lane or `openclaw` for the plain in-place
lane. Replace `{{RESTART_GATEWAY}}` with `ocm service restart <test-env>` for
either OCM lane or `openclaw gateway restart` for the plain in-place lane. Use
the actual environment name. No placeholder may remain.

Do not regenerate or reformat the two priority sections. They are the current
campaign dashboard. The local worksheet may change only in its run fields,
upgrade findings, authored PRs, testing notes, additional tested surfaces, and
final feedback. Never write local substitutions or notes back to the issue body.

Resolve the worksheet's absolute path and open it yourself with the appropriate
platform command: `open '<absolute-path>'` on macOS, `xdg-open
'<absolute-path>'` on Linux, or `start "" "<absolute-path>"` on Windows. If
opening fails, report the error and continue. After opening it, print only:

```text
Testing worksheet: /absolute/path/to/worksheet.md
```

Then give this compact orientation, using the actual worksheet contents:

- **What it is:** their private run record and the source for the final
  release-feedback comment; it is not another task to complete.
- **Priority and scorecard:** the first three surfaces cover the release train
  overall; the second three cover changes landed on main since the current beta
  was cut. Their
  maturity values come from the live scorecard, where higher maturity carries a
  stronger regression expectation. Any scorecard surface may still be tested.
- **How to use each surface:** **What changed** summarizes the release theme,
  and **Recommended testing** gives a concrete manual exercise and pass
  condition.
- **How to leave feedback:** as they test, they should simply tell the agent
  their notes and name the surface (for example, `Models: switching persisted
after restart`). The agent adds those notes to that surface's **Testing
  notes** cell. They do not need to edit the file themselves.

Finish with the exit instruction: **You can stop after any amount of testing;
you do not need to cover every surface. When you are ready to wrap up, reply
exactly `finish validation`.** That tells the agent to collect any missing
promotion feedback, safely end the selected test mode, and prepare a reviewable
consolidated release-feedback draft. Then ask which surface they want to test
first.

This worksheet is the only checklist and note store. Readiness is verified at
this point, so continue to human-driven testing.

## 6. Human-driven testing

Ask: **What do you want to test first?** Recommend starting with a release
priority, but let the tester choose one surface at a time in any order. After
each item, add their notes to that surface's **Testing notes** table cell, then
ask what they want to test next.

The tester drives interactive surfaces such as the TUI, Control UI, onboarding,
channels, pairing, and approvals. Provide the command or URL and explain what
to look for, then wait for their result. Take control only when explicitly
asked. Do not turn the checklist into an automated scenario runner.

A surface counts as tested only when tester-authored text appears in its
**Testing notes** row. The other rows are guidance, never evidence. An empty
cell means untouched. Escape table pipes and use `<br>` between notes. When a
surface appears in both priority sections, mirror its notes into both tables but
deduplicate it in the final report.

If the tester chooses a non-priority surface, resolve it from the live
scorecard, guide one concrete manual check, and add a matching table under
**Additional surfaces tested**. Do not add the full scorecard catalog.

### Investigate each problem immediately

When the tester reports a release problem, first record it under the named
surface, then immediately search open and closed `openclaw/openclaw` issues with
bounded, specific queries. Inspect plausible matches and the linked fix or PR;
do not classify from search snippets alone.

Choose exactly one disposition and create one private Markdown draft beside the
worksheet:

- **Comment on existing issue:** a related issue is open. Draft a concise
  corroborating comment with the tested beta, tested main SHA, reproduction,
  expected/observed behavior, and sanitized evidence.
- **Create issue:** no open match exists and no confirmed fix applies. Draft a
  complete issue with the same identity and evidence plus the exact
  `release-validation-finding` label.
- **Found but fixed:** a concrete fix is confirmed in the tested main SHA or a
  newer published beta. Draft a short local record naming the fix URL. Do not
  post it separately; the final campaign report says the problem was found but
  already fixed.

A closed duplicate, stale issue, unsupported report, or unclear change is not a
confirmed fix. Keep searching or use **Create issue**. Telemetry may corroborate
tester-reported behavior but may not invent a finding. Sanitize every draft:
never include local paths, gateway/environment names, credentials, user
identifiers, raw logs, prompts, responses, tool payloads, or cleanup/setup
details. Tell the tester the draft is queued for review; do not post it yet.

## 7. Draft, review, and publish

When the tester says `finish validation`:

1. If readiness is verified, read the worksheet and ask only for a missing
   promotion vote or final feedback. If readiness is blocked, do not create or
   read a worksheet: use the recorded campaign, source, test-target, terminal
   upgrade result, and eligible upgrade findings, then ask only for missing
   promotion feedback.
2. Collect a small **Test environment** profile for the visible report draft.
   This is diagnostic context, not a finding and never enters the hidden
   structured payload. Include only the OS name and version, CPU architecture,
   logical CPU count, memory rounded to the nearest whole GiB, and OCM version
   when an OCM lane was used.
   Read those individual values with narrow native commands; omit an unavailable
   value rather than collecting a broader system profile. Never read or report
   the hostname, username, device model, serial number, UUID, network addresses,
   disk layout, installed software, environment, or a raw command output.
3. If local diagnostics are active, stop the isolated gateway first so its OTLP
   exporters flush, wait briefly for the collector's one-second batch flush,
   then stop the run-owned collector. Read only its three private telemetry
   files. Select at most three short snippets that directly corroborate a
   worksheet note, final feedback, or an eligible upgrade finding. Telemetry
   can strengthen an existing finding but cannot create a new one.
4. Treat telemetry as unsafe source material. Never copy raw JSON, log bodies,
   attributes, resource values, timestamps, trace/span IDs, hostnames, file
   paths, session identifiers, request identifiers, prompts, responses, tool
   inputs, tool outputs, or credentials. A permitted snippet contains only an
   aggregate signal count, a known OpenClaw operation name, a span status, or a
   low-cardinality error category. If relevance or redaction is uncertain, omit
   the telemetry. Label included prose **Local telemetry evidence** and keep it
   immediately below the finding it corroborates. Do not put telemetry in the
   hidden structured payload.
5. For an isolated lane, restore any source gateway stopped for channel
   ownership and ask before destroying the disposable environment. If it is
   retained, retain the run-owned runtime too and disable `diagnostics-otel`,
   set `diagnostics.otel.enabled` to `false`, restart the fixture through OCM,
   and remove the plugin with `ocm @<test-env> -- plugins uninstall
diagnostics-otel --force`. If the fixture is destroyed, remove only its
   run-owned runtime with `ocm runtime remove <run-runtime-name>` after the
   fixture is gone. For an in-place lane, do not stop, downgrade, restore, or
   otherwise rewrite the real gateway automatically. Ask whether the tester
   wants to keep the dev/main installation. If not, explain that newer config
   or database migrations can make a code-only downgrade unsafe, show a
   rollback plan using the OCM upgrade transaction or the verified plain-gateway
   backup as applicable, and require separate explicit approval before any
   rollback or offline state restoration. Remove the run-owned isolated main
   checkout after no build command is using it. Never remove a shared or
   in-use runtime. Remove the run-owned collector in all cases.
6. When a tooling packet exists or cleanup fails, read and apply
   [the tooling-feedback packet procedure](references/tooling-feedback.md),
   including its closeout rules. If no tooling failure occurred, do not create
   a packet.
7. A completed candidate evaluation requires a candidate-owned readiness
   failure or at least one tester-authored surface result. Without either, say
   `Candidate not evaluated — no tester-authored result`, assign no candidate
   terminal result, and stop after cleanup without creating a candidate report,
   posting batch, hidden payload, or Discord summary. Otherwise assign exactly
   one terminal result using this precedence, and write its
   exact label to the worksheet when one exists, the tooling packet when one
   exists, the visible campaign-report draft when one is warranted, and the
   final Discord summary when one is warranted:

   - **Candidate failed** — the candidate had any functional or readiness
     failure.
   - **Candidate passed, but cleanup failed** — candidate readiness and tested
     behavior passed, but fixture destruction, source restoration, runtime or
     collector removal, plugin cleanup, or approved rollback did not complete.
     Record the failure details only in the tooling packet.
   - **Candidate passed with presentation warnings** — candidate behavior and
     cleanup passed, but the tester reported at least one non-blocking visual,
     wording, output-format, or other presentation/polish warning. Keep those
     warnings in candidate feedback.
   - **Fully clean completion** — candidate behavior passed, cleanup completed,
     and the tester reported no candidate warning or problem finding.

   Candidate failure takes precedence over cleanup failure; cleanup failure
   takes precedence over presentation warnings. Do not use a fifth terminal
   label or collapse these labels into pass/fail.

8. Complete or refresh every finding draft using the final sanitized evidence.
   For an eligible upgrade finding, run the same related-issue investigation
   now if it was not already done before manual testing.
9. Synthesize one final campaign-report draft from the stable train, current
   beta tag and commit, exact tested main SHA, source version/commit, eligible
   upgrade findings, tester feedback, promotion vote, and only surfaces with
   non-empty Testing notes. Link each planned finding draft by its local action
   label; its GitHub URL is inserted after publishing. List **Found but fixed**
   items with their verified fix URL. For a blocked run, list no tested surfaces
   and use the upgrade finding as the evidence. Begin with:

   ```md
   - Release train: <stable train>
   - Current beta: <beta tag> (<beta commit>)
   - Tested main commit: <full SHA>
   - Terminal result: <exact terminal result label>

   ## Test environment

   - OS: <name and version>
   - CPU: <architecture>, <logical core count> logical cores
   - Memory: <whole GiB> GiB
   - OCM: <version, only when used>
   ```

   Omit any unavailable value; do not add substitute device facts. The profile
   is brief diagnostic context, not an upgrade finding or surface result.

10. Remove local paths, gateway names, secrets, user identifiers, raw logs, OCM
    notes, setup details, and cleanup details from the comment. Keep the
    allow-listed **Test environment** values from the preceding step.
11. Read and apply the [structured report contract](references/structured-report.md).
    Write the proposed root report beside the finding drafts. Open the root
    report plus every **Create issue** and **Comment on existing issue** draft
    together and say:

    ```text
    I opened every proposed GitHub post for review. Nothing has been sent.
    Reply exactly `approve validation posts` to publish this batch, or tell me what to change.
    ```

    On edits, revise and reopen the same files. Never write to GitHub from
    `finish validation` alone.

12. On `approve validation posts`, re-read and privacy-check every approved
    file. Publish each **Create issue** draft with
    `release-validation-finding`, and each corroboration draft to its selected
    open issue. Read every write back. A **Found but fixed** record produces no
    separate post. Insert the resulting issue/comment URLs into the root report,
    append and validate its hidden v2 payload, then automatically create or
    update this GitHub user's one campaign report comment. This mechanical URL
    insertion needs no second approval; do not otherwise rewrite approved prose.
    Return the root comment URL and every finding URL.
13. Give the tester this concise copy-ready Discord summary, populated only from
    the same release-facing worksheet evidence and final comment:

    ```md
    **Release validation — <stable-train> / <current-beta>**
    Tested main: <full SHA>
    Result: <exact terminal result label>
    Tested: <surfaces with non-empty Testing notes, or "No manual surface testing completed">
    Key findings: <concise release findings, or "None reported">
    Recommendation: <yes / no>
    Details: <GitHub comment URL>
    ```

    Keep it to these seven lines. Exclude source gateway details, local paths,
    OCM/setup information, cleanup details, credentials, and untested surface
    guidance. The generic terminal result may name cleanup failure, but no
    tooling detail may appear.
    This is a copy/paste handoff for the tester; do not post it automatically.

The skill collects release feedback; it does not make the go/no-go decision.
