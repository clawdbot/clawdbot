# Release preparation

Read `docs/reference/RELEASING.md` for current public policy. For regular
releases, select the cut SHA once: use the operator's exact SHA or fetch
`origin/main` once and record its full SHA and CI state. Create a clean worktree
and `release/YYYY.M.PATCH` from it. Never absorb unrelated dirty files.

The release branch is the active queue. Moving main is a workflow/provenance
source, not an invitation to add fixes. Touch main before publication only for
an operator-requested change or a critical blocker owned there that cannot be
fixed or proven on the release branch. Keep that repair bounded, use
`$openclaw-pr-maintainer`, then return to the release. Defer ordinary
forward-ports until after publication.

## Version and channel

`YYYY.M.PATCH` uses a sequential monthly train number, not the calendar day.
Choose beta trains from stable/beta tags only; alpha-only tags do not consume a
train. Continue an existing beta train with its next `beta.N` when appropriate,
otherwise increment the highest stable/beta patch and start at `beta.1`.
Prefer `-beta.N`, never new numeric-only beta suffixes.

| Track           | Branch/version                                                 | Registry selector                                                |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| Regular beta    | `release/YYYY.M.PATCH`, `YYYY.M.PATCH-beta.N`                  | `beta`                                                           |
| Regular stable  | `release/YYYY.M.PATCH`, `YYYY.M.PATCH`                         | `beta` by default; intentional publication/promotion to `latest` |
| Extended stable | `extended-stable/YYYY.M.33`, trailing completed month's `.33+` | `extended-stable`                                                |
| Development     | moving main                                                    | not a release                                                    |

Use the release preparation controller before manual version edits:

```bash
pnpm release:prepare -- --version YYYY.M.PATCH-beta.N --shadow
pnpm release:prepare -- --version YYYY.M.PATCH-beta.N --write
pnpm release:prepare -- --version YYYY.M.PATCH-beta.N --check
```

Shadow is nonmutating. Write aligns the owned root/macOS versions and the
version-generated metadata DAG; add `--android` only when Android is selected.
The controller's manifest is bound to the exact HEAD/worktree.
Check version-bearing package, app plist/Gradle, updating-doc, and Peekaboo
project fields against their platform contract. `appcast.xml` is generated at
macOS publication, not a blanket version-bump target. For fallback correction
tags `vYYYY.M.PATCH-N`, those source version fields remain `YYYY.M.PATCH`;
macOS needs a strictly higher numeric `APP_BUILD`.

Android is independently pinned in `apps/android/version.json`. If the stable
release should include its APK, prepare it before tagging with `--android` or
`scripts/mobile-release-version.ts --prepare --version YYYY.M.PATCH --write`.
An older pin causes candidate/publish to skip Android; an immutable tag cannot
be repaired later to add that platform.

## Selected changes and compatibility

When backport discovery is requested or part of planning, read
[backport discovery](backport-discovery.md), freeze the baseline and main SHA,
and obtain approval for the categorized ledger before mutating the branch.
Backports stay optional and operator-selected. An unspecified target means the
newest open release branch. Extended-stable preparation additionally uses
[its backport procedure](extended-stable-backports.md).

Before branching and before final publish, inspect
`src/plugins/compat/registry.ts` and
`src/commands/doctor/shared/deprecation-compat.ts`. A deprecated record due by
the release date must be safely removed and verified, or marked
`removal-pending` with an explicit maintainer-approved blocker. Revalidate due
pending records and their upgrade conditions. Preserve doctor repairs still
needed by supported upgrades; track them until maintainers approve removal.
Recheck replacement wording against current plugin ownership/config behavior.
For records whose `warningStarts` or `removeAfter` falls within seven days of
release, include Upcoming deprecations with code, date, replacement and
`docsPath` (or `/plugins/compatibility`).

Freeze the product-complete tree, including approved versions and fixes but no
new release changelog, as **Code SHA**. After this point admit only confirmed
product, package/provenance, security, or publication-blocking defects; defer
adjacent improvements. Validate that Code SHA before changelog work.

## Changelog and release notes

Use `$openclaw-changelog-update` for source-history inventory, human credit,
editorial grouping, renderer limits, and verification. Generate once after
Code SHA passes; same-candidate retries reuse it. Beta notes use the stable-base
`## YYYY.M.PATCH` section, with Highlights, Changes and Fixes. Canonical PR
provenance follows current `origin/main`; retain a release-branch PR only while
its change has not been forward-ported. Do not change root README as routine
release prep or prefill a future changelog section.

Commit only the release changelog to create **Release SHA**. Its complete diff
from Code SHA must be exactly `CHANGELOG.md`; otherwise reenter product
validation. Use the canonical release-note renderer and verifier before
publication and closeout. The publish workflow owns GitHub page finalization
only after postpublish evidence succeeds.
