# Stable main closeout

This gate starts only after stable publication. It is a narrow shipped-state
closeout, not permission to heal broader `main`. Stable publication is not
complete until `main` carries the actual shipped release state.

1. Start from fresh latest `main`. Use a same-repository PR targeting `main`,
   with branch `release/<version>-main-closeout` and exact title
   `chore(release): close out <version> on main`. `<version>` is the published
   stable `YYYY.M.PATCH` (or `YYYY.M.PATCH-N` correction), without the `v` prefix.
   Audit `release/YYYY.M.PATCH` against it and
   forward-port real fixes that are absent from `main`. Do not blindly merge
   release-only compatibility, test, or validation adapters into newer `main`.
2. Set `main` to the shipped stable version, not a speculative next train. Run
   `pnpm release:prep` after the root version change, then
   `pnpm deps:npm-lock:check`.
3. Make `CHANGELOG.md`'s `## YYYY.M.PATCH` section on `main` exactly match the
   tagged release branch. Include the stable `appcast.xml` update when the mac
   release published one. `scripts/pr prepare-run` permits this closeout without
   an override when `v<version>` exists on origin and the changelog diff only adds
   or replaces that version's section (or finalizes the existing unreleased
   section); leave all other sections and the preamble unchanged.
   `OPENCLAW_ALLOW_ROOT_CHANGELOG_PR=1` remains an explicit override
   for release automation outside this convention.
4. Do not add `YYYY.M.PATCH+1`, a beta version, or an empty future changelog
   section to `main` until the operator explicitly starts that release train.
5. Run `pnpm release:generated:check`, `pnpm deps:npm-lock:check`, and
   `OPENCLAW_TESTBOX=1 pnpm check:changed`. Push, then verify `origin/main`
   contains the shipped version and changelog before calling the stable release
   done.
6. Keep repository variables `RELEASE_ROLLBACK_DRILL_ID` and
   `RELEASE_ROLLBACK_DRILL_DATE` current after each private rollback drill.
   `openclaw-stable-main-closeout.yml` starts from the `main` push carrying the
   shipped version and changelog after stable publication, then binds immutable
   evidence to the published tag. App assets may still be pending; record
   `appPlatforms` states for macOS, Windows, and Android, with aggregate
   `apps: attached` only when every canonical platform asset contract is
   complete. Otherwise record `apps: pending`. Require `appcast: verified`
   only once the complete macOS zip/DMG/dSYM set is attached; record
   `appcast: pending` otherwise. Later canonical app attachments do not
   invalidate the immutable closeout snapshot. Do not declare stable complete
   until it writes the immutable closeout manifest to the GitHub release. The
   drill must be within 90 days; manual dispatch is only for repair/replay, and
   private rollback commands remain in the maintainer-only runbook.
