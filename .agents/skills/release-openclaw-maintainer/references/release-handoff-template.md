# Release Handoff

Use this compact record to start or resume one release session. Replace every
placeholder with current live state. Omit completed detail that is already
captured by a durable run or artifact URL.

## Goal

Ship `<version>` on `<channel>` and stop when `<terminal success criteria>`.
After compaction or resume, replace this section with the latest explicit
operator steering. Do not preserve superseded scope.

## Immutable state

- track: `<regular beta/stable | extended-stable>`
- branch: `<release/YYYY.M.PATCH | extended-stable/YYYY.M.33>`
- cut SHA: `<full sha>`
- Code SHA: `<regular release full sha | not applicable>`
- Tooling SHA: `<trusted workflow full sha>`
- Release SHA: `<regular release full sha | exact extended-stable branch tip>`
- tag: `v<version>`
- workflow ref: `<release-ci ref | canonical branch>`
- publication inventory: `<exact surfaces>`
- approved backports: `<none or exact PRs/commits>`
- approved main changes: `<none or exact blocker>`
- admitted release blockers: `<confirmed product/package/provenance/security blockers only>`
- frozen-target compatibility repairs: `<none or exact PRs/invariants>`

## Active evidence

- Full Release Validation parent: `<run id / attempt / URL or none>`
- npm preflight: `<run id / URL or none>`
- Plugin NPM Release: `<run id / URL or none>`
- publish parent: `<run id / URL or none>`
- Docker release/repair: `<run ids / tag / aliases or none>`
- immutable successful children: `<run ids / artifacts or none>`
- registry/provenance readback: `<artifact or command result>`

## Publication surfaces

Keep one row per selected surface, with its exact run/attempt or immutable
receipt, current state, and next action. Remove unselected rows rather than
reporting them as passed. Stable/full includes macOS unless explicitly scoped
out; extended-stable does not inherit ClawHub, GitHub Release, or native apps.

| Surface                 | Evidence and state                                                   | Next action or blocker |
| ----------------------- | -------------------------------------------------------------------- | ---------------------- |
| Core and plugin npm     | `<version, selectors, parent/child receipts>`                        | `<action>`             |
| Docker                  | `<digests, aliases, run/attempt>`                                    | `<action>`             |
| ClawHub                 | `<child and postpublish verification receipts>`                      | `<action>`             |
| GitHub Release / Latest | `<release URL, draft/prerelease/latest readback>`                    | `<action>`             |
| macOS                   | `<handoff, validation, notarized preflight, promotion run/attempts>` | `<action>`             |
| Stable appcast          | `<signed artifact, main commit/PR, public feed readback>`            | `<action>`             |
| Other selected apps     | `<platform, exact source, publication proof>`                        | `<action>`             |
| Stable main closeout    | `<PR, shipped metadata, immutable closeout manifest>`                | `<action>`             |

A successful publish parent does not complete detached ClawHub verification or
macOS. Preserve their exact identities and advance ready independent work while
another surface waits. Staging is not public ClawHub byte verification; npm
`latest` is not GitHub Latest verification. Use the owning platform/recovery
reference for commands rather than redispatching the release parent.

## Phase

- conceptual phase: `<beta-publish | postpublish-confidence | stable-publish>`
- current input mapping: `<beta + no soak | published package + soak/focused groups | stable>`
- completed: `<phases that stay complete>`
- current: `<one phase>`
- next action: `<one concrete action>`
- roles: `<one operator | one transition watcher | zero or one current-failure investigator>`
- retry budget: `<one diagnosis/fix/narrow retry, then reassess>`

## Failure policy

- confirmed product/code failure: fix the release branch, freeze a new Code
  SHA, and invalidate downstream product evidence
- regular changelog-only failure: change only `CHANGELOG.md`, freeze a new
  Release SHA, and reuse green Code SHA evidence after delta proof
- extended-stable branch change: land the approved product/changelog change or
  smallest frozen-target repair by PR, record its source/invariant, and replace
  all exact-head evidence
- harness/tooling/provenance failure: keep the Code SHA, change the Tooling SHA
  only when needed, and recover the smallest owning surface
- infrastructure/credential failure: keep both SHAs and repair the external
  prerequisite
- wrapper/monitor failure: record parent and child conclusions separately;
  parent cancellation leaves adopted children running until the operator
  cancels them explicitly
- postpublish-confidence failure: do not retroactively unpublish the beta;
  admit a confirmed product fix to the next beta
- external approval or permission blocker: pause that surface with the exact
  job, URL, enforced rule, and required owner action; continue independent
  authorized work. Do not invent another consent step for an approved release.

Do not scan moving `main`, add optional backports, dispatch a replacement
validation parent, automatically rerun `all`, or repeat completed phases unless
a named invalidating event requires it. Narrow evidence informs the release
decision but is not publish authorization by itself.

## Stop conditions

- success: `<exact published and verified state>`
- blocked: `<one precise external action that only the operator can complete>`
