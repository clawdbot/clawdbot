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
- Generated docs, never hand-edit: `docs/plugins/reference/**`, `docs/plugins/reference.md`, and `docs/plugins/plugin-inventory.md` come from `pnpm plugins:inventory:gen`; `docs/maturity/**` from `pnpm maturity:render`.
- Public and packaged maturity pages and the docs map are generated during publishing and packaging. Keep only their small source stubs; never commit expanded generated docs.

## Internal Docs

- Long-lived private operator docs belong in `~/Projects/manager/docs/`.
- Repo-local internal scratch/mirror docs may live under ignored `docs/internal/`.
- Never add `docs/internal/**` pages to `docs/docs.json` navigation or link them from public docs.
- `scripts/docs-sync-publish.mjs` excludes and prunes `docs/internal/**` from the public `openclaw/docs` publish repo if a page is force-added later.
- Internal docs may mention repo paths, private app names, 1Password item names, and runbooks, but never include secret values.

## Maturity Scorecard Editing

`taxonomy.yaml`, `qa/maturity-scores.yaml`, and `qa/maturity-docs-state.json` are the source inputs; tracked `docs/maturity/` pages are route stubs, not editable score, LTS, taxonomy, QA profile, or evidence tables.
`scripts/qa/render-maturity-docs.ts` owns generation; `pnpm maturity:render` writes an artifact preview, and `pnpm maturity:check` validates the source inputs and sanitized state.
`.github/workflows/maturity-scorecard.yml` renders artifact previews and can open source-state PRs; `.github/workflows/openclaw-release-checks.yml` dispatches it for release QA.
Keep raw `qa-evidence.json.scorecard` data in GitHub Actions artifacts; the committed projection contains only deterministic, already-public aggregate facts.
Human overrides must change source state in a PR and explain the reason plus public or redacted evidence.

## Docs i18n

- Foreign-language docs are not maintained in this repo. The generated publish output lives in the separate `openclaw/docs` repo (often cloned locally as `../openclaw-docs`).
- Do not add or edit localized docs under `docs/<locale>/**` here.
- Treat English docs in this repo plus glossary files as the source of truth.
- Pipeline: update English docs here, update `docs/.i18n/glossary.<locale>.json` as needed, then let the publish-repo sync and `scripts/docs-i18n` run in `openclaw/docs`.
- Before rerunning `scripts/docs-i18n`, add glossary entries for any new technical terms, page titles, or short nav labels that must stay in English or use a fixed translation.
- `pnpm docs:check-i18n-glossary` is the guard for changed English doc titles and short internal doc labels.
- Translation memory lives in generated `docs/.i18n/*.tm.jsonl` files in the publish repo.
- See `docs/.i18n/README.md`.
