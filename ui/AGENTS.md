# Control UI Guide

This directory owns Control UI-specific guidance that should not live in the repo root.

## i18n Rules

- Foreign-language locale bundles in `ui/src/i18n/locales/*.ts` are generated output.
- Do not hand-edit non-English locale bundles or `ui/src/i18n/.i18n/*` unless a targeted generated-output fix is explicitly requested.
- The source of truth is `ui/src/i18n/locales/en.ts` plus the generator/runtime wiring in:
  - `scripts/control-ui-i18n.ts`
  - `ui/src/i18n/lib/types.ts`
  - `ui/src/i18n/lib/registry.ts`
- Contributor flow: update English strings and locale wiring, run keyless `pnpm ui:i18n:baseline`, and commit source files plus any changed raw-copy baseline. Do not include foreign bundles, catalog fallback metadata, locale metadata, or translation memory in a source PR; CI rejects mixed source/generated diffs outside canonical `release/YYYY.M.PATCH` branches.
- `pnpm ui:i18n:verify` is deterministic and keyless. `pnpm lint` and the changed-check UI lane run it. It validates English catalog shape, runtime locale wiring, and raw-copy baseline drift; foreign catalog parity belongs to the post-merge bot and strict generated-output gate.
- Translation flow: the serialized `control-ui-locale-refresh` workflow translates after merge, opens an isolated generated PR, and enables auto-merge for its exact head. `pnpm ui:i18n:sync` remains the authenticated maintainer/release repair path; do not run it without provider auth when new keys exist.
- `pnpm release:prep` runs the locale sync before release freeze, then `pnpm ui:i18n:check` remains the strict generated-output/release gate with zero fallbacks.
- Prioritization report: `pnpm ui:i18n:report [--surface <name>] [--locale <locale>] [--top <n>]` shows current hardcoded-copy focus areas and locale fallback metadata. It is not a drift gate; use `pnpm ui:i18n:check` for that.
- If locale outputs drift, let the workflow reconcile them or run release prep. Do not manually translate, merge, or hand-maintain generated locale files.

## Scope

- Keep UI-specific rules here.
- Leave repo-global architecture, verification, and git workflow rules in the root `AGENTS.md`.
