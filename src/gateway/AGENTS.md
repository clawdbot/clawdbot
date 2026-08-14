# Gateway Hot Paths

Gateway server tests and startup paths should not materialize bundled plugin
runtime when they only need plugin-owned static descriptors.

## Guardrails

- For plugin-owned Gateway behavior such as auth-bypass paths, prefer a
  lightweight public artifact resolver before falling back to the full channel
  plugin.
- Keep the full plugin contract and the lightweight artifact backed by the same
  plugin-owned helper so behavior does not diverge.
- Do not load broad bundled channel registries from Gateway HTTP/server code
  just to answer static questions.
- If adding a new plugin-owned Gateway descriptor, add the core resolver,
  plugin artifact, and mirrored full-plugin export in the same change.
- In Gateway server tests, reuse suite-level servers, authenticated contexts,
  and clients when the behavior under test does not require a fresh
  connect/auth handshake. Reset runtime state explicitly instead of restarting
  the whole server per case.
- Keep schedulers, pollers, and background loops disabled in manual-RPC tests
  unless the test is specifically proving automatic scheduling or lifecycle
  behavior.

## Run Authority And Worker Upgrades

- `src/infra/agent-run-registry.ts` owns run liveness. `src/gateway/worker-environments/placement-turn-claims.ts` owns worker-turn liveness. Validate both at use time; HMAC verification, TTL, and matching identifiers do not establish live authority.
- Sessionless runs retain prepared admission authority without inventing session projection. Canonical idempotency reservation owns deduplication; abort-map binding occurs only for registered projected runs.
- Worker launch, recovery, reclaim, and RPC use require an exact live placement, environment, owner epoch, placement generation, and turn claim.
- The current worker execution-context dialect is an upgrade boundary. Reject incompatible workers and reprovision them; do not emit legacy payloads, locally downgrade execution, or revive pre-restart claims.

## Approval Identity Persistence

- The approval store may lazily create its additive execution-identity companion table only when writing a valid bound identity.
- Identity rows record provenance only. Authorization and decision consumption must use the parent approval and current live authority, never the companion row.
- Preserve schema version and older-reader tolerance. Changes to this surface require enabled, disabled, integrity, downgrade, and candidate-reopen proof.

## Verification

- Benchmark the affected Gateway test file before/after with
  `pnpm test <file>`.
- Run `pnpm build` when changing Gateway lazy-loading or bundled plugin
  artifacts.
