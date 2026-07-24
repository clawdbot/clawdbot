# CLI Localization Guide

CLI localization owns human presentation at the command boundary. Preserve
machine-readable output and operational values exactly.

## Updater dry-run ownership

- Author reviewed English in `i18n/locales/en.ts` and keep the hand-owned
  bootstrap targets aligned until a later updater-owner slice adopts generated
  output.
- Resolve one immutable localization context at the updater dry-run
  presentation boundary and reuse it for that render. Do not read process
  locale in individual message helpers.
- Localize labels and surrounding prose only. Keep package channels, versions,
  paths, commands, flags, action IDs, reason codes, and raw errors literal.
- Preserve `--json` payloads exactly across locales. Do not reuse localized
  display labels as structured values.
- Keep reviewed English as the deterministic unsupported-locale and failure
  fallback.

## Adoption and verification

- Register every CLI catalog source in `localization/surfaces.json` and update
  `docs/reference/localization.md` when another command family is adopted.
- Extend the shared `localization/catalogs.json` gate and refresh workflow when
  moving a family to generated catalogs; do not create a CLI-specific pipeline.
- Run `node scripts/run-vitest.mjs src/cli/i18n/runtime.test.ts
src/cli/update-cli.test.ts` for updater localization changes.
- Test reviewed English, a supported non-English locale, unsupported-locale
  fallback, literal preservation, and exact structured-output equality.
