# Worker result: Codex setup-probe startup retry

## Root cause: (c), not (a) or (b)

The setup probe already reaches the canonical guarded startup loop. The initial
diagnosis looked in the console gateway log, but its retry warnings were written
to the structured gateway log instead. The recorded failed activation contains:

- 08:23:07.663 UTC: attempt 1 failed; restarting for attempt 2.
- 08:23:13.547 UTC: attempt 2 failed; restarting for attempt 3.
- 08:23:19.184 UTC: attempt 3 failed; retries exhausted.

The warnings appear on lines 30-32 of the structured gateway log identified by
the console gateway log. Their 5.884-second and 5.637-second separation matches
Codex's five-second SQLite busy timeout plus process overhead: every immediate
restart raced the same temporary SQLite contention window.

The setup activation call chain is:

1. `src/system-agent/setup-inference-activate.ts:430` starts the read-only setup
   inference verification.
2. `src/system-agent/setup-inference-persist.ts:565` runs the embedded agent with
   `preparedModelRuntimeMode: "isolated-read-only"` and the Codex harness
   override.
3. `src/agents/embedded-agent-runner/run-orchestrator.ts:298` acquires the
   prepared read-only runtime.
4. `extensions/codex/harness.ts:262` dispatches the regular Codex app-server
   attempt.
5. `extensions/codex/src/app-server/run-attempt.ts:23` starts that attempt.
6. `extensions/codex/src/app-server/run-attempt-start.ts:92` calls the canonical
   startup owner.
7. `extensions/codex/src/app-server/attempt-startup.ts:629` runs the existing
   bounded three-attempt startup loop.
8. `extensions/codex/src/app-server/shared-client.ts:1191` spawns and initializes
   the subprocess; initialization failure closes the client and rethrows.
9. `extensions/codex/src/app-server/client.ts:164` correctly classifies the
   resulting indeterminate transport error as a retryable closed connection.

Direct inspection of the sibling upstream Codex checkout at tag `rust-v0.149.1`
confirmed the dependency contract:

- `codex-rs/app-server/src/lib.rs:613` propagates SQLite initialization failure
  as a fatal app-server startup error.
- `codex-rs/app-server/src/lib.rs:1229` invokes
  `rollout_state_db::try_init(config)`.
- `codex-rs/rollout/src/state_db.rs:45` shows that the CLI-facing initializer
  instead warns and continues.
- `codex-rs/rollout/src/state_db.rs:60` and
  `codex-rs/rollout/src/state_db.rs:101` show the fallible app-server path
  calling `StateRuntime::init`.
- `codex-rs/state/src/sqlite.rs:285` sets
  `busy_timeout(Duration::from_secs(5))`.

## Fix and diff

`extensions/codex/src/app-server/attempt-startup.ts:629` retains the canonical
three-attempt owner and existing closed-transport classifier, but now waits one
second before retry 2 and two seconds before retry 3. The wait uses the existing
startup abandonment signal, remains inside the existing startup timeout, and is
zero for executable-selection changes. Unsupported versions, authentication
failures, and other non-closed-transport errors still fail immediately.

The bounded retry is justified because live evidence proves the SQLite failure
is transient, while the upstream app-server contract nevertheless exits the
process after its five-second busy timeout. It does not conceal a persistent
failure, alter upstream state, add retries beyond the existing limit, or create a
second startup path.

The production diff is exactly net-neutral: `git diff --numstat` reports
`13 additions / 13 deletions` for
`extensions/codex/src/app-server/attempt-startup.ts`. Shortening the existing
retry-limit constant also keeps the file under its already-full 700-line lint
ceiling.

`extensions/codex/src/app-server/attempt-startup-retry.test.ts` adds four real
stdio child-process regressions using isolated temporary fixture directories:

- A first-spawn SQLite startup exit recovers on attempt 2.
- A contention window that defeats immediate retries recovers after backoff;
  this regression fails against the pre-fix production code.
- Persistent SQLite startup exits stop after exactly three attempts.
- An unsupported app-server version fails after exactly one attempt.

`extensions/codex/src/app-server/attempt-startup.test.ts:670` also stabilizes a
neighboring pre-existing shared-client timeout race by explicitly waiting for the
peer acquisition and driving its timeout with fake timers.

## Verification

Pre-fix red proof:

```text
node scripts/run-vitest.mjs extensions/codex/src/app-server/attempt-startup.test.ts --testNamePattern 'waits out transient sqlite contention'
FAIL: initialize transport failed after request write: codex app-server exited:
code=1 ... failed to initialize sqlite state runtime
```

Post-fix focused coverage:

```text
node scripts/run-vitest.mjs \
  extensions/codex/src/app-server/attempt-startup-retry.test.ts \
  extensions/codex/src/app-server/attempt-startup.test.ts \
  extensions/codex/src/app-server/attempt-timeouts.test.ts \
  extensions/codex/src/app-server/client.test.ts

Test Files  4 passed (4)
     Tests  79 passed (79)
```

The full changed-file check also completed successfully, including repository
ratchets, doctor guard tests, full dead-code scans, extension and extension-test
typechecks, typed lint, database-first policy, runtime-sidecar loaders, and
runtime import cycles:

```text
env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 \
  OPENCLAW_WORKTREE_DEPENDENCY_ROOT=<current worktree> \
  OPENCLAW_WORKTREE_INSTALLED_ROOT=<canonical checkout> \
  NODE_OPTIONS=--require=/private/tmp/openclaw-codex-worktree-dependency-preload.cjs \
  node scripts/check-changed.mjs

runtime-sidecar-loaders: local runtime sidecar loaders look OK.
Import cycle check: 0 runtime value cycle(s).
exit code: 0
```

The local execution override avoids this environment's automatic remote
delegation. The temporary preload redirects exactly one absent linked-worktree
`node_modules/playwright-core` realpath to the already-installed canonical
checkout dependency. Without that narrowly scoped resolution, the unrelated
runtime-sidecar guard fails with `ENOENT` because this linked worktree does not
have its own dependency installation. No guard was skipped, no dependency was
installed, and `node_modules` was not edited.

## Open questions

The upstream asymmetry between warning-only CLI startup and fatal app-server
startup remains an upstream Codex concern. Live contention can still outlast the
existing bounded three-attempt budget; the OpenClaw fix deliberately improves the
proven transient case without promising recovery from indefinitely held locks.
No live operator home or live gateway was modified, and no commit was created.
