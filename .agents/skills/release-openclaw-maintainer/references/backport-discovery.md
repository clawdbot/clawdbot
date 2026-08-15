# Evidence-Driven Backport Discovery

Use this before selecting backports for any OpenClaw release line: regular
beta/stable, extended-stable, alpha/nightly when it reuses an older release
base, or a release-repair branch. It is an audit before the candidate is
mutated, not a title search and not permission to expand a frozen release.

## Freeze the Audit

1. Pin the exact maintenance-line baseline and the exact `origin/main` SHA.
   Use the release branch/tag/package baseline that users run, not a moving
   local branch.
2. Resolve the last accepted, auditable scan cursor. If none exists, use the
   merge base of that baseline and the pinned main SHA. Histories without an
   auditable cursor or merge base require maintainer direction; never guess
   from dates, PR titles, or a previous abandoned release PR.
3. Enumerate every main commit since that cursor, then remove only commits
   proven patch-equivalent to the baseline. Account for merge, squash, direct,
   reordered, and companion commits; `git cherry` is evidence, not the final
   answer.
4. Reconcile authorized public and private security advisories before calling
   the inventory complete. Use the approved private advisory workflow for
   unpublished details. The public record may say only `pending` or `cleared`.

Keep a durable unreleased backport ledger with the staging evidence: scan
bounds and pinned SHAs, baseline identity, total/equivalent/non-equivalent
counts, filters, every candidate decision, applicability result, exclusions,
dependency groups, and carry-forward blocked items. Security rows in public
evidence must remain opaque; retain private identifiers only in the approved
security record. The next accepted audit uses this ledger's `scan_end` as its
cursor.

## Reconcile Stable-Maturity Issues

At the pinned `origin/main` SHA, snapshot all OpenClaw issues carrying
`maturity:stable` and record the query time with the audit bounds. This is a
secondary completeness and priority check over the commit inventory, not a
replacement for it. The label means the current issue review matched broken
existing behavior to a primary M4/M5 scorecard surface; it does not prove the
issue, identify a complete fix, approve a backport, or block a release by
itself.

For each labelled issue, whether open or closed, whose fixing PR or commit
actually landed in the scan range, link that fix to its commit-ledger row and
require an ordinary `backport`, `already-covered`, `not-affected`, `blocked`,
or `skip` decision. Do not omit a commit based on its linked issue's state, and
do not add one merely because the issue has this label. For each open P0/P1
labelled issue, add a release-readiness disposition: fixed by the candidate,
not affected on the release baseline, explicitly deferred by a maintainer, or
blocked because no proven fix exists. Open issues without a merged fix are not
backport candidates.

Read the current review rationale before relying on the signal. If the issue is
a feature proposal, new config or policy request, docs/support work, or is
primarily owned by a below-M4 surface, record `label-drift` in the audit and do
not treat it as a maturity candidate. Release discovery reports drift but does
not mutate issue labels. Keep the underlying commit and security inventory
complete even when label data is missing, stale, or wrong.

## Find Reliability and Security Candidates

Do not use commit subjects, labels, or PR visibility as an inclusion gate.
Classify every non-equivalent commit in the ledger, and inspect the full
production diff for every security- or reliability-signalled item.

Search beyond explicit security terms. Separately review conventional
`fix`, `perf`, and `doctor` commits whose production paths touch execution,
authentication, sandboxing, networking, persistence, delivery, gateway,
configuration, plugins, or major channels. Benign titles, dependency bumps,
missing PRs, and broad batches can conceal operational fixes; they require a
decision with evidence, not a cursory skip.

For each such production diff, mechanically probe applicability in a temporary
detached worktree at the pinned baseline before judging it:

```bash
audit_root=$(mktemp -d)
git worktree add --detach "$audit_root/baseline" "$baseline_sha"
(
  cd "$audit_root/baseline"
  git cherry-pick --no-commit "$candidate_sha"
  git diff --check
  git reset --hard HEAD
)
git worktree remove --force "$audit_root/baseline"
rmdir "$audit_root"
```

Record whether the probe was clean, conflicted, empty/already-covered, or
failed, along with the exact reason. A clean probe is triage evidence only; it
does not approve a backport. If the commit needs companions, probe and assess
the smallest ordered final fix rather than treating each clean commit as an
independent candidate.

## Decide and Present the Set

For every proposed backport, inspect the complete change, baseline behavior,
callers, callees, sibling surfaces, tests, dependency contracts, security
impact, and the release publication surface. Collapse overlapping or dependent
commits to the smallest final fix. Mark already-covered, not-affected,
out-of-scope, and blocked items with the evidence that led to the decision.

Exclude features, migrations, new configuration, new runtime requirements, and
broad redesigns unless a maintainer explicitly approves their inclusion. Do not
substitute convenient dependency bumps for a complete candidate audit.

Before changing release refs, present the complete categorized ledger and the
proposed set for maintainer approval. After approval, backport with provenance,
update the ledger, run focused proof plus the release-appropriate validation,
and keep the final branch/tag/version/SHA identity in that record. Dispatch npm
preflight only after the canonical release branch or tag has that exact final
version and SHA.
