# Triage, assignment, and closure

Use for queue discovery, related-item research, assignment decisions, and
explicitly authorized labels or closures. Keep review/list requests read-only.

## Discovery

Prefer local Gitcrawl candidates, then verify live with narrow `gh` queries.
Do not rerun a broad sync/enrichment job unless requested or freshness blocks the
actual decision. Search title/body first and comments when context warrants it.
A similarity score never proves duplication or closure eligibility.

For a requested count, return only qualified items; disclose an exhausted search
rather than padding. Favor concrete current bugs with an understood owner and
feasible proof. If the request is for small fixes, exclude feature/product
choices and unclear or broad ownership changes. Do not equate a short diff with
low risk.

Generic shortlists prioritize external contributors. Exclude broad-access
maintainer PRs younger than 14 days unless a named item or explicit request for
maintainer work overrides this. Verify finalist permissions when uncertain; do
not scan every author's complete history. Maintainer-authored issues remain
suppressed in generic discovery unless relevant to the requested scope.

## Assignment

Before deep work on a named item, inspect current assignees. Another assignment
less than six hours old is active ownership; continue only with direction to do
so. Older assignments are an ownership hint, not a silent veto. If assignment
time cannot be verified, say it is unknown. Preserve co-assignees and never
replace them without explicit authority.

Use current assignment timeline evidence when its age matters. Claim only a
named, unassigned item when assignment or landing/autonomous-resolution authority
covers the action, and use the authenticated writer's actual login.

## Labels and closes

Read the current response/label policy before mutation. For a matching automatic
close reason, apply the authorized reason label and let automation own the
comment/close/lock; do not duplicate it manually. Current reason families include
skill/support/third-party integration routing, submission limits, spam, and
invalid/dirty items; verify the actual label rather than inventing one.

For a proven fixed issue or superseded PR, verify current main provides the same
or better behavior. Inspect the original symptom and affected surfaces, preserve
unique evidence, then comment the canonical fix and proof before an authorized
close. A mitigation or diagnostic does not establish that the primary behavior is
fixed. Keep uncertain or actively held work open.

Product rejection and won't-implement/out-of-scope decisions remain maintainer
judgment. Under an explicit decision/close scope, handle its directly associated
cluster consistently and state the rationale, supported alternative, and evidence
that would warrant reopening. Do not close an entire neighborhood from a keyword.

Respect root bulk-mutation approval limits. Stop if ownership, evidence, source
trust, or authorization is uncertain; do not broaden a vague instruction into
mass closures.
