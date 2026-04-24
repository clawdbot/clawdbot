---
name: tag-duplicate-prs-issues
description: Search duplicate OpenClaw PRs/issues, group related work in prtags, and sync duplicate state to GitHub.
---

# Tag Duplicate PRs and Issues

Use this skill when a maintainer needs to decide whether a pull request or issue is a duplicate of existing work.

This skill is for maintainer triage and grouping.
It is not for reviewing the implementation quality of a PR.

## Required Setup

Do not start duplicate triage until this setup is complete.

### Install the companion skills

Install these skills first because they teach the agent how to use the two main CLIs correctly:

- `ghreplica` skill from the `ghreplica` repo at `skills/ghreplica/SKILL.md`
- `prtags` skill from the `prtags` repo at `skills/prtags/SKILL.md`

This skill assumes those two skills are available and can be used during the same run.

### Install the CLIs

Install `ghreplica` and `prtags` from their latest GitHub releases.
Do not rely on an old local build unless the maintainer explicitly wants to test unreleased behavior.

`ghreplica` CLI install path:

```bash
curl -fsSL https://raw.githubusercontent.com/dutifuldev/ghreplica/main/scripts/install-ghr.sh | bash -s -- --bin-dir "$HOME/.local/bin"
```

`prtags` CLI install path:

```bash
curl -fsSL https://raw.githubusercontent.com/dutifuldev/prtags/main/scripts/install-prtags.sh | bash -s -- --bin-dir "$HOME/.local/bin"
```

Use the `pr-search-cli` project with `uvx`.
The command itself is `pr-search`.
Do not require a permanent install unless the maintainer explicitly wants one.

```bash
uvx --from pr-search-cli pr-search status
uvx --from pr-search-cli pr-search code similar 67144
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

As soon as you discover that a required CLI is missing or `prtags` is not logged in, stop immediately.
Do not continue in a partial mode after that point.

If `ghr` is missing, ask the user to run the `ghreplica` install command.

If `prtags` is missing, ask the user to run both CLI install commands:

```bash
curl -fsSL https://raw.githubusercontent.com/dutifuldev/ghreplica/main/scripts/install-ghr.sh | bash -s -- --bin-dir "$HOME/.local/bin"
curl -fsSL https://raw.githubusercontent.com/dutifuldev/prtags/main/scripts/install-prtags.sh | bash -s -- --bin-dir "$HOME/.local/bin"
```

If `uvx --from pr-search-cli pr-search ...` fails because `uvx` or the `pr-search` launcher is not available, ask the user to make that command work before continuing.

If `prtags auth status` shows that the user is not logged in, ask the user to run:

```bash
prtags auth login
```

Resume only after the missing tool or login state has been fixed.

## Read-Path Default

For read-only GitHub operations in this workflow, use `ghr` as the default CLI.
Treat it as a drop-in replacement for the `gh` read operations you would normally use for PRs, issues, comments, reviews, and duplicate-search evidence.

Only fall back to `gh` when `ghr` is failing for a concrete reason, such as:

- the mirrored object is not present yet
- the mirror data is clearly stale or incomplete for the decision you need to make
- the `ghr` command errors, times out, or does not expose the specific read you need

When you fall back to `gh`, note that you did so and why.

If `ghr` is missing a fresh PR or issue but `gh` can read it, you may use `gh` for the read-side judgment.
If a later `prtags` target-level write fails because the same object is still missing from `ghreplica`, stop and report that the mirror has not caught up yet instead of forcing the write.

## Goal

For each target PR or issue:

1. gather duplicate evidence
2. decide whether it is a real duplicate
3. create or reuse one `prtags` group for that duplicate cluster
4. save the maintainer judgment in `prtags`
5. rely on normal `prtags` group writes to drive GitHub comment sync when that integration is configured

## Tool Roles

Use the tools with these boundaries:

- `ghreplica` is the raw evidence source
  - use `ghr` first for normal GitHub read operations in this workflow
  - use it for title/body/comment search, related PRs, overlapping files, overlapping ranges, and current PR or issue status
  - resort to `gh` only when `ghr` cannot provide the needed read cleanly
- `pr-search-cli` is candidate generation and ranking
  - use it to suggest likely duplicate PRs or issue-cluster context
  - do not treat it as final truth
  - do not create or expand a duplicate group only because `pr-search-cli` put multiple PRs in the same issue or duplicate cluster
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
Same-issue or same-cluster output from `pr-search-cli` counts only as candidate generation, not as one of the required proof categories by itself.

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
Use `ghr` first for this step even if you would normally reach for `gh`.

For a PR:

```bash
ghr pr view -R openclaw/openclaw <number> --comments
ghr pr reviews -R openclaw/openclaw <number>
ghr pr comments -R openclaw/openclaw <number>
```

For an issue:

```bash
ghr issue view -R openclaw/openclaw <number> --comments
ghr issue comments -R openclaw/openclaw <number>
```

Record:

- target type and number
- title
- problem statement
- proposed intent
- subsystem
- whether it is open, closed, or merged
- whether there is already a likely duplicate thread mentioned by humans

## Step 2: Search Broadly With ghreplica

Use `ghreplica` first because it is the most direct evidence source.
Do not switch to `gh` for ordinary reads unless `ghr` is missing data or failing.

### PR duplicate search

Run all of these when the target is a PR:

```bash
ghr search related-prs -R openclaw/openclaw <pr-number> --mode path_overlap --state all
ghr search related-prs -R openclaw/openclaw <pr-number> --mode range_overlap --state all
ghr search mentions -R openclaw/openclaw --query "<key phrase from title or body>" --mode fts --scope pull_requests --state all
ghr search mentions -R openclaw/openclaw --query "<subsystem or error phrase>" --mode fts --scope issues --state all
```

Use `prs-by-paths` or `prs-by-ranges` when the likely duplicate surface is already known:

```bash
ghr search prs-by-paths -R openclaw/openclaw --path src/example.ts --state all
ghr search prs-by-ranges -R openclaw/openclaw --path src/example.ts --start 20 --end 80 --state all
```

### Issue duplicate search

`ghreplica` does not have a special issue-to-issue “related issues” command.
For issues, search mirrored text and linked PR context instead.

Run targeted text searches:

```bash
ghr search mentions -R openclaw/openclaw --query "<issue title phrase>" --mode fts --scope issues --state all
ghr search mentions -R openclaw/openclaw --query "<error message or symptom>" --mode fts --scope issues --state all
ghr search mentions -R openclaw/openclaw --query "<subsystem phrase>" --mode fts --scope pull_requests --state all
```

Then inspect the candidate PRs or issues those searches uncover.

## Step 3: Use pr-search-cli As A Hint Layer

Use `pr-search-cli` after `ghreplica`.
It is good at surfacing candidates quickly, but it is not the final decision-maker.
Run it through the `pr-search` command.

For a PR:

```bash
uvx --from pr-search-cli pr-search -R openclaw/openclaw code similar <pr-number>
uvx --from pr-search-cli pr-search -R openclaw/openclaw code clusters for-pr <pr-number>
uvx --from pr-search-cli pr-search -R openclaw/openclaw issues for-pr <pr-number>
uvx --from pr-search-cli pr-search -R openclaw/openclaw issues duplicate-prs
```

Interpretation:

- `code similar` suggests PRs with similar change shape
- `code clusters for-pr` shows the PR’s nearby code cluster
- `issues for-pr` shows which issue clusters the PR appears to belong to
- `issues duplicate-prs` is useful for spotting already-known duplicate PR patterns

Treat every `pr-search-cli` result as a hint to investigate, not as enough evidence to create or widen a duplicate group.
Multiple PRs can share the same issue or issue cluster while still taking meaningfully different fix paths.

For an issue:

- use `ghreplica` first to find candidate PRs or issue wording
- if the issue has linked PRs or a likely implementation PR, run `pr-search-cli` on those PRs
- treat issue-cluster output as supporting context, not as enough by itself to call the issue a duplicate

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

Do not widen an existing group just because `pr-search-cli` placed several PRs under the same issue or duplicate cluster.
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

If a per-PR or per-issue annotation write fails because `prtags` cannot resolve the target through `ghreplica`, do not force a fallback write path.
Keep the group state you were able to write, report that the mirror is still missing the target object, and defer the target-level annotation until `ghreplica` catches up.

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
