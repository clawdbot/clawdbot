# Channels Boundary

`src/channels/**` is core channel implementation. Plugin authors should not
import from this tree directly.

## Public Contracts

- Docs:
  - `docs/plugins/sdk-channel-plugins.md`
  - `docs/plugins/architecture.md`
  - `docs/plugins/sdk-overview.md`
- Definition files:
  - `src/channels/plugins/types.plugin.ts`
  - `src/channels/plugins/types.core.ts`
  - `src/channels/plugins/types.adapters.ts`
  - `src/plugin-sdk/core.ts`
  - `src/plugin-sdk/channel-contract.ts`

## Boundary Rules

- Keep extension-facing channel surfaces flowing through `openclaw/plugin-sdk/*`
  instead of direct imports from `src/channels/**`.
- When a bundled or third-party channel needs a new seam, add a typed SDK
  contract or facade first.
- Treat channel entrypoints such as `channel.ts`, `shared.ts`,
  `channel.setup.ts`, `gateway.ts`, and `outbound.ts` as hot import paths. Do
  not statically pull async-only surfaces like send, monitor, probe,
  directory-live, setup/login flows, or large `runtime-api.ts` barrels into
  those files unless startup truly needs them.
- Prefer a small local seam such as `channel-api.ts`, `*.runtime.ts`, or
  `*.runtime-api.ts` to keep heavy runtime code off the hot path.
- For core discovery paths used by Gateway or agent tools, prefer lightweight
  bundled-plugin artifacts first and full channel plugin loading only as a
  fallback.
- Do not mix static and dynamic imports for the same heavy module family across
  a channel boundary change. If the path should stay lazy, keep it lazy end to
  end.
- Remember that shared channel changes affect both built-in and extension
  channels. Check routing, pairing, allowlists, command gating, onboarding, and
  reply behavior across the full set.

## Verification

- If you touch hot channel entrypoints or lazy-loading seams, run `pnpm build`.
- For bundled plugin channel changes that can affect startup/import cost, run:
  `OPENCLAW_LOCAL_CHECK=0 node scripts/profile-extension-memory.mjs --extension <id> --skip-combined --concurrency 1`
