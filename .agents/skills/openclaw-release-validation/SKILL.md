---
name: openclaw-release-validation
description: Safely copy an existing gateway, upgrade it to an OpenClaw beta, and guide human release testing with one Markdown worksheet.
user-invocable: true
disable-model-invocation: true
---

# OpenClaw Release Validation

Help a human validate one beta against a copy of a real gateway. Automate only
fixture setup and reporting. Let the human drive OpenClaw and judge quality.

Use one editable Markdown worksheet as the entire run record. Do not create
`run.json`, mission state, receipts, or other tracking files.

Tell the tester: **Edit the worksheet directly or tell me what to record. Reply
exactly `finish validation` when you are done.**

## 1. Candidate and shared issue

Use an explicit beta when supplied; otherwise resolve the newest published tag
matching `vYYYY.M.D-beta.N`. Record its version and commit.

Use `gh` to find the open issue identified by
`<!-- openclaw-release-validation:<tag> -->`. Ignore closed campaign issues and
fail clearly if more than one open issue has the marker.

When the issue exists, read its body and use the worksheet between
`<!-- validation-worksheet:start -->` and
`<!-- validation-worksheet:end -->`. Keep its release priorities and template
unchanged.

When the issue does not exist, become the campaign creator:

1. Read the GitHub release notes for the exact tag. If they are empty or
   incomplete, also read that tag's section of `CHANGELOG.md`.
2. Read the complete release notes and group every user-visible or
   upgrade-sensitive item under the subsystem headings in
   `assets/validation-worksheet.md`; one item may support multiple subsystems.
   Select the three to five subsystems with the broadest changed surface or
   highest regression risk.
3. Build a compact `Subsystem | What changed | Try` table. In **What changed**,
   synthesize the dominant themes across the subsystem's complete group instead
   of listing a few fixes. Use one concise theme statement per cell. Issue or PR
   links are optional supporting examples: label them `Examples`, limit them to
   one or two representative links, and never use them as the organizing
   content. Hyperlink every reference, using only items cited by the release
   notes or verified live. When a row has no example link, link its subsystem
   name to the release notes. Put `[Release notes](<release-url>)` immediately
   above the table.
4. Make a working copy of the worksheet asset and fill it with the exact
   candidate identity, release-notes URL, and priority table. Ensure no
   template placeholder remains.
5. Create the issue with the stable marker, a short participation note, and the
   completed worksheet verbatim between the worksheet markers. Re-query open
   issues for the marker after creation and fail on duplicates.

Only the campaign creator performs release-note analysis or generates the
canonical template. Later runs consume the issue body without rewriting it.

## 2. Choose and copy a real gateway

Discover once with `ocm env list --json`, then add plain `~/.openclaw` when it
is not already represented. Keep this overview shallow: show each gateway's
name, known version, and running state without inspecting every gateway's
plugins or paths. Ask which one the tester wants to copy. Never silently select
or modify the personal gateway.

After selection, inspect only that gateway and record its version and commit.
Import its `.openclaw` state with OCM so sessions and other real user state are
preserved in the fixture:

```sh
ocm adopt import --name <test-env> <selected-state-dir> --json
```

Use the `stateDir` returned by `ocm env list --json` for an OCM environment and
`~/.openclaw` for the plain gateway. Let OCM create the stopped, disposable
environment and assign a non-conflicting port; do not make an additional staged
copy. Keep the source unchanged. Before activating copied channel credentials,
stop the current credential owner and restore it when validation ends.

## 3. Create the worksheet

Copy the canonical worksheet between the shared issue's markers to
`.artifacts/openclaw-release-validation/<tag>-<timestamp>.md`. Fill in the
source, shared issue URL, and local upgrade result without changing the campaign
priorities. Give the tester a clickable link and briefly point out the three to
five priority subsystems.

This worksheet is the only checklist and note store. The tester may edit it in
their editor or tell the agent what to record.

## 4. Upgrade and report errors

Install the exact candidate runtime and use the runtime name returned by OCM:

```sh
ocm runtime install --version <tag-without-v> --json
ocm runtime verify <runtime-name> --json
ocm upgrade <test-env> --runtime <runtime-name> --dry-run --json
ocm upgrade <test-env> --runtime <runtime-name> --json
ocm start <test-env> --runtime <runtime-name> --json
```

Stop any current owner of copied channel credentials immediately before the
`ocm start` command.

Verify `ocm service status <test-env>`, `ocm @<test-env> -- --version`, and
`ocm logs <test-env> --tail 100`. OCM's successful managed upgrade already
requires HTTP health and gateway reachability.

Report every error to the tester immediately, including errors recovered by a
retry. Classify it in the worksheet:

- **Release finding:** candidate OpenClaw behavior caused by the upgrade. This
  is eligible for the GitHub comment.
- **Private operator note:** OCM, copying, local tooling, setup, or cleanup.
  This never enters the GitHub comment.

Update the worksheet's upgrade result. Do not continue to testing while the
upgrade or gateway readiness is unresolved.

## 5. Human-driven testing

Ask: **What do you want to test first?** Recommend starting with a release
priority, but let the tester choose one subsystem at a time in any order. After
each item, add their notes beneath that subsystem's `####` heading, then ask what
they want to test next.

The tester drives interactive surfaces such as the TUI, Control UI, onboarding,
channels, pairing, and approvals. Provide the command or URL and explain what
to look for, then wait for their result. Take control only when explicitly
asked. Do not turn the checklist into an automated scenario runner.

A subsystem counts as tested only when tester-authored text appears beneath its
heading. Ignore HTML guidance comments when deciding whether a section was
tested; an empty or comment-only section means untouched. Add concise detail
under **Release findings** when something feels broken, slow, confusing, or
regressed.

## 6. Finish and publish

When the tester says `finish validation`:

1. Read the worksheet and ask only for a missing promotion vote or final
   feedback.
2. Stop the copied gateway and restore any source gateway stopped for channel
   ownership. Ask before destroying the disposable environment.
3. Build one GitHub issue comment containing only candidate identity, source
   version/commit, subsystem names with non-empty note sections, release
   findings, tester feedback, and the yes/no promotion vote.
4. Remove local paths, gateway names, secrets, user identifiers, raw logs, OCM
   notes, setup details, and cleanup details from the comment.
5. Post the comment once with `gh` and show the tester its URL.

The skill collects release feedback; it does not make the go/no-go decision.
