# Release Handoff

Use this compact record to start or resume one release session. Replace every
placeholder with current live state. Omit completed detail that is already
captured by a durable run or artifact URL.

## Goal

Ship `<version>` on `<channel>` and stop when `<terminal success criteria>`.

## Immutable state

- branch: `release/<YYYY.M.PATCH>`
- cut SHA: `<full sha>`
- Code SHA: `<full sha or not frozen>`
- Release SHA: `<full sha or not frozen>`
- tag: `v<version>`
- approved backports: `<none or exact PRs/commits>`
- approved main changes: `<none or exact blocker>`

## Active evidence

- Full Release Validation parent: `<run id / attempt / URL or none>`
- npm preflight: `<run id / URL or none>`
- publish parent: `<run id / URL or none>`
- immutable successful children: `<run ids / artifacts or none>`

## Phase

- completed: `<phases that stay complete>`
- current: `<one phase>`
- next action: `<one concrete action>`

## Failure policy

- product/code failure: fix the release branch, freeze a new Code SHA, and
  invalidate downstream product evidence
- changelog-only failure: change only `CHANGELOG.md`, freeze a new Release SHA,
  and reuse green Code SHA evidence after delta proof
- workflow/tooling/credential failure: keep the candidate frozen and recover
  the smallest owning surface
- external approval or permission blocker: stop with the exact job, URL,
  missing permission, and required operator action

Do not scan moving `main`, add optional backports, dispatch a replacement
validation parent, or repeat completed phases unless a named invalidating event
requires it.

## Stop conditions

- success: `<exact published and verified state>`
- blocked: `<one precise external action that only the operator can complete>`
