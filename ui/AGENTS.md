# Control UI Guide

This directory owns Control UI-specific guidance that should not live in the repo root.

## i18n Rules

- Foreign-language files in `ui/src/i18n/locales/*.ts` are stable, source-owned lazy-module adapters; their translations are generated from canonical grouped memory in `ui/src/i18n/.i18n/*.tm.jsonl`.
- Do not hand-edit translation memory, locale metadata, or fallback metadata unless a targeted generated-output fix is explicitly requested.
- The source of truth is `ui/src/i18n/locales/en.ts` and `en-agents.ts` plus the generator/runtime wiring in:
  - `scripts/control-ui-i18n.ts`
  - `scripts/lib/control-ui-i18n-catalog.ts`
  - `scripts/lib/control-ui-i18n-sync-plan.ts`
  - `ui/config/control-ui-locales.ts`
  - `ui/src/i18n/lib/types.ts`
  - `ui/src/i18n/lib/registry.ts`
- Contributor flow: update English strings and locale adapters/wiring, run keyless `pnpm ui:i18n:baseline`, and commit source files plus any changed raw-copy baseline. Do not include catalog fallback metadata, locale metadata, or translation memory in a source PR; CI rejects mixed source/generated diffs outside canonical `release/YYYY.M.PATCH` branches or an explicitly detected complete canonical-memory ownership migration.
- `pnpm ui:i18n:verify` is deterministic and keyless. `pnpm lint` and the changed-check UI lane run it. It validates English catalog shape, runtime locale wiring, and raw-copy baseline drift; foreign catalog parity belongs to the post-merge bot and strict generated-output gate.
- Translation flow: the serialized `control-ui-locale-refresh` workflow translates after merge, opens an isolated generated PR, and enables auto-merge for its exact head. `pnpm ui:i18n:sync` remains the authenticated maintainer/release repair path; do not run it without provider auth when new keys exist.
- `pnpm release:prep` runs the locale sync before release freeze, then `pnpm ui:i18n:check` remains the strict generated-output/release gate with zero fallbacks.
- Prioritization report: `pnpm ui:i18n:report [--surface <name>] [--locale <locale>] [--top <n>]` shows current hardcoded-copy focus areas and locale fallback metadata. It is not a drift gate; use `pnpm ui:i18n:check` for that.
- If locale outputs drift, let the workflow reconcile them or run release prep. Do not manually translate, merge, or hand-maintain generated translation memory or locale metadata.

## CSS / Template Linting

- `pnpm lint:ui:styles` runs stylelint over `ui/src` stylesheets and Lit `css` templates (postcss-lit). `pnpm lint` includes it; error-class rules only, oxfmt owns formatting. Config: `config/stylelint.config.mjs`.
- Icons: shared 24x24 Lucide icons go through `strokeIcon()` in `ui/src/components/icons-tools.ts` so stroke presentation attributes stay inline and render inside shadow roots. Icon bodies are `svg\`\``fragments, never`html\`\`` (wrong namespace renders nothing).
- `pnpm lint:ui:lit` is an opt-in lit-analyzer diagnostic for template bindings (slow, ~9 min; known baseline of pre-existing findings). It is not a CI gate.

## Stylesheet Policy

- Cursors: links and controls that open a new tab use the pointer; state-changing controls keep the default arrow.
- Colors: stylesheet colors flow through custom-property tokens defined in `ui/src/styles/base.css`; `color-no-hex` enforces this. Exempt surfaces (token definitions, `lobster-pet.css` sprite artwork, `--theme-chip-*` preview swatches) each carry a stated contract. Lit `css\`\`` templates are not yet gated — prefer tokens there too.
- Breakpoints: `max-width` media conditions use the canonical ladder 400/560/640/768/900/1100/1320px (plus the 932×500 landscape-phone compound); stylelint's allowed-list enforces it. New thresholds round up to the next rung. Don't add rungs without updating the config comment and this note.
- Duplicate selectors are lint errors; deliberate topic-section reopens use `stylelint-disable-next-line no-duplicate-selectors -- <reason>`.
- Dead CSS: `node --import tsx scripts/audit-control-ui-dead-css.mts` reports class selectors with no production reference (AST-based, understands `X--${...}` stems and `classMap`). Advisory, not a gate — verify by hand before deleting; extend the script's stem detection rather than its allowlist when it misses a dynamic family.
- Native CSS nesting: opportunistic only — nest when already rewriting a section; no conversion sweeps.
- `@layer` is deliberately not used: the shared light-DOM stylesheet's precedence relies on import order plus specificity, page CSS imports lazily per component, and measured `no-descending-specificity` hits are within-file — layering the import manifest would flip unlayered-vs-layered precedence across ~48 lazily imported page files for no measured win. Revisit only with computed-style parity proof across all routes on the mocked dev server (PR #123156/#123160 show the evidence pattern).

## Gateway Coupling

- The Control UI ships from and with its Gateway: one install, one version (product decision, 2026-08-16). UI code never carries gateway-version compatibility — no fallbacks to older methods when a current core method is missing, no version-conditional behavior for older gateways.
- Method-advertisement checks (`isGatewayMethodAdvertised`) remain only as feature gates for config/plugin-dependent surfaces, never as version compat.
- The handshake rejects gateway-served same-origin skew. The admission-exempt paths (`pnpm ui:dev`, custom `gateway.controlUi.root`, cross-origin/connection-settings dialing) are unsupported for version mismatch without enforcement: they carry no compat code and fail visibly at the first missing method, by design. Tightening admission to reject them at connect is a server-side product change owned separately.

## Build Chunking

- `ui/config/control-ui-boot-modules.json` is a generated manifest of the modules the default boot flow loads lazily; the `control-ui-boot` group in `ui/config/control-ui-chunking.ts` merges them into a few chunks so boot avoids ~140 HTTP/1.1 requests. Regenerate with `pnpm ui:boot-manifest:gen` when boot-path surfaces change materially; it builds into a temporary directory with only the old boot group disabled, preventing stale entries from feeding back into the capture. Rebuild with `pnpm ui:build` afterward to verify normal grouped output. Do not hand-edit the manifest.

## Live Verification

- The Gateway serves the prebuilt bundle from `dist/control-ui`; editing `ui/src` changes nothing live until `pnpm ui:build`. Confirm the served `/assets/index-*.js` hash changed before trusting a live result.

## Scope

- Keep UI-specific rules here.
- Leave repo-global architecture, verification, and git workflow rules in the root `AGENTS.md`.
