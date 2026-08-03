# Translation workflow

Internal note for the docs publish pipeline. This file is under `docs/.i18n`, which is ignored by the docs-site build and is not published.

## Goals

- English docs deploy quickly after every source docs sync.
- Locale translation does not run for every hot `main` commit.
- Translation work is debounced so a burst of docs commits becomes one translation wave.
- Locale jobs translate only pages whose source hash changed since the last successful locale output.
- Successful locale outputs are committed together, even if one or more locale jobs fail.
- A weekly reconciliation reruns every locale/page path to repair missed or flaky translations.

## Event flow

1. `openclaw/openclaw` syncs English docs into `openclaw/docs`.
2. GitHub Pages deploys English/source changes immediately from the sync commit.
3. `Translate All` is triggered by the sync commit, release dispatch, manual dispatch, or weekly schedule.
4. The coordinator waits a cooldown window before starting translation.
5. After the cooldown, the coordinator reads the current `origin/main` source metadata.
6. If a newer docs sync arrived during cooldown, the coordinator uses the newer source state.
7. Per-locale translation jobs run in parallel with `fail-fast: false`.
8. Each locale job uploads an artifact for the requested source SHA.
9. The finalizer downloads available artifacts, ignores stale or failed payloads, and pushes one aggregate i18n commit.
10. After the aggregate commit lands, the finalizer dispatches the Pages deploy once.
11. The Pages workflow dispatches live smoke after deployment.

## Debounce policy

The coordinator waits 1 hour after a docs sync or release dispatch, then re-reads `origin/main`.

The default cooldown is controlled by the publish repo variable `OPENCLAW_DOCS_TRANSLATION_COOLDOWN_SECONDS`, which defaults to `3600`. Repository dispatch callers may override it with `client_payload.cooldown_seconds`, and manual runs may set `cooldown_seconds`.

If `.openclaw-sync/source.json` changed during the wait, it waits again from the newer state. If `main` keeps moving, the wait is capped by `OPENCLAW_DOCS_TRANSLATION_MAX_WAIT_SECONDS`, which defaults to the cooldown value. The newest observed state is translated after the cap.

Manual and weekly runs do not wait by default.

## Incremental translation

Each translated page stores `x-i18n.source_hash`. Locale jobs compare the current English page hash with the stored locale hash.

Normal runs translate only:

- missing locale pages
- locale pages with stale `x-i18n.source_hash`
- pages affected by source deletion/pruning

Internal files under `docs/.i18n/**` are not translation inputs. Push-triggered runs that only change internal i18n files skip before the locale matrix.

If a locale job fails, its artifact is marked failed and carries no payload. The finalizer still commits successful locales. The failed locale remains stale and is picked up by the next incremental run because its source hashes still do not match.

## Artifact contract

Each locale job uploads one artifact named with locale and source SHA:

```text
i18n-zh-cn-<source-sha>
```

Artifact contents:

```text
metadata.json
changed-files.txt
deleted-files.txt
payload/docs/<locale>/**
payload/docs/.i18n/<locale>.tm.jsonl
```

`metadata.json` includes the locale, locale slug, source SHA, pending count, changed count, and any failure reason. The finalizer rejects artifacts whose `source_sha` does not match the current `.openclaw-sync/source.json`.

The source repo release workflow dispatches one `translate-all-release` event. The coordinator still accepts old per-locale release events for compatibility, but those are only a fallback.

## Aggregate commit

The finalizer owns the only locale push in the normal path.

Commit message:

```text
chore(i18n): refresh translations
```

The commit may contain a partial locale set. The job summary lists applied locales, locales with no changes, missing or failed locales, stale artifacts, and invalid artifacts.

## Weekly reconciliation

The weekly run uses `full` mode. It forces a full reconciliation across every locale and every source page instead of relying only on changed source hashes.

Glossary changes also force full reconciliation because glossary guidance can affect pages whose source hashes did not change.

Expected behavior:

- regenerate or verify every locale page
- prune stale locale pages
- refresh translation memory as needed
- still use parallel locale jobs
- still commit one aggregate result
- still tolerate individual locale failures

The weekly run is the repair mechanism for LLM flakiness, partial failures, and missed incremental updates.

## Deployment policy

English deploys from source sync commits.

Translations deploy after the aggregate i18n commit. The finalizer dispatches GitHub Pages once because GitHub suppresses normal push-triggered workflow runs from `GITHUB_TOKEN` commits. The Pages workflow dispatches live smoke after deployment so the smoke test checks the deployed site instead of racing the deploy.

A hot docs day should produce many fast English deploys, but only a small number of locale deploys.

If external deploy providers such as Mintlify watch every push, the aggregate i18n commit is the load reducer. Avoid restoring per-locale pushes to `main`.
