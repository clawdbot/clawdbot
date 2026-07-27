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
