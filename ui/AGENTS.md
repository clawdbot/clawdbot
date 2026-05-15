# Control UI Guide

This directory owns Control UI-specific guidance that should not live in the repo root.

## i18n Rules

- Foreign-language locale bundles in `ui/src/i18n/locales/*.ts` are generated output.
- Do not hand-edit non-English locale bundles or `ui/src/i18n/.i18n/*` unless a targeted generated-output fix is explicitly requested.
- The source of truth is `ui/src/i18n/locales/en.ts` plus the generator/runtime wiring in:
  - `scripts/control-ui-i18n.ts`
  - `ui/src/i18n/lib/types.ts`
  - `ui/src/i18n/lib/registry.ts`
- Pipeline: update English strings and locale wiring here, then run `pnpm ui:i18n:sync` and commit the regenerated locale bundles plus `.i18n` metadata.
- Prioritization report: `pnpm ui:i18n:report [--surface <name>] [--locale <locale>] [--top <n>]` shows current hardcoded-copy focus areas and locale fallback metadata. It is not a drift gate; use `pnpm ui:i18n:check` for that.
- If locale outputs drift, regenerate them. Do not manually translate or hand-maintain generated locale files by default.

## Scope

- Keep UI-specific rules here.
- Leave repo-global architecture, verification, and git workflow rules in the root `AGENTS.md`.
