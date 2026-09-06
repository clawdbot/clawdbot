# Docs Guide

This directory owns docs authoring, published link rules, and docs i18n policy.

## Source Ownership

- Maintainers author `/clawhub/**` pages in [openclaw/clawhub](https://github.com/openclaw/clawhub/tree/main/docs). `scripts/docs-sync-publish.mjs` replaces the entire publish `docs/clawhub/` tree from that source. Do not keep authored copies here.
- This repo therefore holds no `/clawhub/**` page sources, even though `docs/docs.json` lists them in the navigation. A local docs preview and `pnpm docs:check-links` report those routes as missing until you point `OPENCLAW_DOCS_SYNC_CLAWHUB_REPO` at a ClawHub checkout.
- Keep OpenClaw-specific skill and plugin guidance in the owning OpenClaw docs, such as `docs/cli/skills.md` and `docs/cli/plugins.md`. That guidance covers installation, update, verification, removal, and release trust. Standalone ClawHub CLI and publishing reference belongs upstream.
- For links into `/clawhub/**`, run `pnpm docs:check-links:anchors` with `OPENCLAW_DOCS_SYNC_CLAWHUB_REPO` pointing to the actual ClawHub source checkout. Local-only pages cannot prove published ClawHub routes or anchors.

## Published Link Rules

- The publish pipeline pushes docs to `https://docs.openclaw.ai` from the `openclaw/docs` mirror.
- Internal doc links in `docs/**/*.md` must stay root-relative with no `.md` or `.mdx` suffix (example: `[Config](/gateway/configuration)`).
- Section cross-references should use anchors on root-relative paths (example: `[Hooks](/gateway/config-hooks#hooks)`).
- Anchor IDs come from the shared publishing parser in `scripts/lib/docs-markdown.mjs`. Verify them with `pnpm docs:check-links:anchors`, not Mintlify's independent checker. Published heading IDs stay stable. Compatibility aliases never replace an existing target.
- Use an explicit `<a id="stable-section-name" />` for a durable section link when heading wording may change. Keep existing named anchors when reorganizing content.
- README and other GitHub-rendered docs should keep absolute docs URLs so links work outside the docs site.
- Docs content must stay generic: no personal device names, hostnames, or local paths. Use placeholders like `user@gateway-host` and `~/path/to/skills`.

## Docs Content Rules

- For docs, UI copy, and picker lists, order services and providers alphabetically. The one exception is a section that explicitly describes runtime order or auto-detection order.
- Keep bundled plugin naming consistent with the repo-wide plugin terminology rules in the root `AGENTS.md`.
- CI verifies JSON5 and JSON config fences that look like whole `openclaw.json` documents against the schema. `pnpm docs:check-config-examples` runs that verification. Deliberately partial or legacy snippets opt out with `validate=false` in the fence info string.
- Generated docs, never hand-edit: `docs/plugins/reference/**`, `docs/plugins/reference.md`, and `docs/plugins/plugin-inventory.md` come from `pnpm plugins:inventory:gen`. `docs/maturity/**` comes from `pnpm maturity:render`.
- Publishing and packaging generate the public and packaged docs map from `pnpm docs:list --headings`. Keep only the small source stub at `docs/docs_map.md`. Never commit the expanded heading mirror.

## Internal Docs

- Long-lived private operator docs belong in a private operator repo outside this one.
- Repo-local internal scratch/mirror docs may live under ignored `docs/internal/`.
- Never add `docs/internal/**` pages to `docs/docs.json` navigation or link them from public docs.
- `scripts/docs-sync-publish.mjs` excludes and prunes `docs/internal/**` from the public `openclaw/docs` publish repo if a page is force-added later.
- Internal docs may mention repo paths, private app names, 1Password item names, and runbooks, but never include secret values.

## Maturity Scorecard Editing

- `taxonomy.yaml` and `qa/maturity-scores.yaml` are the source inputs.
- Generated maturity docs under `docs/maturity/` are projections. Do not hand-edit their score, LTS, taxonomy, QA profile, or evidence tables.
- `scripts/qa/render-maturity-docs.ts` owns generation. Use `pnpm maturity:render` to refresh committed docs and `pnpm maturity:check` to verify them.
- `.github/workflows/maturity-scorecard.yml` renders artifact previews and can open generated-doc PRs. `.github/workflows/openclaw-release-checks.yml` dispatches it for release QA.
- Keep deterministic `qa-evidence.json.scorecard` data in GitHub Actions artifacts unless a maintainer explicitly asks for a sanitized committed projection.
- Human overrides must change source state in a PR and explain the reason plus public or redacted evidence.

## Docs i18n

- Foreign-language docs are not maintained in this repo. The generated publish output lives in the separate `openclaw/docs` repo (often cloned locally as `../openclaw-docs`).
- Do not add or edit localized docs under `docs/<locale>/**` here.
- Treat OpenClaw-owned English docs in this repo plus glossary files as the source of truth. ClawHub English sources follow Source Ownership above.
- Pipeline: update English docs here, update `docs/.i18n/glossary.<locale>.json` as needed, then let the publish-repo sync and `scripts/docs-i18n` run in `openclaw/docs`.
- Before rerunning `scripts/docs-i18n`, add glossary entries for new technical terms, page titles, and short nav labels. Add an entry for each term that must stay in English or use a fixed translation.
- `pnpm docs:check-i18n-glossary` is the guard for changed English doc titles and short internal doc labels.
- Translation memory lives in generated `docs/.i18n/*.tm.jsonl` files in the publish repo.
- See `docs/.i18n/README.md`.
