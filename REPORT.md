# W4 Drafts UX implementation report

## Outcome

Implemented the complete drafts UX on top of the landed ownership, visibility, membership, and person-filter machinery.

- New-session creation can start atomically as `visibility: "draft"`; the initial durable session entry carries draft visibility before the create response or any session-change broadcast.
- The create affordance is exposed only when the hello policy allows drafts and the Gateway reports at least two canonical, non-merged sharing identities. Older gateways and solo mode fail closed by hiding the control.
- Own drafts keep normal row emphasis with a subtle ghost marker. Admin-visible drafts owned by someone else use the same draft class family with a faded, light/dark-safe treatment.
- A dedicated **Publish draft** header menu item calls the existing visibility callback with `"shared"`, which continues through the landed `session.visibility.set` RPC, audit-line, rollback, and live-event path.
- Multi-user and sharing configuration docs now explain create-as-draft behavior, admin visibility, and the non-security-boundary constraint.
- No suggestion queue, invite link, config key, SQLite schema/table/version, membership enforcement, new Gateway event, or changelog change was added.

## Files changed

### Protocol and Gateway

- `packages/gateway-protocol/src/schema/sessions-create.ts`
- `packages/gateway-protocol/src/schema/sessions-create.test.ts`
- `packages/gateway-protocol/src/schema/frames.ts`
- `src/gateway/session-create-service.ts`
- `src/gateway/server-methods/sessions-create.ts`
- `src/gateway/server/ws-connection/connect-hello.ts`
- `src/gateway/server.sessions.create.test.ts`
- `src/gateway/server.auth.default-token.suite.ts`
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`

The Kotlin generators ran successfully; their tracked outputs were byte-identical. `dist/protocol.schema.json` is generated locally by protocol checks but remains ignored and untracked, matching `origin/main`.

### Control UI

- `ui/src/pages/new-session/new-session-page.ts`
- `ui/src/pages/new-session/create-params.ts`
- `ui/src/pages/new-session/create-params.test.ts`
- `ui/src/pages/new-session/catalog-target.ts`
- `ui/src/pages/new-session/target-controls.ts`
- `ui/src/pages/new-session/target-controls.test.ts`
- `ui/src/pages/chat/components/chat-session-sharing.ts`
- `ui/src/pages/chat/components/chat-session-sharing.test.ts`
- `ui/src/components/app-sidebar-session-navigation-logic.ts`
- `ui/src/components/app-sidebar-session-navigation-logic.test.ts`
- `ui/src/components/app-sidebar-session-row-render.ts`
- `ui/src/components/app-sidebar-session-types.ts`
- `ui/src/styles/components.css`
- `ui/src/styles/new-session.css`
- `ui/src/i18n/locales/en.ts`
- `ui/src/e2e/session-ownership.e2e.test.ts`
- `ui/src/test-helpers/control-ui-e2e.ts`

### Docs

- `docs/concepts/multi-user.md`
- `docs/gateway/config-agents.md`

### Local proof artifacts, not committed

- `.artifacts/control-ui-e2e/drafts-ux/behavior-contract.md`
- `.artifacts/control-ui-e2e/drafts-ux/01-sidebar-draft-treatment.png`
- `.artifacts/control-ui-e2e/drafts-ux/01-sidebar-draft-treatment-dark.png`
- `.artifacts/control-ui-e2e/drafts-ux/02-create-draft-available.png`
- `.artifacts/control-ui-e2e/drafts-ux/03-create-draft-selected.png`
- `.artifacts/control-ui-e2e/drafts-ux/04-publish-draft-action.png`
- `.artifacts/control-ui-e2e/drafts-ux/*.webm`

## Key decisions and ambiguity resolution

1. `visibility` is optional and additive in `SessionsCreateParamsSchema`. Omission preserves the prior storage shape and projects as `shared`. New rows reject a disallowed visibility with `SESSION_VISIBILITY_DISABLED`; keyed adoption is allowed only when the requested visibility exactly matches the existing effective visibility, including after policy changes. Mismatches and in-place resets remain rejected.
2. The hello `policy` object now exposes optional `allowedSessionVisibilities` and `hasMultipleSessionSharingIdentities`. Current Gateways always populate both. Optional schema fields preserve compatibility with older Gateway/client pairs.
3. The multi-user boolean comes from canonical non-merged user profiles, not loaded session creators. It reveals only whether the draft UI's two-identity threshold is met, not the exact profile count.
4. The new-session UI rechecks the hello policy at submit time and clears a checked draft selection as soon as policy/identity availability disappears. A hidden prior choice cannot silently reactivate.
5. Admin ownership styling compares the session creator id with the current authenticated user id because `sharingRole: "admin"` intentionally wins over `"owner"` for administrators.
6. Promotion remains one existing `session.visibility.set` call with `visibility: "shared"`; no parallel publish method, event, audit path, or invite workflow was introduced.
7. The sidebar's pending unsent-composer `showDraft`/`renderDraftSessionRow` machinery was not touched.

## Verification

All final code commands below ran against implementation HEAD `0c755a401b47a9c12f61d8a01b49017f3f938e2d`, rebased onto `977db1c83261b13e92e7ad74c5f544e61acf1b90`. `origin/main` advanced by six commits during the final proof; no further moving-base rebase was attempted after the successful gate.

### Install and formatting

- `pnpm install`
  - Initial fresh install: exit 0, 1,272 packages, pnpm 11.2.2.
  - Final post-rebase refresh: exit 0 using pnpm 11.15.1; lockfile supply-chain policies passed and 285 packages were refreshed.
- `./node_modules/.bin/oxfmt --write --threads=1 <changed files>`
  - Exit 0. The final changed gate reported `All matched files use the correct format.`
- `git diff --check origin/main...HEAD`
  - Exit 0, no output.

### Focused Vitest and browser behavior

- `node scripts/run-vitest.mjs packages/gateway-protocol/src/schema/sessions-create.test.ts ui/src/pages/new-session/create-params.test.ts ui/src/pages/new-session/target-controls.test.ts ui/src/pages/chat/components/chat-session-sharing.test.ts ui/src/components/app-sidebar-session-navigation-logic.test.ts`
  - Exit 0.
  - Gateway-client shard: 1 file, 2 tests passed.
  - UI shard: 4 files, 21 tests passed.
  - Final wrapper: `passed 2 Vitest shards in 7.32s`.
- `node scripts/run-vitest.mjs src/gateway/server.sessions.create.test.ts`
  - Exit 0: 1 file, 67 tests passed; final wrapper `passed 1 Vitest shard in 22.51s`.
  - Covers omitted visibility -> shared projection, draft visibility on the first list, disabled new drafts, matching keyed adoption, mismatched adoption rejection, and exact retry after policy disable.
- `node scripts/run-vitest.mjs src/gateway/server.auth.default-token.test.ts`
  - Exit 0: 1 file, 23 tests passed; final wrapper `passed 1 Vitest shard in 6.49s`.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/session-ownership.e2e.test.ts`
  - Exit 0: 1 file, 7 tests passed in 5.75s.
  - Proves multi-person availability, solo dormancy, atomic `sessions.create` traffic, own/foreign sidebar treatment, light/dark rendering, one-call publish, and clearing a selected draft mode after policy becomes unavailable.

### Required typechecks

- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-tsgo.mjs -p tsconfig.core.json`
  - Exit 0, no diagnostics.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-tsgo.mjs -p tsconfig.ui.json`
  - Exit 0, no diagnostics.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-tsgo.mjs -p tsconfig.extensions.json`
  - Exit 0, no diagnostics.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-tsgo.mjs -b tsconfig.projects.json`
  - Exit 0, no diagnostics.

### Protocol and localization

- `pnpm protocol:gen`
  - Exit 0; wrote the local ignored `dist/protocol.schema.json` without adding it to Git.
- `pnpm protocol:gen:swift`
  - Exit 0; wrote `GatewayModels.swift`.
- `pnpm protocol:gen:kotlin`
  - Exit 0; wrote both Kotlin generator targets, with no tracked diff.
- `pnpm protocol:check`
  - Exit 0; regenerated JSON/Swift/Kotlin and printed `protocol since guard passed: 0 new core methods use train 2026.7`.
- `node --import tsx scripts/control-ui-i18n-verify.ts baseline`
  - Exit 0: `raw-copy: baseline entries=105`, `source: keys=3968`.
- `node --import tsx scripts/native-app-i18n.ts baseline --write`
  - Exit 0: `entries=5232 changed=true`; the diff contained only unrelated current-main iOS source-line shifts and was discarded rather than added to W4.

### Docs and changed gate

- `pnpm docs:check-mdx`
  - Exit 0: `Docs MDX check passed (751 files, 3308ms).`
- `pnpm check:changed`
  - Delegated to Testbox `tbx_01ky81kpwnmn9y6xdzg7jmf99k`, Actions run `30031143438`.
  - Final wrapper: `exitCode: 0`, `runStatus: succeeded`, command 25m24.264s, total 25m26.417s; the one-shot Testbox stopped successfully.
  - Ran the actual 30-file W4 lanes: ratchets, formatting, API/plugin boundaries, UI i18n, core/core-test/UI typechecks, all core/UI/packages lint shards, macOS CI test shards, native state schema guard, database-first guards, and import cycles.
  - Final import-cycle result: `0 runtime value cycle(s)`.

### Autoreview

- Branch command: `.agents/skills/autoreview/scripts/autoreview --mode branch --base 977db1c83261b13e92e7ad74c5f544e61acf1b90 --stream-engine-output`.
- Accepted and fixed:
  - replaced the exact global profile count with privacy-preserving `hasMultipleSessionSharingIdentities`;
  - cleared stale checked draft state when policy/identity availability disappears;
  - preserved matching keyed-create adoption retries;
  - preserved those exact retries after the drafts policy is disabled while still rejecting every genuinely new disabled draft.
- Rejected after direct verification:
  - native binding drift: `pnpm protocol:check` regenerated all outputs cleanly; `HelloOk.policy` is intentionally an untyped map in Swift/Kotlin, so policy keys do not produce native field diffs;
  - unkeyed policy bypass: `createSessionEntryWithTranscript` owns generated and explicit keys, and the 67-test suite proves unkeyed disabled drafts remain rejected.
- Final branch result: `autoreview clean: no accepted/actionable findings reported`, overall confidence 0.94.

## LOC summary

Implementation diff before adding this report, grouped by role and excluding generated/docs from production:

| Group                  | Added | Deleted |
| ---------------------- | ----: | ------: |
| Production             |   192 |      18 |
| Tests and test support |   562 |       1 |
| Generated Swift        |     4 |       0 |
| Docs                   |     5 |       1 |

The generated total contains only the tracked Swift protocol model. The JSON schema is deliberately excluded because it is ignored and untracked on `origin/main`.

## Commits

- `ce0ac10f6af feat(protocol): support draft session creation`
- `c73b1076dae feat(ui): add draft session workflows`
- `4b3215e3818 docs: explain multi-user drafts`
- `afcb60ba214 test(ui): tighten draft ownership fixture`
- `d415bd43305 test(ui): satisfy draft E2E lint`
- `9403a9fa1f9 test(ui): keep draft fixtures strictly typed`
- `7eb3abb54da test: strengthen draft compatibility coverage`
- `d91a15034c2 fix: harden draft availability policy`
- `4705acfd2e3 test(ui): type draft policy mock control`
- `0e0e96f339d fix: preserve keyed draft creation retries`
- `0c755a401b4 fix: keep disabled draft retries idempotent`

## Skipped or deferred

- No push, pull request, `scripts/pr`, release, publish, `CHANGELOG.md`, or GitHub mutation was performed.
- No SQLite change was needed; therefore there was no schema-version bump or lazy table ensure.
- No new Gateway event was added; existing `sessions.changed` and `session.sharing` paths retain their current scope guards and draft filtering.
- Foreign-language UI bundles were not edited; the requested `en.ts` plus baseline workflow was used.
- `dist/protocol.schema.json` is absent from branch history and `git ls-files`, while final status reports it only as `!! dist/protocol.schema.json` after generation. Swift and both Kotlin targets were verified with `git cat-file -e origin/main:<path>`; no state-generated files changed.
- Final branch status after proof: feature work is committed and the tracked worktree is clean. `origin/main` advanced by six commits after the successful gate; no push or further moving-base chase was performed.
