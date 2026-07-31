# Next Best Move

## Ranked move 1

Glen reviews the open draft pull request:
https://github.com/openclaw/openclaw/pull/116673.

- BDMA rights fit: direct operator review is within Glen's decision-owner role.
- Assigned team: Glen as reviewer; no worker action is implied.
- Proof bar: inspect the draft diff, evidence manifest, retained limitations,
  source digest, and open/draft/unmerged state.
- Stop triggers: unexpected files, source-digest drift, lost draft status,
  missing evidence, or a request for merge/release/production action.
- Continuity prompt: “Review draft PR 116673 and return either acceptance for
  continued draft review or a bounded change request. Do not merge.”

## Ranked move 2

If Glen or maintainers request changes, open a new bounded repair cycle.

- BDMA rights fit: only the exact requested source/evidence repair is in scope.
- Assigned team: one builder plus fresh blind reviewers appropriate to the
  affected contracts.
- Proof bar: reproduce the issue, repair the smallest safe surface, regenerate
  checksums/fixtures if applicable, rerun all 161+ tests, reinstall only after
  acceptance, and restart every countable review when the source digest changes.
- Stop triggers: unclear authority, objective change, unrelated repository work,
  inability to preserve install/rollback safety, or pressure to retain stale
  acceptance.
- Continuity prompt: “Create an MSO for the exact requested repair, preserve
  this evidence package, and invalidate all digest-bound acceptance before
  editing.”

## Ranked move 3

After separate maintainer authority, treat merge or release as a new mission.

- BDMA rights fit: currently outside authority; reserved.
- Assigned team: repository maintainer and release owner, not this completed
  builder mission.
- Proof bar: fresh mainline integration, required CI, security review, explicit
  merge authority, and any release-specific checks.
- Stop triggers: absent explicit authority, stale branch, failed CI, changed
  trust boundary, or any production credential/runtime requirement.
- Continuity prompt: “Do not infer merge or release authority from the
  charrette, this mission, or draft-PR acceptance; request exact fresh
  authority.”

Only ranked move 1 is the current canonical next action.
