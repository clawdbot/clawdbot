# OpenClaw docs i18n assets

This folder stores translation config for the source docs repo.

Generated locale trees and live translation memory now live in the publish repo:

- repo: `openclaw/docs`
- local checkout: `~/path/to/openclaw-docs`

## Source of truth

- OpenClaw English docs are authored in `openclaw/openclaw` under `docs/`.
- ClawHub English docs are authored in `openclaw/clawhub` under `docs/` and mirrored into the publish repo's `docs/clawhub/` tree. Do not keep competing ClawHub pages in `openclaw/openclaw`; OpenClaw-specific integration guidance stays in the owning OpenClaw docs.
- The source repo no longer keeps committed generated locale trees such as `docs/zh-CN/**`, `docs/zh-TW/**`, `docs/ja-JP/**`, `docs/es/**`, `docs/pt-BR/**`, `docs/ko/**`, `docs/de/**`, `docs/fr/**`, `docs/hi/**`, `docs/ar/**`, `docs/it/**`, `docs/vi/**`, `docs/nl/**`, `docs/fa/**`, `docs/ru/**`, `docs/tr/**`, `docs/uk/**`, `docs/id/**`, `docs/pl/**`, or `docs/th/**`.

## End-to-end flow

Edit English docs in `openclaw/openclaw` and push to `main`. The sync, translation, and publish sequence is documented in [translation-workflow.md](translation-workflow.md). Keep that file as the single description of the pipeline.

## Why the split exists

- Keep generated locale output out of the main product repo.
- Keep Mintlify on a single published docs tree.
- Preserve the built-in language switcher for Mintlify-supported generated locales by letting the publish repo own generated locale trees.
- Keep generated Thai (`th`) and Persian (`fa`) docs plus translation memory even though Mintlify does not accept those codes in `navigation.languages` (checked 2026-09-06). Their absence from the built-in docs language picker is a host limitation, not a failed translation run.

## Locale visibility

- Control UI supports `en`, `zh-CN`, `zh-TW`, `pt-BR`, `de`, `es`, `ja-JP`, `ko`, `fr`, `hi`, `ar`, `it`, `vi`, `nl`, `fa`, `ru`, `tr`, `uk`, `id`, `pl`, and `th`.
- Docs translation workflows generate the same non-English locale set in `openclaw/docs`.
- The Mintlify docs language picker can expose only the locales accepted by Mintlify `navigation.languages`. As of 2026-09-06, the publish configuration includes Russian (`ru`) and Hindi (`hi`).
- Do not treat locale visibility in generated `docs/docs.json` as proof that translation artifacts exist. Verify each generated locale folder and its translation memory in `openclaw/docs`.

## Files in this folder

- `glossary.<lang>.json` — preferred term mappings used as prompt guidance.
- `zh-Hans-navigation.json` — curated zh-Hans tab and group labels overlaid onto the current English navigation tree during publish sync.
- `ar-navigation.json`, `de-navigation.json`, `es-navigation.json`, `fr-navigation.json`, `id-navigation.json`, `it-navigation.json`, `ja-navigation.json`, `ko-navigation.json`, `pl-navigation.json`, `pt-BR-navigation.json`, and `tr-navigation.json` — starter locale labels kept alongside the source repo. Publish sync clones the full English navigation tree, prefixes locale routes, and overlays translated labels by matching shared page anchors.
- `<lang>.tm.jsonl` — translation memory keyed by workflow, prompt version, language, and text hash.

### Locale code mapping

Three different code families are in play and they do not always match. Mintlify
`navigation.languages` uses the language code, the generated locale tree and the
glossary/TM files use the directory code, and the navigation overlay file is named
after the language code. `GENERATED_LOCALES` in `scripts/docs-sync-publish.mjs` is
the source of truth for this mapping.

| Mintlify language | Locale directory | Navigation file                         | Glossary file         | TM file          | Nav mode |
| ----------------- | ---------------- | --------------------------------------- | --------------------- | ---------------- | -------- |
| `zh-Hans`         | `docs/zh-CN/`    | `zh-Hans-navigation.json`               | `glossary.zh-CN.json` | `zh-CN.tm.jsonl` | overlay  |
| `zh-Hant`         | `docs/zh-TW/`    | `zh-Hant-navigation.json` (not present) | `glossary.zh-TW.json` | `zh-TW.tm.jsonl` | clone-en |
| `ja`              | `docs/ja-JP/`    | `ja-navigation.json`                    | `glossary.ja-JP.json` | `ja-JP.tm.jsonl` | clone-en |
| `es`              | `docs/es/`       | `es-navigation.json`                    | `glossary.es.json`    | `es.tm.jsonl`    | clone-en |
| `pt-BR`           | `docs/pt-BR/`    | `pt-BR-navigation.json`                 | `glossary.pt-BR.json` | `pt-BR.tm.jsonl` | clone-en |
| `ko`              | `docs/ko/`       | `ko-navigation.json`                    | `glossary.ko.json`    | `ko.tm.jsonl`    | clone-en |
| `de`              | `docs/de/`       | `de-navigation.json`                    | `glossary.de.json`    | `de.tm.jsonl`    | clone-en |
| `fr`              | `docs/fr/`       | `fr-navigation.json`                    | `glossary.fr.json`    | `fr.tm.jsonl`    | clone-en |
| `hi`              | `docs/hi/`       | `hi-navigation.json` (not present)      | `glossary.hi.json`    | `hi.tm.jsonl`    | clone-en |
| `ar`              | `docs/ar/`       | `ar-navigation.json`                    | `glossary.ar.json`    | `ar.tm.jsonl`    | clone-en |
| `it`              | `docs/it/`       | `it-navigation.json`                    | `glossary.it.json`    | `it.tm.jsonl`    | clone-en |
| `vi`              | `docs/vi/`       | `vi-navigation.json` (not present)      | `glossary.vi.json`    | `vi.tm.jsonl`    | clone-en |
| `nl`              | `docs/nl/`       | `nl-navigation.json` (not present)      | `glossary.nl.json`    | `nl.tm.jsonl`    | clone-en |
| `fa`              | `docs/fa/`       | `fa-navigation.json` (not present)      | `glossary.fa.json`    | `fa.tm.jsonl`    | clone-en |
| `tr`              | `docs/tr/`       | `tr-navigation.json`                    | `glossary.tr.json`    | `tr.tm.jsonl`    | clone-en |
| `uk`              | `docs/uk/`       | `uk-navigation.json` (not present)      | `glossary.uk.json`    | `uk.tm.jsonl`    | clone-en |
| `id`              | `docs/id/`       | `id-navigation.json`                    | `glossary.id.json`    | `id.tm.jsonl`    | clone-en |
| `pl`              | `docs/pl/`       | `pl-navigation.json`                    | `glossary.pl.json`    | `pl.tm.jsonl`    | clone-en |
| `th`              | `docs/th/`       | `th-navigation.json` (not present)      | `glossary.th.json`    | `th.tm.jsonl`    | clone-en |
| `ru`              | `docs/ru/`       | `ru-navigation.json` (not present)      | `glossary.ru.json`    | `ru.tm.jsonl`    | clone-en |

Only three locales differ between the two code families: `zh-Hans`/`zh-CN`,
`zh-Hant`/`zh-TW`, and `ja`/`ja-JP`. Every other locale uses the same code in both
places. `scripts/docs-i18n` builds the glossary path from the
directory code (`-lang`), so a glossary must be named `glossary.<dir>.json`, not
`glossary.<language>.json`. Locales without a navigation file fall back to the
cloned English tree with route prefixes only.

In this repo, generated locale TM files such as `docs/.i18n/zh-CN.tm.jsonl`, `docs/.i18n/zh-TW.tm.jsonl`, `docs/.i18n/ja-JP.tm.jsonl`, `docs/.i18n/es.tm.jsonl`, `docs/.i18n/pt-BR.tm.jsonl`, `docs/.i18n/ko.tm.jsonl`, `docs/.i18n/de.tm.jsonl`, `docs/.i18n/fr.tm.jsonl`, `docs/.i18n/ar.tm.jsonl`, `docs/.i18n/it.tm.jsonl`, `docs/.i18n/vi.tm.jsonl`, `docs/.i18n/nl.tm.jsonl`, `docs/.i18n/fa.tm.jsonl`, `docs/.i18n/tr.tm.jsonl`, `docs/.i18n/uk.tm.jsonl`, `docs/.i18n/id.tm.jsonl`, `docs/.i18n/pl.tm.jsonl`, and `docs/.i18n/th.tm.jsonl` are intentionally no longer committed.

## Glossary format

`glossary.<lang>.json` is an array of entries:

```json
{
  "source": "troubleshooting",
  "target": "故障排除"
}
```

Fields:

- `source`: English (or source) phrase to prefer.
- `target`: preferred translation output.

## Translation mechanics

- `scripts/docs-i18n` still owns translation generation.
- Translation rules and glossary guidance are passed as Codex developer instructions; document text is user input, and repository `AGENTS.md` instructions are excluded from translation calls. Placeholder spelling and occurrence counts must match the input, even when the target language restructures comparisons or references.
- Model selection comes from `OPENCLAW_DOCS_I18N_MODEL`; an optional `OPENCLAW_DOCS_I18N_FALLBACK_MODEL` is used only when the selected model is missing or unsupported. Each worker retains the fallback for its remaining translations. Authentication, quota, network, and generic service failures do not select a different model.
- Automated workflows inject model selections from repository secrets. Generated frontmatter, translation memory, cache keys, and failure logs omit model identifiers. Raw Codex diagnostics are not forwarded to workflow logs.
- Doc mode writes `x-i18n.source_hash` into each translated page and requires current workflow and prompt versions before reusing it. Older workflow outputs are regenerated during incremental translation so retired metadata is removed.
- The publish workflow precomputes a pending file list by comparing the current English source hash to the stored locale `x-i18n.source_hash`, and queues pages containing retired model/provider metadata for regeneration.
- If the pending count is `0`, the expensive translation step is skipped entirely.
- If there are pending files, the workflow translates only those files.
- Locale workers retry transient model-format failures, but unchanged files stay skipped because the same hash check runs on each retry.
- Locale workers upload artifacts; the publish repo finalizer commits all successful locale outputs together.
- Published GitHub releases dispatch one aggregate translation refresh so release docs can catch up without waiting for the weekly reconciliation.

## Operational notes

- Sync metadata is written to `.openclaw-sync/source.json` in the publish repo.
- Source repo secret: `OPENCLAW_DOCS_SYNC_TOKEN`
- Publish repo secret: `OPENCLAW_DOCS_I18N_OPENAI_API_KEY`
- If locale output looks stale, check the `Translate All` workflow in `openclaw/docs` first.

### Rejected translation diagnostics

For an operator-approved, bounded diagnostic, set `OPENCLAW_DOCS_I18N_LOG_REJECTED_BODY=1` (the publish repo's reusable locale workflow exposes `log_rejected_body`). This opt-in logs rejected raw chunks at the placeholder-validation boundary, including the chunk ID, normalized masked input, returned translation, and error. It also logs failed leaf-fallback errors and rejected bodies at final-document validation. Validation and retry behavior stay unchanged.

The chunk input/output are the Go translator boundary values, after its whitespace and input-wrapper handling, not raw provider transport bytes. Diagnostics can contain complete document text; limit the selected paths and attempts, retain the logs, and inspect them before sharing. Enabling the flag cannot recover responses from an earlier run.
