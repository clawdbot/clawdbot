# Docs Guide

This directory owns docs authoring, Mintlify link rules, and docs i18n policy.

## Mintlify Rules

- Docs are hosted on Mintlify (`https://docs.openclaw.ai`).
- Internal doc links in `docs/**/*.md` must stay root-relative with no `.md` or `.mdx` suffix (example: `[Config](/gateway/configuration)`).
- Section cross-references should use anchors on root-relative paths (example: `[Hooks](/gateway/configuration-reference#hooks)`).
- Doc headings should avoid em dashes and apostrophes because Mintlify anchor generation is brittle there.
- README and other GitHub-rendered docs should keep absolute docs URLs so links work outside Mintlify.
- Docs content must stay generic: no personal device names, hostnames, or local paths; use placeholders like `user@gateway-host`.

## Docs Content Rules

- For docs, UI copy, and picker lists, order services/providers alphabetically unless the section is explicitly describing runtime order or auto-detection order.
- Keep bundled plugin naming consistent with the repo-wide plugin terminology rules in the root `AGENTS.md`.

## Docs i18n

- Foreign-language docs are not maintained in this repo. The generated publish output lives in the separate `openclaw/docs` repo (often cloned locally as `../openclaw-docs`).
- Do not add or edit localized docs under `docs/<locale>/**` here.
- Treat English docs in this repo plus glossary files as the source of truth.
- Pipeline: update English docs here, update `docs/.i18n/glossary.<locale>.json` as needed, then let the publish-repo sync and `scripts/docs-i18n` run in `openclaw/docs`.
- Before rerunning `scripts/docs-i18n`, add glossary entries for any new technical terms, page titles, or short nav labels that must stay in English or use a fixed translation.
- `pnpm docs:check-i18n-glossary` is the guard for changed English doc titles and short internal doc labels.
- Translation memory lives in generated `docs/.i18n/*.tm.jsonl` files in the publish repo.
- See `docs/.i18n/README.md`.
