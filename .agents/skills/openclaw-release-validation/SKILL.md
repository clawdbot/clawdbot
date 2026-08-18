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
2. Fetch the live scorecard Markdown from
   `https://docs.openclaw.ai/maturity/scorecard.md`. From its **All surfaces**
   table, extract each unique surface's display name, taxonomy link, M-level,
   and maturity label. Also extract the score bands. Treat this live response as
   the complete catalog; do not use a cached or hardcoded surface list. Resolve
   relative taxonomy links against `https://docs.openclaw.ai` before publishing.
   Stop before issue creation when the scorecard is unavailable or cannot be
   parsed.
3. Read the complete release notes and group every user-visible or
   upgrade-sensitive item under one or more live scorecard surfaces. Use linked
   PR or commit metadata privately when it helps estimate change size, but never
   publish cherry-picked examples.
4. Rank exactly five priority surfaces using all of: change count and breadth,
   change size and complexity, upgrade sensitivity, scope of user impact, and
   maturity expectations. A touched Stable or Clawesome surface carries more
   regression risk than an equally changed early-stage surface because users
   rely on its stronger quality promise. Keep the ranking qualitative; do not
   expose a fake-precision score.
5. Generate one section for every live scorecard surface. Put the five selected
   surfaces under **Priority surfaces to test** and all remaining surfaces under
   **Other surfaces to test**. Format every section exactly like this:

   ```md
   ### [surface](taxonomy-url)

   | **Maturity score**      | <maturity-label>      |
   | ----------------------- | --------------------- |
   | **What changed**        | <release-theme>       |
   | **Recommended testing** | <exercise-or-em-dash> |
   | **Testing notes**       |                       |
   ```

   Keep the **Testing notes** value cell truly empty: add no placeholder text or
   hidden comment.
   Use `No notable changes in this release.` and an em dash in the last two
   table rows when no release item is relevant. Escape table pipes and keep each
   cell concise. Every priority surface must have a real recommended exercise.

   Make every **Recommended testing** cell a bounded operator workflow: name the
   exact action, the observable pass condition, and a runnable OCM-scoped command
   or concrete URL when the surface has one. Use `<br>` inside a cell when a
   command and pass condition need separation. For example, onboarding should
   name `ocm @<test-env> -- onboard`, the TUI should name
   `ocm @<test-env> -- tui`, and channel health should name
   `ocm @<test-env> -- channels status --probe`. Avoid broad prompts that bundle
   unrelated features or say only to "use," "exercise," or "verify" a surface.

   For each **What changed**, synthesize the dominant themes across the
   surface's complete group instead of listing a few fixes. Do not include
   issue, PR, commit, or workflow examples; a handful of links misrepresents the
   full release surface. Each **Recommended testing** is one concise human-driven
   exercise.

6. Resolve the campaign creator's GitHub login with `gh api user`; ask for a
   login only when authentication cannot identify it. Enumerate every PR authored
   by that login whose merge commit is included between the previous release tag
   and the candidate tag. Add the complete linked list under **Your changes in
   this release**, or `- None in this release.` when empty. This explicit author
   list is separate from surface summaries and may contain PR links.
7. Make a working copy of the worksheet asset and fill it with the exact
   candidate identity, release-notes URL, live scorecard and taxonomy URLs,
   score-band guidance, and generated surface sections. The issue callout must
   say that its catalog and labels come from the live maturity taxonomy and that
   priority reflects release change volume, size, impact, upgrade risk, and
   maturity expectations. Remove the campaign-creator comment and ensure no
   template placeholder remains.
8. Create the issue with the stable marker, a short participation note, and the
   completed worksheet verbatim between the worksheet markers. Re-query open
   issues for the marker after creation and fail on duplicates.

Only the campaign creator performs release-note analysis or generates the
canonical template. Later runs consume the issue body without rewriting it, but
replace **Your changes in this release** in their private worksheet with the
current tester's complete authored-PR list for the same tag range.

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
priorities. Refresh **Your changes in this release** for the current tester, give
them a clickable link, and briefly point out the five priority surfaces.

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
retry. Record candidate OpenClaw behavior caused by the upgrade under **Upgrade
findings**; it is eligible for the GitHub comment. Keep OCM, copying, local
tooling, setup, and cleanup problems in the conversation only; they never enter
the worksheet or GitHub comment.

Update the worksheet's upgrade result. Do not continue to testing while the
upgrade or gateway readiness is unresolved.

## 5. Human-driven testing

Ask: **What do you want to test first?** Recommend starting with a release
priority, but let the tester choose one surface at a time in any order. After
each item, add their notes to that surface's **Testing notes** table cell, then
ask what they want to test next.

The tester drives interactive surfaces such as the TUI, Control UI, onboarding,
channels, pairing, and approvals. Provide the command or URL and explain what
to look for, then wait for their result. Take control only when explicitly
asked. Do not turn the checklist into an automated scenario runner.

A surface counts as tested only when tester-authored text appears in its
**Testing notes** row. The **Maturity score**, **What changed**, and
**Recommended testing** rows are campaign guidance, never test evidence. An
empty Testing notes value means untouched. Escape table pipes and use `<br>`
between multiple notes. Add candidate problems found during surface testing to
that cell.

## 6. Finish and publish

When the tester says `finish validation`:

1. Read the worksheet and ask only for a missing promotion vote or final
   feedback.
2. Stop the copied gateway and restore any source gateway stopped for channel
   ownership. Ask before destroying the disposable environment.
3. Synthesize one final release-analysis comment from candidate identity, source
   version/commit, upgrade findings, tester feedback, the yes/no promotion vote,
   and only the surfaces with non-empty Testing notes cells. Use those cells as
   the source of observed results; do not report the other table rows as evidence.
4. Remove local paths, gateway names, secrets, user identifiers, raw logs, OCM
   notes, setup details, and cleanup details from the comment.
5. Post the comment once with `gh` and show the tester its URL.

The skill collects release feedback; it does not make the go/no-go decision.
