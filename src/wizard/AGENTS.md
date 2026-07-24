# Wizard Localization Guide

The wizard owns reviewed setup and onboarding presentation. Keep locale
selection, catalogs, and final rendering at this boundary; do not move
localization into configuration, protocol, or provider logic.

## Catalog ownership

- Author reviewed English in `i18n/catalogs/en.json` for adopted families.
- Treat `i18n/catalogs/generated/` as workflow-owned output. Do not hand-edit
  generated locale files.
- The existing wizard catalog source is already registered. Add registry rows
  only when adopting a new source path, and change the shared gate or
  Localization Catalog Refresh workflow only when its coverage must expand.
  Do not create a wizard-specific gate or translation service.

## Rendering contract

- Resolve one immutable localization context at the wizard entry boundary and
  pass it through the operation.
- Keep commands, flags, config keys, paths, IDs, provider/model names, user
  input, and upstream diagnostics literal.
- Preserve structured values and behavior across locales. Localization changes
  presentation only.
- Keep reviewed English available as the deterministic fallback.

## Verification

- Run `pnpm localization:catalogs:detect` for source changes.
- Run `pnpm localization:catalogs:check` for generated or release validation.
- Run focused wizard localization tests through `scripts/run-vitest.mjs`.
- Update `docs/reference/localization.md` and both localization registries when
  the wizard adopts a new catalog source or workflow obligation. Routine keys
  within the existing source do not add duplicate registry rows.
