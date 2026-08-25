---
name: openclaw-release-validation
description: "Safely copy an existing gateway, test the latest OpenClaw main commit, and guide human release-campaign feedback with one Markdown worksheet."
user-invocable: true
disable-model-invocation: true
---

# OpenClaw Release Validation

Help a human validate the latest main commit against a copy of a real gateway. Automate only
fixture setup, finding triage, and reporting. Let the human drive OpenClaw and judge quality.

For a ready gateway, use one editable Markdown worksheet as the entire run
record. A blocked upgrade has no worksheet or surface-testing phase; its final
report draft is the only local record. Do not create `run.json`, mission state,
receipts, or other tracking files.

## Start the run

At the start of every **Validate release** run, give a concise introduction:
this skill creates an isolated copy of a gateway, upgrades that copy to an
immutable build of the latest `origin/main`, reports upgrade problems, then
helps the tester manually check it, triage findings, and submit one consolidated
report to the stable release train's shared issue. The source gateway is not modified.

Use the agent's available native checklist or plan tool to show progress and
check items off as they complete. Start with this visible checklist:

1. Confirm the release campaign and main test target
2. Choose a gateway to copy
3. Copy, upgrade, and verify readiness
4. Optionally capture local diagnostics
5. Create the testing worksheet
6. Test surfaces and record feedback
7. Draft, review, and publish feedback

For **Update campaign**, instead explain that the run refreshes the stable
release train's shared testing dashboard for the new beta, then ends; use a
corresponding three-item checklist: identify release train, update priorities,
verify the campaign issue. For a stable tag, the last item closes the campaign.

## Workflows

Choose the workflow from the request:

- **Update campaign** is the asynchronous release-process path. A beta creates
  or refreshes the canonical issue for its stable release train. A stable tag
  closes that train's issue. Print the issue URL and stop.
- **Validate release** is the default human-testing path. Join the existing
  campaign issue, copy a gateway, build the latest immutable `origin/main`
  target through OCM, then guide testing and finding triage. This workflow
  never creates or rewrites the canonical issue body.

Before the upgrade reaches a terminal ready or blocked result, keep tester-facing
output to the campaign issue, current-beta identity, gateway choice, and upgrade
progress or errors. The worksheet, priority surfaces, testing instructions, and
`finish validation` phrase are disclosed only after that gate.

## 1. Release train and shared issue

Normalize a beta tag `vYYYY.M.D-beta.N` to the stable train `vYYYY.M.D`. The
canonical issue, label, title, and hidden marker belong to that train; the body
also records the current beta. Testing still targets an immutable latest
`origin/main` SHA.

When the request supplies an issue URL or number, resolve it directly with
`gh issue view`. Accept it only when it is open, has the exact
`release-validation` label, and contains
`<!-- openclaw-release-validation:<stable-train> -->`. Read the current beta
from the body. In **Update campaign** only, a legacy beta-specific marker is
also acceptable when it normalizes to the selected train; replace it with the
stable-train marker during this update. Do not search releases or issues first.

When no issue is supplied, use an explicit beta or stable tag when supplied.
Otherwise run `gh api 'repos/openclaw/openclaw/releases?per_page=100'` once and
select the newest published `vYYYY.M.D-beta.N` locally. Do not paginate. If the
bounded response has no beta, ask for an explicit tag.

Find the campaign with one bounded lookup:

```sh
gh api 'repos/openclaw/openclaw/issues?state=open&labels=release-validation&per_page=2'
```

Ignore pull requests. Require at most one issue with the label and require its
marker to match the selected stable train. The label is the fast index; the
marker is the identity check. In **Validate release**, no match means stop with
`Release validation has not been initialized for <stable-train>.` Multiple
matches or a different marker are conflicts: show their URLs and stop. Never
fall back to an unbounded issue scan. **Update campaign** may migrate one legacy
beta marker that normalizes to the selected stable train.

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

In **Update campaign**, ensure these exact labels exist without changing an
existing label:

- `release-validation` — green `0E8A16`; only the one open campaign issue.
- `release-validation-finding` — red `D93F0B`; bugs found by campaign testers.

For a beta tag:

1. Resolve its stable train, release URL, commit, the previous stable release,
   and the previous beta in the same train. For beta.1, use the previous stable
   as both comparison bases.
2. Fetch `https://docs.openclaw.ai/maturity/scorecard.md`. Extract the live
   surface names, taxonomy links, M-levels, maturity labels, and score-band
   guidance. Stop if it cannot be parsed; never use a hardcoded catalog.
3. Read complete release notes and source history. Group all user-visible and
   upgrade-sensitive changes under live scorecard surfaces for two windows:
   previous stable through current beta, and previous beta through current
   beta. Use PR and commit details for analysis, but publish themes rather than
   a misleading sample of links.
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
   be one bounded, human-driven action with an observable pass condition; use
   `{{TEST_ENV}}` in OCM commands. Do not say only "use" or "verify."

6. Replace the issue title with `OpenClaw <YYYY.M.D> beta feedback`. Render the
   body in this order, with no beta-history section:

   ```md
   <!-- openclaw-release-validation:<stable-train> -->

   - Current beta: [<beta-tag>](release-url)
   - Beta commit: `<full-commit>`
   - Test target: latest immutable `origin/main`

   > [!NOTE]
   > <live scorecard and maturity-band explanation; any surface may be tested>

   <!-- validation-guidance:start -->

   ## Priority surfaces for this release

   <exactly three surface tables>

   ## Priority surfaces since <previous-beta-or-stable>

   <exactly three surface tables>
   <!-- validation-guidance:end -->

   ## Participate

   <concise instruction to run this skill>
   ```

7. Create the issue if absent or update the existing train issue in place. Keep
   all comments. Apply only `release-validation`, read back title/body/labels,
   and require the marker plus guidance bytes to match. Close any older open
   train campaign after commenting with the new issue URL. Do not add history
   for superseded betas to the current body.

For a stable tag, find the matching train issue, comment with the stable release
URL, remove the `release-validation` label, close the issue as completed, and
stop. Never close it for another beta in the same train.

Campaign updating is deliberately last-writer-simple; release orchestration
does not launch overlapping update tasks. **Update campaign** ends after the
readback and never waits for human testing.

## 2. Choose and copy a real gateway

First run `ocm --version`. If OCM is unavailable, pause before discovering or
copying any gateway and say:

```text
OCM is required to create an isolated, disposable copy of your gateway for
this release test and is not installed.

Would you like me to install OCM now? This installs the OpenClaw Manager CLI
on this machine. Reply exactly `install OCM` to approve, or install it yourself
and reply `OCM installed`.
```

Install OCM only after the tester explicitly replies `install OCM`. Use the
official release installer, then verify `ocm --version` before continuing:

```sh
curl -fsSL https://github.com/openclaw/ocm/releases/latest/download/install.sh | bash
ocm --version
```

If the binary was installed to `~/.local/bin` but that directory is not on the
current PATH, use `~/.local/bin/ocm` for this run and tell the tester to add it
to their PATH for future shells. If installation or verification fails, report
the exact error and remain paused. Do not replace OCM with a manual state copy.

Discover once with `ocm env list --json`. In parallel, inspect the plain home
with `ocm adopt inspect ~/.openclaw --json` and obtain its version and service
state with `openclaw --version` and `openclaw gateway status --json --no-probe`.
Read only the version and running/stopped state from the latter; do not expose
its command, paths, configuration, or environment. If the plain home's resolved
path is an OCM environment's `stateDir`, show it once as that environment's
personal-state alias. Otherwise show `Personal ~/.openclaw` with its known
version and running state. Keep the overview shallow: do not inspect plugins
or other gateway internals. Ask which gateway the tester wants to copy. Never
silently select or modify the personal gateway.

After selection, inspect only that gateway and record its version and commit.
Preview the disposable target, then import its `.openclaw` state with OCM so
sessions and other real user state are preserved in the fixture:

```sh
ocm adopt plan --name <test-env> <selected-state-dir> --json
ocm adopt import --name <test-env> <selected-state-dir> --json
```

Use the `stateDir` returned by `ocm env list --json` for an OCM environment and
`~/.openclaw` for the plain gateway. Let OCM create the stopped, disposable
environment and assign a non-conflicting port; do not make an additional staged
copy. OCM copies a configured repo-backed or symlinked workspace into the
disposable environment and rewrites the fixture config to that copy; it never
changes the source repository or workspace. The returned environment name is
the test environment; use that actual name in every tester-facing command
rather than the `<test-env>` placeholder. If OCM cannot isolate a config include
or source path, pause and report that setup blocker conversationally—never make
a manual state copy or put it in the campaign worksheet. Keep the source
unchanged. Before activating copied channel credentials, stop the current
credential owner and restore it when validation ends. For an OCM source, use
`ocm service stop <source-env>`; for the plain source, use `openclaw gateway
stop`. There is no `ocm stop` command.

## 3. Build the latest main target, upgrade, and report errors

For every **Validate release** run, resolve a fresh immutable main target after
the campaign issue is known and before building the runtime. Never build from
the caller's active checkout. Resolve exactly one SHA, create a run-owned
isolated checkout at that SHA, and prove the checkout did not move:

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

If resolution, fetch, checkout, or SHA verification fails, report the setup
blocker conversationally and pause. Do not fall back to a moving branch, a
caller checkout, or the current beta package.

Give the run-owned runtime a unique name containing the short main SHA and a
UTC timestamp, then build and verify that exact checkout through OCM. Use the
same named runtime for the disposable fixture:

```sh
ocm runtime build-local <run-runtime-name> --repo <main-checkout> --force
ocm runtime verify <run-runtime-name>
ocm upgrade <test-env> --runtime <run-runtime-name> --dry-run --json
ocm upgrade <test-env> --runtime <run-runtime-name> --json
ocm service start <test-env>
```

Stop any current owner of copied channel credentials immediately before the
`ocm service start` command. Record `origin/main` and the full `main_sha` in
the private worksheet as the tested target and commit. Keep the stable train,
current beta tag, and beta commit as separate worksheet fields.

Verify `ocm service status <test-env>`, `ocm @<test-env> -- --version`, and
`ocm logs <test-env> --tail 100`. OCM's successful managed upgrade already
requires HTTP health and gateway reachability.

Report every error to the tester immediately, including errors recovered by a
retry. Retain test-target OpenClaw behavior caused by the upgrade as an
eligible **Upgrade finding** for the final report; add it to the worksheet only
when readiness is verified. Keep OCM, copying, local tooling, setup, and cleanup
problems in the conversation only; they never enter the worksheet or GitHub
comment.

As soon as an eligible upgrade finding is concrete, run the related-issue
investigation from section 6 and queue its private draft. Do this before manual
surface testing; do not wait until wrap-up.

Complete this step only when test-target readiness is either verified or blocked
with a concrete terminal finding. Do not continue to testing while the upgrade
or gateway readiness is unresolved.

If readiness is **blocked**, this is a terminal upgrade-validation result: mark
the optional diagnostics, worksheet, and surface-testing checklist items as
skipped. Do not create, open, mention, or ask the tester to use a worksheet;
there is no running gateway to test. State plainly:

```text
Upgrade blocked — the copied gateway never started, so manual surface testing cannot begin.
Reply exactly `finish validation` to prepare a reviewable report of this upgrade finding, or tell me any final feedback to include.
```

Then wait for final feedback or `finish validation`.

## 4. Optional local diagnostics capture

Offer this step only after the test target is ready. It is opt-in and only
applies to the disposable test environment. Say:

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
run identity, source, issue URL, terminal upgrade result, eligible upgrade
findings, and the current tester's authored PRs between the previous stable and
current beta. Insert the campaign body's exact marked guidance bytes at
`{{VALIDATION_GUIDANCE}}`. Replace `{{TEST_ENV}}` in those bytes with the actual
disposable environment name. No placeholder may remain.

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
  overall; the second three cover changes since the previous beta. Their
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
promotion feedback, stop the disposable fixture, restore any source gateway it
stopped, and prepare a reviewable consolidated release-feedback draft. Then ask
which surface they want to test first.

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
   logical CPU count, memory rounded to the nearest whole GiB, and OCM version.
   Read those individual values with narrow native commands; omit an unavailable
   value rather than collecting a broader system profile. Never read or report
   the hostname, username, device model, serial number, UUID, network addresses,
   disk layout, installed software, environment, or a raw command output.
3. If local diagnostics are active, stop the copied gateway first so its OTLP
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
5. Restore any source gateway stopped for channel ownership. Ask before
   destroying the disposable environment. If it is retained, retain the
   run-owned runtime too and disable `diagnostics-otel`, set
   `diagnostics.otel.enabled` to `false`, restart the fixture through OCM, and
   remove the plugin with
   `ocm @<test-env> -- plugins uninstall diagnostics-otel --force`. If the
   fixture is destroyed, remove only its run-owned runtime with
   `ocm runtime remove <run-runtime-name>` after the fixture is gone. Remove the
   run-owned isolated main checkout after no build or fixture command is using
   it. Never remove a shared runtime. Remove the run-owned collector in all cases.
6. Complete or refresh every finding draft using the final sanitized evidence.
   For an eligible upgrade finding, run the same related-issue investigation
   now if it was not already done before manual testing.
7. Synthesize one final campaign-report draft from the stable train, current
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

   ## Test environment

   - OS: <name and version>
   - CPU: <architecture>, <logical core count> logical cores
   - Memory: <whole GiB> GiB
   - OCM: <version>
   ```

   Omit any unavailable value; do not add substitute device facts. The profile
   is brief diagnostic context, not an upgrade finding or surface result.

8. Remove local paths, gateway names, secrets, user identifiers, raw logs, OCM
   notes, setup details, and cleanup details from the comment. Keep the
   allow-listed **Test environment** values from the preceding step.
9. Read and apply the [structured report contract](references/structured-report.md).
   Write the proposed root report beside the finding drafts. Open the root
   report plus every **Create issue** and **Comment on existing issue** draft
   together and say:

   ```text
   I opened every proposed GitHub post for review. Nothing has been sent.
   Reply exactly `approve validation posts` to publish this batch, or tell me what to change.
   ```

   On edits, revise and reopen the same files. Never write to GitHub from
   `finish validation` alone.

10. On `approve validation posts`, re-read and privacy-check every approved
    file. Publish each **Create issue** draft with
    `release-validation-finding`, and each corroboration draft to its selected
    open issue. Read every write back. A **Found but fixed** record produces no
    separate post. Insert the resulting issue/comment URLs into the root report,
    append and validate its hidden v2 payload, then automatically create or
    update this GitHub user's one campaign report comment. This mechanical URL
    insertion needs no second approval; do not otherwise rewrite approved prose.
    Return the root comment URL and every finding URL.
11. Give the tester this concise copy-ready Discord summary, populated only from
    the same release-facing worksheet evidence and final comment:

    ```md
    **Release validation — <stable-train> / <current-beta>**
    Tested main: <full SHA>
    Tested: <surfaces with non-empty Testing notes, or "No manual surface testing completed">
    Key findings: <concise release findings, or "None reported">
    Recommendation: <yes / no>
    Details: <GitHub comment URL>
    ```

    Keep it to these six lines. Exclude source gateway details, local paths,
    OCM/setup information, cleanup, credentials, and untested surface guidance.
    This is a copy/paste handoff for the tester; do not post it automatically.

The skill collects release feedback; it does not make the go/no-go decision.
