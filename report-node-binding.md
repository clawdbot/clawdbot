# Node-binding remediation report

## Outcome

Completed the `node-binding` fleet assignment for PR #123236 from head
`995c3293b30c7192010f811910b8a688030cb43c` (base
`f70d5b8ba5881346e7d9f76ea2c8c5cc5ae59ca6`) on local branch
`fleet/node-binding`.

The Gateway-resolved exec node binding now crosses the worker launch boundary as
part of `WorkerToolAuthority.exec`. The worker's existing `execAuthority` spread
therefore supplies `ExecToolDefaults.node`, and the existing node-target resolver
rejects a request that resolves to a different device.

## Root cause and repair

- `resolveExecDefaults` already returned the effective `node` binding, but
  `resolveWorkerToolAuthority` dropped it while projecting only `host`, `security`,
  and `ask`.
- `WorkerToolAuthority.exec` is now a discriminated shape: non-node hosts cannot
  carry a node field, while `host: "node"` can carry the trimmed binding.
- `parseWorkerLaunchDescriptor` accepts and preserves a non-empty, already-trimmed
  node selector only for `host: "node"`; non-node hosts, empty selectors,
  whitespace-altered selectors, and unknown fields remain rejected.
- No runtime reconstruction path was added. `worker.runtime.ts` already forwards
  the descriptor authority, and `embedded-agent.runtime.ts` already spreads it
  into exec defaults.

## Regression proof

The new test resolves a worker authority bound to `bound-node`, then submits a
request naming `other-node` to the production node-target resolver.

Before the production change:

```text
AssertionError: promise resolved ... nodeId: "other-node" instead of rejecting
Tests: 1 failed, 14 passed
```

After the production change, the same test rejects with:

```text
exec node not allowed (bound to bound-node, requested resolved to other-node)
```

Descriptor coverage also round-trips the node binding across every reachable
node-host `security × ask` combination and rejects the field on non-node hosts.

## Verification

- `pnpm dlx node@24.15.0 scripts/run-vitest.mjs src/gateway/worker-environments/worker-tool-authority.test.ts src/worker/launch-descriptor.test.ts src/worker/worker.runtime.test.ts`
  - 69 passed across two Vitest shards.
- `pnpm dlx node@24.15.0 node_modules/.bin/tsgo -p test/tsconfig/tsconfig.test.src.json --pretty false`
  - passed.
- `node_modules/.bin/oxfmt --check` on the five touched source/test files
  - passed.
- `node_modules/.bin/oxlint` on the five touched source/test files
  - passed.
- `git diff --check` on the role-owned diff
  - passed.

The host's default Node 22.14.0 is below the repository minimum, so verification
used a temporary pinned Node 24.15.0 runtime. The core `tsgo` lane reached only
unrelated pre-existing `TS4053`/`TS4058` `AbortSignal` portability errors and two
unrelated `TS2883` `Response` portability errors; it reported no touched-file
error. The test-source `tsgo` lane passed cleanly.

## Scope and review

- Production delta for this role: `+34/-12` (net `+22`), required to add the
  node-binding security invariant and strict external-boundary validation.
- Test delta for this role: `+62/-2` (net `+60`).
- The unavailable `$test-audit` and `$autoreview` skills were replaced with the
  required fail-before/pass-after regression capture and a fresh manual diff
  review.
- `src/worker/embedded-agent.runtime.ts:171-175` was not changed. The sandbox-host
  semantics decision remains explicitly out of scope.
- Concurrent compatibility-gate edits elsewhere in the shared checkout were
  preserved and excluded from this role's commit.
