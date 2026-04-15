# Plugin SDK Compat Notes

This fork carries a bounded compat layer under `src/plugin-sdk/` for legacy
`openclaw/plugin-sdk/*` subpaths that older bundled or local plugins still
import.

Current compat families include:

- approval runtime helpers
- browser/security/runtime helpers
- provider web/auth/http shims
- device/bootstrap and thread-binding facades
- memory-core host facades

When adding a new compat surface:

1. Keep it thin. Prefer re-exports over new business logic.
2. If a real shim is needed, scope it to the exact legacy behavior the current
   plugins use.
3. Add the subpath to `scripts/lib/plugin-sdk-entrypoints.json`.
4. Run `node scripts/sync-plugin-sdk-exports.mjs`.
5. Re-run `pnpm build:docker` and use the next failure frontier as the source
   of truth.

The goal is not to recreate every historical SDK surface. The goal is to make
the subpaths actually used by this fork resolve cleanly and behave sensibly.
