# Plugin SDK Boundary

This directory is the public contract between plugins and core. Changes here
can affect bundled plugins and third-party plugins.

## Source Of Truth

- Docs:
  - `docs/plugins/sdk-overview.md`
  - `docs/plugins/sdk-entrypoints.md`
  - `docs/plugins/sdk-runtime.md`
  - `docs/plugins/sdk-migration.md`
  - `docs/plugins/architecture.md`
- Definition files:
  - `package.json`
  - `scripts/lib/plugin-sdk-entrypoints.json`
  - `src/plugin-sdk/entrypoints.ts`
  - `src/plugin-sdk/api-baseline.ts`
  - `src/plugin-sdk/plugin-entry.ts`
  - `src/plugin-sdk/core.ts`
  - `src/plugin-sdk/provider-entry.ts`

## Boundary Rules

- Host loads plugins; plugins should not reach through the SDK into arbitrary
  host internals.
- Prefer a small versioned host/kernel seam plus narrow documented SDK
  entrypoints over broad convenience barrels.
- Prefer narrow, purpose-built subpaths over broad convenience re-exports.
- Do not expose implementation convenience from `src/channels/**`,
  `src/agents/**`, `src/plugins/**`, or other internals unless you are
  intentionally promoting a supported public contract.
- Keep public SDK entrypoints cheap at module load. If a helper is only needed
  on async paths such as send, monitor, probe, directory-live, login, or setup,
  prefer a narrow `*.runtime` subpath over re-exporting it through a broad SDK
  barrel that hot channel entrypoints import on startup.
- Keep SDK facades acyclic. Do not add back-edge re-exports that route a
  lightweight contract file back through heavier policy or runtime modules.
- Do not mix static and dynamic imports for the same runtime surface when
  shaping SDK seams. If a surface must stay lazy, keep the eager side on a
  light contract file and the deferred side on a dedicated runtime subpath.
- Prefer `api.runtime` or a focused SDK facade over telling extensions to reach
  into host internals directly.
- When core or tests need bundled plugin helpers, prefer the plugin package
  `api.ts` or `runtime-api.ts` plus generic SDK capabilities. Do not add a
  provider-named `src/plugin-sdk/<id>.ts` seam just to make core aware of a
  bundled channel's private helpers.
- Resolver/facade loader tests are the exception to broad source API coverage:
  use generated tiny plugin fixtures for `api.js` / `runtime-api.js` fallback
  behavior. Do not point those tests at real bundled plugin source APIs.
- For provider work, prefer family-level seams over provider-specific seams.
  Shared helpers should describe a reusable behavior such as replay policy,
  tool-schema compat, payload normalization, stream-wrapper composition, or
  transport decoration. Avoid adding a new SDK export that only wraps one
  provider's local implementation unless there is already a second consumer.
- Prefer named helpers over raw options objects when the options encode a
  stable contract. Example: export a helper for "OpenAI-style Anthropic tool
  payload compat" instead of making every plugin pass the same mode flags.
- Keep transport/runtime policy and plugin-facing helpers aligned. If the same
  behavior is used in plugin registration and in core runtime paths, expose one
  shared helper instead of letting the two paths drift.
- SDK subpaths should help callers resolve one capability or runtime need at a
  time. Do not grow new surfaces that require broad runtime registry access as
  the default path.
- If a proposed SDK export mainly exists to let setup/config/control-plane code
  execute plugin runtime, that is usually a boundary smell. Prefer metadata or
  descriptor-driven control-plane seams first.

## Verification

- If you touch SDK seams that affect lazy loading, hot channel entrypoints, or
  bundled plugin import topology, run `pnpm build`.
- If the change can alter bundled channel startup cost, also run the isolated
  entrypoint profiler for the affected plugin:
  `OPENCLAW_LOCAL_CHECK=0 node scripts/profile-extension-memory.mjs --extension <id> --skip-combined --concurrency 1`

## Expanding The Boundary

- SDK surface is too large. Do not add compat barrels, aliases, or fallback exports for convenience. Replace old entrypoints when cleaner.
- Public third-party API is the only compat exception: document/version breaks, migrate ALL bundled/internal plugins first, then aggressively deprecate unused exports.
- When adding or changing a public subpath, keep these aligned:
  - docs in `docs/plugins/*`
  - `scripts/lib/plugin-sdk-entrypoints.json`
  - `src/plugin-sdk/entrypoints.ts`
  - `package.json` exports
  - API baseline and export checks
- If a bundled channel/helper need crosses package boundaries, first ask
  whether the need is truly generic. If yes, add a narrow generic subpath. If
  not, keep it plugin-local through `api.ts` / `runtime-api.ts`.
- When expanding provider-facing seams, update or add the matching narrow tests
  that lock the contract: Plugin SDK baseline/export checks for public subpaths
  and the most direct provider/plugin tests for the behavior you are
  centralizing.
- Breaking removals or renames are major-version work, not drive-by cleanup.
