---
name: release-openclaw-maintainer
description: "Prepare, publish, recover, or verify OpenClaw beta, stable, and extended-stable releases, including approved backports."
---

# OpenClaw Release Maintainer

Use for a release operation, not ordinary development or advisory mutation.
Read `docs/reference/RELEASING.md` for current policy. Load `$release-private`
when available before resolving private credential locators or host topology;
credential operations use `$one-password`.

## Choose the operation

Read only the references needed for the selected phase:

- Regular beta/stable preparation or publication: [regular release](references/regular-release.md), which routes preparation and phase-specific proof. If the request does not specify stable/full, default to beta; beta authorization does not authorize later stable promotion.
- Backport discovery: [candidate inventory](references/backport-discovery.md). For extended-stable also read [backport preparation](references/extended-stable-backports.md); SDK/config changes need a visible maintenance-risk warning and maintainer decision.
- Extended-stable `.33+` Gateway publication: [extended-stable publication](references/extended-stable-publish.md). Do not use the regular release sequence or inherit GitHub Release/native-app publication.
- Validation selection or failed proof: [validation and confidence](references/validation.md), with `$release-openclaw-ci` for workflow execution and immutable manifests.
- Interrupted publication or registry promotion: [publication recovery](references/publication-recovery.md).
- Native assets: [platform publication](references/platform-publication.md), with `$release-openclaw-mac` for macOS operations.
- Stable postpublish synchronization: [main closeout](references/stable-main-closeout.md).
- Release notes: `$openclaw-changelog-update`. Requested announcements: `$release-openclaw-announcement` for Discord, `$release-tweets` for X. Announcements never gate publication and require explicit posting authorization.
- Published artifact verification: `$verify-release`. GHSA operations: `$openclaw-ghsa-maintainer` only with explicit security-workflow authorization.

## Shared release boundaries

Explicit approval is required for version changes and irreversible publication.
A request to cut, publish, or complete a named release carries through its
validated publication and verification; do not ask again unless identity,
channel, scope, or material risk changes. Ship authority for ordinary code is
not release authority.

Keep one compact state record using
[the handoff template](references/release-handoff-template.md): effective goal,
version/tag/branch, cut/Code/Tooling/Release SHAs, active parent run and attempt,
successful child artifacts, approved changes, phase and next action. Latest
operator steering replaces superseded scope. Completed evidence stays complete
until a named change invalidates it.

For regular releases, freeze product-complete **Code SHA** before generating
the changelog. Require its Full Release Validation decision, then create
**Release SHA** with a complete delta of exactly `CHANGELOG.md`. The
`changelog-only-release-v1` policy reuses product proof while qualifying fresh
publication bytes. Any other source delta returns to the Code SHA loop.
Keep trusted **Tooling SHA** separate; tooling or infrastructure failures do
not justify changing the candidate.

Published versions and final tags are immutable. Reuse successful exact-source
artifacts; do not rebuild or republish as an implicit retry. The active release
is the work queue: no opportunistic moving-main fixes or backports. Classify
failures, repair their owner, retry the affected surface, then reassess rather
than repeating the full release.

Required checks and enforced environment approvals remain required. A passing
sibling lane cannot waive a failure. Native platforms have independent gates;
pending app assets do not hold npm/GitHub finalization or main closeout. Report
proof gaps and pending platforms accurately.
