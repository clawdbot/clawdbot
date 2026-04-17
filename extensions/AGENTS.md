# Extensions Boundary

This directory contains bundled plugins. Treat it as the same boundary that
third-party plugins see.

## Public Contracts

- Docs:
  - `docs/plugins/building-plugins.md`
  - `docs/plugins/architecture.md`
  - `docs/plugins/sdk-overview.md`
  - `docs/plugins/sdk-entrypoints.md`
  - `docs/plugins/sdk-runtime.md`
  - `docs/plugins/sdk-channel-plugins.md`
  - `docs/plugins/sdk-provider-plugins.md`
  - `docs/plugins/manifest.md`
- Definition files:
  - `src/plugin-sdk/plugin-entry.ts`
  - `src/plugin-sdk/core.ts`
  - `src/plugin-sdk/provider-entry.ts`
  - `src/plugin-sdk/channel-contract.ts`
  - `scripts/lib/plugin-sdk-entrypoints.json`
  - `package.json`

## Boundary Rules

- Extension production code should import from `openclaw/plugin-sdk/*` and its
  own local barrels such as `./api.ts` and `./runtime-api.ts`.
- Do not import core internals from `src/**`, `src/channels/**`,
  `src/plugin-sdk-internal/**`, or another extension's `src/**`.
- Do not use relative imports that escape the current extension package root.
- Keep plugin metadata accurate in `openclaw.plugin.json` and the package
  `openclaw` block so discovery and setup work without executing plugin code.
- Treat files like `src/**`, `onboard.ts`, and other local helpers as private
  unless you intentionally promote them through `api.ts` and, if needed, a
  matching `src/plugin-sdk/<id>.ts` facade.
- If core or core tests need a bundled plugin helper, export it from `api.ts`
  first instead of letting them deep-import extension internals.
- For provider plugins, keep auth, onboarding, catalog selection, and
  vendor-only product behavior local to the plugin. Do not move those into
  core just because two providers look similar.
- Before adding a new provider-local `wrapStreamFn`, `buildReplayPolicy`,
  `normalizeToolSchemas`, `inspectToolSchemas`, or compat patch helper, check
  whether the same behavior already exists through `openclaw/plugin-sdk/*`.
  Reuse shared family helpers first.
- If two bundled providers share the same replay policy shape, tool-schema
  compat rewrite, payload patch, or stream-wrapper chain, stop copying the
  logic. Extract one shared helper and migrate both call sites in the same
  change.
- Prefer named provider-family helpers over repeating raw option bags. If a
  provider needs OpenAI-style Anthropic tool payload compat, Gemini schema
  cleanup, or an XAI compat patch, use a named shared helper instead of
  inlining the policy knobs again.
- Keep control-plane metadata separate from runtime logic. Discovery, config
  validation, setup hints, onboarding hints, and activation planning should be
  expressible from manifest/descriptors whenever possible.
- If setup truly requires runtime execution, make that explicit in the plugin's
  declared setup/runtime surface instead of letting metadata flows import
  runtime code accidentally.
- Do not rely on eager global registry seeding or import-time side effects to
  make a plugin “available”. Plugin availability should come from manifest
  ownership plus targeted activation.
- When core needs plugin-owned static data on a hot path, expose a lightweight
  top-level artifact such as `gateway-auth-api.ts`, `message-tool-api.ts`, or a
  similarly narrow `*-api.ts`. Reuse the same local helper from the artifact and
  the full plugin so fast paths do not drift from runtime behavior.

## Expanding The Boundary

- If an extension needs a new seam, add a typed Plugin SDK subpath or additive
  export instead of reaching into core.
- Keep new plugin-facing seams backwards-compatible and versioned. Third-party
  plugins consume this surface.
- When intentionally expanding the contract, update the docs, exported subpath
  list, package exports, and API/contract checks in the same change.
