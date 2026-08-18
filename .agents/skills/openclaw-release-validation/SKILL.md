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

Use `gh` to get or create one shared issue for that exact release. Identify it
with `<!-- openclaw-release-validation:<tag> -->`; fail clearly if duplicates
exist. Anyone may create the issue when it does not exist.

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

Copy `assets/validation-worksheet.md` to
`.artifacts/openclaw-release-validation/<tag>-<timestamp>.md`. Fill in the
candidate, source, and shared issue. Give the tester a clickable link to it.

This worksheet is the only checklist and note store. The tester may edit it in
their editor or tell the agent what to check off and record.

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

Ask: **What do you want to test first?** The tester chooses one checklist item
at a time, in any order. After each item, ask what to record and what they want
to test next.

The tester drives interactive surfaces such as the TUI, Control UI, onboarding,
channels, pairing, and approvals. Provide the command or URL and explain what
to look for, then wait for their result. Take control only when explicitly
asked. Do not turn the checklist into an automated scenario runner.

Successful checks need only a checked box. Add concise detail under **Release
findings** when something feels broken, slow, confusing, or regressed.

## 6. Finish and publish

When the tester says `finish validation`:

1. Read the worksheet and ask only for a missing promotion vote or final
   feedback.
2. Stop the copied gateway and restore any source gateway stopped for channel
   ownership. Ask before destroying the disposable environment.
3. Build one GitHub issue comment containing only candidate identity, source
   version/commit, checked subsystem names, release findings, tester feedback,
   and the yes/no promotion vote.
4. Remove local paths, gateway names, secrets, user identifiers, raw logs, OCM
   notes, setup details, and cleanup details from the comment.
5. Post the comment once with `gh` and show the tester its URL.

The skill collects release feedback; it does not make the go/no-go decision.
