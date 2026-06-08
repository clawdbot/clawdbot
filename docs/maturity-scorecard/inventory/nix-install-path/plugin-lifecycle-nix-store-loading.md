---
title: "Nix install path - Plugin Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Nix install path - Plugin Lifecycle Maturity Note

## Summary

OpenClaw blocks mutable plugin lifecycle commands in Nix mode and has a targeted hardlink-policy allowance for plugin roots under `/nix/store`. That source posture is good, but current operator evidence shows declarative plugin support is still incomplete in `nix-openclaw`, including a recent Slack plugin breakage report after plugin externalization.

## Category Scope

Included in this category:

- Lifecycle command refusal: Covers Lifecycle command refusal across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.
- Declarative plugin selection: Covers Declarative plugin selection across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.
- Nix-store plugin loading: Covers Nix-store plugin loading across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.
- Hardlink safety: Covers Hardlink safety across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.

## Features

- Lifecycle command refusal: Covers Lifecycle command refusal across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.
- Declarative plugin selection: Covers Declarative plugin selection across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.
- Nix-store plugin loading: Covers Nix-store plugin loading across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.
- Hardlink safety: Covers Hardlink safety across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (40%)`
- Positive signals: CLI and auto-reply paths verify plugin lifecycle mutators refuse in Nix mode; hardlink policy covers `/nix/store` plugin roots.
- Negative signals: There is no repo-local e2e for a declarative plugin set built into a Nix closure and loaded by a running gateway.
- Integration gaps: No live proof covers Slack/official external plugins after the Nix plugin externalization boundary.

## Quality Score

- Score: `Experimental (35%)`
- Gitcrawl reports: `nix-openclaw plugins` returned issue `#80536` around downstream Nix flake overlays and PR `#80497`; `hardlink Nix plugin` returned no hits.
- Discrawl reports: Recent Discord archive shows `nix-openclaw` plugin support only covered a subset of built-in plugins, a Slack breakage after plugin externalization, and an `openclaw-qmd` wrapper build failure.
- Good qualities: Mutable plugin commands fail closed, and `/nix/store` hardlinks are treated as a specific immutable-store exception instead of broadly weakening plugin hardening.
- Bad qualities: Declarative runtime plugin support is visibly unfinished and was reported as not supporting npm runtime plugins in a recent `nix-openclaw` version.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow evidence were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Experimental (40%)`
- Surface instructions: evaluated against `references/completeness/nix-install-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Lifecycle command refusal, Declarative plugin selection, Nix-store plugin loading, Hardlink safety.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Declarative plugins are active work, not a settled support contract.
- The OpenClaw repo has guardrails and hardlink exceptions, but the actual Nix module support for plugin selection lives externally.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/manage-plugins.md:141` through `:143` says plugin install, update, uninstall, enable, and disable commands are disabled in Nix mode and should be managed in Nix source.
- `/Users/kevinlin/code/openclaw/docs/tools/plugin.md:262` lists `OPENCLAW_NIX_MODE=1` blocking lifecycle commands and tells users to change plugin selection in Nix source.

### Source

- `/Users/kevinlin/code/openclaw/src/cli/plugins-install-command.ts:572` calls the Nix config write guard before plugin install mutation.
- `/Users/kevinlin/code/openclaw/src/cli/plugins-update-command.ts:29` and `/Users/kevinlin/code/openclaw/src/cli/plugins-uninstall-command.ts:34` call the guard for update/uninstall.
- `/Users/kevinlin/code/openclaw/src/cli/plugins-cli.runtime.ts:168` and `:213` guard plugin enable/disable config mutations.
- `/Users/kevinlin/code/openclaw/src/plugins/hardlink-policy.ts:6` through `:16` documents `/nix/store` in `OPENCLAW_NIX_MODE` as an allowed hardlink context.
- `/Users/kevinlin/code/openclaw/src/plugins/hardlink-policy.ts:25` through `:35` rejects hardlinked plugin files unless the origin is bundled or the root is a Nix store path in Nix mode.

### Integration tests

- No Nix-built declarative plugin e2e was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/cli/plugins-cli.install.test.ts:432` through `:436` verifies plugin install refuses in Nix mode before installer side effects.
- `/Users/kevinlin/code/openclaw/src/cli/plugins-cli.update.test.ts:83` through `:88` verifies plugin update refuses before package-manager work.
- `/Users/kevinlin/code/openclaw/src/cli/plugins-cli.uninstall.test.ts:62` through `:67` verifies plugin uninstall refuses before planning file removal.
- `/Users/kevinlin/code/openclaw/src/cli/plugins-cli.policy.test.ts:96` through `:101` verifies plugin enablement refuses before config mutation.
- `/Users/kevinlin/code/openclaw/src/plugins/hardlink-policy.test.ts:27` through `:45` verifies Nix mode alone is insufficient and `/nix/store` root is required.
- `/Users/kevinlin/code/openclaw/src/plugins/manifest-registry.test.ts:2612` through `:2635` verifies config manifest hardlinks outside `/nix/store` are still rejected in Nix mode.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "nix-openclaw plugins" --json`

Results:

- Returned issue `#80536`, involving downstream Nix flake overlay config-schema additions not picked up by runtime validator.
- Returned PR `#80497`, a plugin SDK diagnostic-event PR with Nix-adjacent snippets.

Query:

`gitcrawl search openclaw/openclaw --query "hardlink Nix plugin" --json`

Results:

- Returned `hits: []`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "nix store plugin"`

Results:

- `golden-path-deployments` on 2026-05-28 reported `nix-openclaw` plugins were not yet supported for a version because arbitrary npm installs via Nix were complicated.
- The same thread reported Slack broken on `nix-openclaw` after `v2026.5.26` because Slack moved to an npm runtime plugin and `nix-openclaw` marked npm runtime plugins unsupported.
- `maintainers` on 2026-05-08 described PR `#79344` relaxing hardlink policy for Nix users so normal plugins can use hardlinks to `/nix/store`.
