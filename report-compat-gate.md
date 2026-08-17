# Compat-gate report — PR #123236

## Assignment

- Head inspected: `995c3293b30c7192010f811910b8a688030cb43c`
- Base inspected: `f70d5b8ba588`
- Scope: local-worker launch-descriptor compatibility only.
- Explicitly excluded: sandbox-host semantics.
- Forbidden file left untouched: `src/worker/embedded-agent.runtime.ts`.

## Verified defect

At the base revision, `src/worker/launch-descriptor.ts` parses `toolAuthority` with
`hasExactKeys(value, ["allowedToolNames"])`. A descriptor containing the PR's new
`toolAuthority.exec` member is therefore rejected as having an extra key.

The PR's new-parser optional-key handling protects a new worker from an old descriptor that
omits `exec`. It does not protect an old strict parser from a new descriptor that includes
`exec`.

Gateway-built workers do not expose this mismatch because their exact bundle feature set is
prepared by the Gateway. Local workers are different: provider lifecycle accepts a paired
device with matching `VERSION`, then pins that device's claimed hash and protocol features.
Consequently, an older local worker built under the same release version can retain the old
strict descriptor parser.

## Fix

- Added additive build feature `worker-exec-authority-v1`; no protocol version bump.
- Added that feature to `WORKER_PROTOCOL_FEATURES`, so new Gateway bundles and new local node
  advertisements declare support automatically.
- Generalized the existing execution-context launch fence into the current-worker-launch
  fence. Dispatch, restart recovery, and the final worker-turn launch boundary now require both
  `worker-execution-context-v1` and `worker-exec-authority-v1`.
- A same-version local worker that lacks the new feature is failed and torn down before tunnel
  startup. No descriptor is constructed or handed to its old strict parser.

The production delta for this role's files is net `-5` lines (`+19/-24`); tests are `+58` net
lines (`+66/-8`).

## Proof

Red before the production fix:

```text
node scripts/run-vitest.mjs src/gateway/worker-environments/placement-dispatch-device.test.ts
FAIL: same-version local-worker compatibility promise resolved instead of rejecting
```

Green after the fix:

```text
node scripts/run-vitest.mjs \
  src/gateway/worker-environments/placement-dispatch-device.test.ts \
  src/gateway/worker-environments/placement-dispatch.test.ts \
  src/gateway/worker-environments/worker-turn-launcher.test.ts \
  src/worker/launch-descriptor.test.ts
PASS: 4 files, 103 tests

oxfmt --check <10 role-owned source/test files>
PASS

node scripts/run-oxlint.mjs <10 role-owned source/test files>
PASS

pnpm tsgo:core
PASS

pnpm tsgo:test:src
PASS

git diff --check
PASS
```

Additional attempted proof:

- `src/gateway/server.sessions.worker-original-order.test.ts` reached its local transport helper
  and failed with `ENOENT` because this sandbox image has no `rsync`; no assertion failed.
- `pnpm check:changed -- <role-owned files>` could not delegate because the available Crabbox
  binary failed its own version/help sanity check. The focused local format, lint, type, and test
  fallbacks above passed.

## Handoff

The role-owned changes are committed on branch `fleet/compat-gate`. The commit SHA is reported in
the fleet handoff because a commit cannot contain its own stable SHA.
