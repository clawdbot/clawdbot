---
name: tag-duplicate-prs-issues
description: Use gitcrawl to search duplicate OpenClaw PRs/issues, group related work in prtags, and sync duplicate state to GitHub.
---

# Tag Duplicate PRs and Issues

Use this skill when a maintainer needs to decide whether a pull request or issue is a duplicate of existing work.

This skill is for maintainer triage and grouping.
It is not for reviewing the implementation quality of a PR.

## Required Setup

Do not write duplicate groups or annotations until this setup is complete.
Read-only discovery can still proceed with `gitcrawl` and live `gh`.

### Companion Skills

Use `$gitcrawl` first for local candidate discovery.
Use the `prtags` skill from the `prtags` repo at `skills/prtags/SKILL.md` when it is available.

### Install the CLIs

Install `prtags` from its latest GitHub release.
Do not rely on an old local build unless the maintainer explicitly wants to test unreleased behavior.

`prtags` CLI install path:

```bash
curl -fsSL https://raw.githubusercontent.com/dutifuldev/prtags/main/scripts/install-prtags.sh | bash -s -- --bin-dir "$HOME/.local/bin"
```

### Authenticate prtags

`prtags` should be logged in with the maintainer's own GitHub account through OAuth device flow.
Do not use a shared maintainer token for interactive triage.

```bash
prtags auth login
prtags auth status
```

The expected outcome is that `prtags` stores the logged-in maintainer identity locally and uses that account for authenticated writes.

## Missing-Setup Rule

Do not require an up-front preflight before starting the workflow.
Proceed with the normal steps until you actually need a tool or account state.

As soon as you discover that `prtags` is missing or not logged in at the write step, stop immediately.
Do not continue in a partial write mode after that point.

If `prtags` is missing, ask the user to run:

```bash
curl -fsSL https://raw.githubusercontent.com/dutifuldev/prtags/main/scripts/install-prtags.sh | bash -s -- --bin-dir "$HOME/.local/bin"
```

If `prtags auth status` shows that the user is not logged in, ask the user to run:

```bash
prtags auth login
```

Resume only after the missing tool or login state has been fixed.

## Read-Path Default

For candidate discovery in this workflow, use `gitcrawl` first.
Treat it as the local history and clustering layer for related issues, duplicate attempts, and closed threads.

Use live `gh` or `gh api` for the target thread and for any candidate before making an actionable judgment.
Use live GitHub when `gitcrawl` is missing or stale for a concrete reason, such as:

- the target or candidate is not present yet
- the local data is clearly stale or incomplete for the decision you need to make
- `gitcrawl` errors, times out, or lacks the needed neighbor/search data

When you fall back to live GitHub search, note that you did so and why.

If a later `prtags` target-level write fails because its own mirror has not caught up, stop and report that the curation backend is missing the target object instead of forcing a fallback write.

## Goal

For each target PR or issue:

1. gather duplicate evidence
2. decide whether it is a real duplicate
3. create or reuse one `prtags` group for that duplicate cluster
4. save the maintainer judgment in `prtags`
5. rely on normal `prtags` group writes to drive GitHub comment sync when that integration is configured

## Tool Roles

Use the tools with these boundaries:

- `gitcrawl` is candidate generation and historical context
  - use it first for local title/body search, neighbors, clusters, and closed-thread discovery
  - treat every candidate as a lead until live GitHub confirms it
- `gh` is live GitHub truth
  - use it for target state, body, comments, reviews, files, linked issues, and current open/closed/merged status
  - use `gh search` only when `gitcrawl` is stale, missing data, or cannot express the needed query
- `prtags` is the maintainer curation layer
  - use it to create or reuse one duplicate group
  - use it to save the duplicate status, confidence, rationale, and group summary
  - use it as the source of truth for the GitHub-facing group comment

## Working Rules

- Do not call something a duplicate only because the titles are similar.
- Do not call something a duplicate only because the same files changed.
- A duplicate cluster should be based on the same user-facing problem, the same intent, and substantially overlapping implementation or investigation context.

## One-Group Rule

Treat duplicate groups as exclusive.
A PR or issue should belong to at most one duplicate group at a time.

That means:

- before creating a new group, search for an existing group that already represents the same duplicate story
- if the target already appears to belong to a different duplicate group, stop and resolve that conflict first
- do not create a second group for the same target just because the wording is slightly different
- if two plausible existing groups overlap and you cannot safely merge the judgment, stop and ask the maintainer

This rule matters more than speed.
The skill should keep one coherent duplicate cluster per problem, not many near-duplicate clusters.

## What A Good Duplicate Group Represents

A duplicate group should describe the underlying problem and the intended fix direction.
Do not group items only because they share a keyword.

Good group shape:

- same user-facing bug or same maintainer-facing task
- same subsystem or code surface
- same intended change direction
- same likely duplicate-resolution path

Bad group shape:

- “all PRs that touch Slack”
- “all issues mentioning retry”
- “all auth-related items”

The group title should name the real problem.
The group description should summarize the intent and the code surface.

Examples:

- `gateway: startup regression from channel status bootstrap`
- `whatsapp: QR preflight timeout handling`
- `release: cross-OS validation handoff gaps`

## Evidence Checklist

Before declaring a duplicate, gather evidence from at least two categories.
`gitcrawl` neighbors, search hits, and cluster membership count as candidate generation, not as enough proof by themselves.

For PRs:

- same or nearly same problem statement
- same changed files or overlapping file ranges
- same fix direction
- same subsystem and failure mode
- same linked issue or same user-visible symptom

For issues:

- same user-visible problem
- same reproduction story or same failure mode
- same likely fix area
- same PRs already linked or discussed
- same maintainers already steering toward the same duplicate grouping

If you only have wording similarity, that is not enough.

## Step 1: Read The Target

Start by reading the target itself.
Use live GitHub for current target state.

For a PR:

```bash
gh pr view <number> --json number,title,state,mergedAt,body,closingIssuesReferences,files,comments,reviews,statusCheckRollup
```

For an issue:

```bash
gh issue view <number> --json number,title,state,body,comments,closedAt
```

Record:

- target type and number
- title
- problem statement
- proposed intent
- subsystem
- whether it is open, closed, or merged
- whether there is already a likely duplicate thread mentioned by humans

## Step 2: Search Broadly With Gitcrawl

Use `gitcrawl` first because it is the local OpenClaw history and clustering source.
Do not switch to broad live GitHub search unless `gitcrawl` is missing data, stale, or failing.

Start with the target and nearby threads:

```bash
gitcrawl threads openclaw/openclaw --numbers <issue-or-pr-number> --include-closed --json
gitcrawl neighbors openclaw/openclaw --number <issue-or-pr-number> --limit 20 --json
```

Then search key phrases and subsystem terms:

```bash
gitcrawl search openclaw/openclaw --query "<key phrase from title or body>" --mode hybrid --limit 20 --json
gitcrawl search openclaw/openclaw --query "<subsystem or error phrase>" --mode hybrid --limit 20 --json
```

Inspect likely clusters:

```bash
gitcrawl cluster-detail openclaw/openclaw --id <cluster-id> --member-limit 20 --body-chars 280 --json
```

For PRs, verify likely code overlap with live file data:

```bash
gh pr view <candidate-pr> --json number,title,state,mergedAt,files,body,comments,reviews
```

For issues, verify likely duplicate issue state and comments live:

```bash
gh issue view <candidate-issue> --json number,title,state,body,comments,closedAt
```

## Step 3: Use Live GitHub Search For Gaps

Use targeted live GitHub search after `gitcrawl` when:

- the target is too new for the local store
- comments or reviews matter and the local store lacks them
- the exact phrase did not appear in local results but the issue/PR is current enough that GitHub should know it

```bash
gh search prs --repo openclaw/openclaw --match title,body --limit 50 -- "<key phrase>"
gh search issues --repo openclaw/openclaw --match title,body --limit 50 -- "<key phrase>"
gh search issues --repo openclaw/openclaw --match comments --limit 50 -- "<error or maintainer phrase>"
```

## Step 4: Decide The Outcome

Choose one of these outcomes:

- `not_duplicate`
- `duplicate_needs_judgment`
- `duplicate_confirmed`

Use `duplicate_confirmed` only when the evidence is strong enough that the maintainer could safely close or retag the duplicate item.

Use `duplicate_needs_judgment` when:

- the problem looks the same but the implementation goal differs
- the code overlap is weak
- the issue wording is ambiguous
- there may be two valid duplicate group interpretations
- the target appears to intersect two existing duplicate groups

## Step 5: Reuse Or Create One prtags Group

Before creating a group, search `prtags` for an existing one.

Start with text search over groups:

```bash
prtags search text -R openclaw/openclaw "<problem phrase>" --types group --limit 10
prtags search similar -R openclaw/openclaw "<problem summary>" --types group --limit 10
prtags group list -R openclaw/openclaw
```

Inspect likely groups:

```bash
prtags group get <group-id>
prtags group get <group-id> --include-metadata
```

Reuse an existing group when:

- it represents the same problem
- it already contains clearly related members
- adding the target would keep the group coherent

Do not widen an existing group just because `gitcrawl` placed several PRs or issues near each other.
Confirm that the actual implementation path and maintainer intent still match before adding the new member.

Create a new group only when no existing group clearly fits.

Create the group with a problem-based title and an intent-based description:

```bash
prtags group create -R openclaw/openclaw \
  --kind mixed \
  --title "<problem-centered title>" \
  --description "<same intent, subsystem, and duplicate-resolution path>" \
  --status open
```

Then attach the target and any known duplicate members:

```bash
prtags group add-pr <group-id> <pr-number>
prtags group add-issue <group-id> <issue-number>
```

If a target appears to already belong to another duplicate group and you cannot safely reuse that group, stop.
Do not create a second group.

## Step 6: Ensure The Annotation Fields Exist

Use `field ensure` so the skill is idempotent.

Recommended target-level fields:

```bash
prtags field ensure -R openclaw/openclaw --name duplicate_status --scope pull_request --type enum --enum-values not_duplicate,candidate,confirmed --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_status --scope issue --type enum --enum-values not_duplicate,candidate,confirmed --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_confidence --scope pull_request --type enum --enum-values low,medium,high --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_confidence --scope issue --type enum --enum-values low,medium,high --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_rationale --scope pull_request --type text --searchable
prtags field ensure -R openclaw/openclaw --name duplicate_rationale --scope issue --type text --searchable
```

Recommended group-level fields:

```bash
prtags field ensure -R openclaw/openclaw --name duplicate_confidence --scope group --type enum --enum-values low,medium,high --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_rationale --scope group --type text --searchable
prtags field ensure -R openclaw/openclaw --name cluster_summary --scope group --type text --searchable
```

## Step 7: Save The Maintainer Judgment In prtags

For a PR:

```bash
prtags annotation pr set -R openclaw/openclaw <pr-number> \
  duplicate_status=confirmed \
  duplicate_confidence=high \
  duplicate_rationale="<same problem, same fix direction, overlapping files and comments>"
```

For an issue:

```bash
prtags annotation issue set -R openclaw/openclaw <issue-number> \
  duplicate_status=confirmed \
  duplicate_confidence=high \
  duplicate_rationale="<same user-visible problem and same intended fix path>"
```

For the group:

```bash
prtags annotation group set <group-id> \
  duplicate_confidence=high \
  cluster_summary="<one-sentence problem summary>" \
  duplicate_rationale="<why these items belong in one duplicate cluster>"
```

When the evidence is incomplete, set `duplicate_status=candidate` and lower the confidence.

If a per-PR or per-issue annotation write fails because `prtags` cannot resolve the target, do not force a fallback write path.
Keep the group state you were able to write, report that the curation backend is still missing the target object, and defer the target-level annotation until `prtags` catches up.

## Step 8: Let prtags Sync The Group Comment

Do not tell the agent to create a GitHub comment directly.
`prtags` owns the outbound GitHub comment as a derived projection of group state.

In the normal case, do not manually trigger comment sync.
When comment sync is configured, group writes already enqueue the derived comment projection automatically.

Use manual sync only as a repair or retry path:

```bash
prtags group sync-comments <group-id>
```

If the maintainer needs to see which groups still need attention, use:

```bash
prtags group list-comment-sync-targets -R openclaw/openclaw
```

The skill should treat the GitHub comment as a consequence of correct `prtags` group state.
It should not treat manual comment authoring as part of the normal duplicate workflow.
It should also not treat `sync-comments` as a required step for every duplicate decision.

## Output Format

Return a short maintainer report with these sections:

```text
Decision: duplicate_confirmed | duplicate_needs_judgment | not_duplicate
Target: PR #<n> | Issue #<n>
Confidence: high | medium | low

Evidence:
- ...
- ...
- ...

prtags actions:
- reused group <group-id> | created group <group-id>
- added members: ...
- annotations written: ...
- comment sync: automatic if configured | manual repair triggered for <group-id>
```

## Stop Conditions

Stop and escalate instead of forcing a duplicate decision when:

- the target appears to belong to two different duplicate groups
- the duplicate grouping is unclear
- the wording matches but the implementation goals differ
- two PRs touch the same files for different reasons
- two issues describe similar symptoms but likely different root causes

The maintainer should get one clean duplicate judgment or an explicit “needs judgment” result.
Do not blur the line.
