---
name: openclaw-pr-maintainer
description: "Review, triage, repair, or land OpenClaw issues and pull requests with current-source evidence and the native maintainer workflow."
---

# OpenClaw PR Maintainer

Use for the requested OpenClaw issue/PR operation. Root `AGENTS.md` owns repair,
product, source-trust, and approval policy; this skill owns the GitHub workflow.
A pasted ref is context, not permission to publish or expand the task.

## Select the scope

- **Review, triage, or list:** read-only. Explain the change, actionable findings,
  useful evidence, and material uncertainty. Do not edit, assign, label, comment,
  or close unless separately authorized.
- **Fix only:** investigate, repair locally, and validate. Publishing still
  requires ship/land or equivalent scoped authority.
- **Land/ship or autonomous repair:** finish the authorized scope through current
  source proof, review, exact-head CI, native merge, and remote verification.
  Preserve contributor credit and unrelated work. Routine steps need no repeated
  permission; security, schema, product, release, and other root gates remain.
- **Queue/discovery:** read [triage](references/triage.md). Batch live reads and
  shared discovery; do not turn one named PR into an unsolicited queue sweep.
- **Author or regression attribution question:** read
  [author and provenance research](references/attribution.md). Account age and
  contribution-history queries are conditional, not a prerequisite for every PR.

The lead remains hands-on. Use bounded independent workers where they add
useful evidence; serialize shared checkout/ref mutations and GitHub writes.
Do not create user-owned app tasks to hide internal subtasks. Preserve a stalled
worker's patches, claims, and proof before taking over or reassigning its work.

## Inspect the actual item

Start with `git status -sb`; preserve unrelated changes. Use available local
`gitcrawl` data for related work when useful, then bare PATH `gh` with narrow
JSON fields for live decisions. Stale/missing archives fall through to `gh`;
do not broadly sync archives just to begin. PR source comes from `gh pr
view/diff` and the checkout, not web search.

```bash
gh pr view <pr> --repo openclaw/openclaw \
  --json number,title,state,body,author,assignees,baseRefName,headRefName,headRefOid,files,comments,reviews
gh issue view <issue> --repo openclaw/openclaw \
  --json number,title,state,body,author,assignees,comments
```

Check assignment before deep work. Mention another assignee and treat a fresh
assignment as active ownership unless the user directs otherwise. Assignment
alone is not a block when stale or explicitly overridden. Claim an unassigned
named item only under assignment or landing/autonomous-resolution authority,
using the verified authenticated login. Never remove others' assignments
without direction. Account/activity research belongs to its conditional route.

## Establish the outcome

Read the affected owner, entry points, callers, relevant siblings, tests, docs,
history, and current main as needed to support a conclusion. Inspect dependency
contracts directly when they determine behavior; apply the root's personal
Codex-source inspection requirement when relevant. Investigate contrary evidence
before defending a verdict. Do not fill an arbitrary evidence matrix or invent
a rejected alternative merely to satisfy a form.

- **Already fixed:** prove the original behavior is repaired on current main,
  with the canonical commit/PR and matching source or runnable proof. Under
  closure authority, comment that evidence and close; otherwise report it.
- **Real defect:** reproduce it, repair its owning invariant, and prove the
  repaired path and affected siblings. Prefer a coherent simplification over a
  symptom guard. Size and LOC are context, not correctness gates.
- **Existing useful PR:** improve the editable branch rather than replacing it
  unnecessarily. If it cannot safely be updated, create an authorized credited
  replacement before closing the source. Never squash a contributor-owned PR
  after replacing its ancestry; use a maintainer-owned replacement.
- **Uncertain or product decision:** state the concrete gap. Do not merge a
  speculative repair or automatically close work as out of scope.

Use `$openclaw-testing` to choose proportional proof and its source-trust/host
route. Trusted development proof defaults local; remote proof needs an environment
or isolation reason. Unavailable optional live proof may use meaningful boundary
proof with the limitation stated. Explicit live requests, external API contracts,
and changes whose risk requires authenticated execution keep their required proof.
Never describe mocks, skipped checks, or an older head as live evidence.

## Review and publish

Before committing or landing nontrivial code, run `$autoreview` and resolve
verified actionable findings. Use it for a review-only request when that request
asks for independent autoreview; ordinary findings-only review does not need a
second reviewer by default. Do not add another mandatory CLI review pass.
Reopen review for substantive changes or unresolved concerns, not a patch-identical
rebase or a mechanical head change. Address real human/bot findings and explain
rejected ones; bot scores and Rank-up lists do not create separate obligations.

Use the current PR template. Keep problem, solution, user impact, useful evidence,
known gaps, and contributor credit current. Explain material tradeoffs when they
matter; do not require universal LOC tables, provenance fields, or alternate-fix
essays. `CHANGELOG.md` is release-owned; user-facing release-note context stays
in the PR/commit. Omit agent transcripts unless explicitly requested.

Before public mutation, verify author/committer and authenticated writer identity.
Use body files for shell-sensitive text. Post findings only under the authorized
write scope, and update an existing relevant comment/body instead of duplicating it.
Publication, media, exact-head CI, and native landing mechanics are in
[landing](references/landing.md); read that reference before publishing or merging.

Verify the final merge/closure state and source rather than trusting a local
summary. Report the problem, owner-level change, important proof and limitations,
credit, and linked final state in concise prose. Record worthwhile follow-ups;
do not manufacture another task after a bounded request is complete.
