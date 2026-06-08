---
title: "Nix install path - Install Handoff Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Nix install path - Install Handoff Maturity Note

## Summary

The public OpenClaw repo documents Nix as a supported optional install overview, but deliberately hands the authoritative setup contract to the external `openclaw/nix-openclaw` repository. That is a reasonable operator boundary, but it leaves this component at M1 experimental maturity from the OpenClaw source repo alone: the local repo does not contain a flake, module implementation, or runtime proof that a user can complete the Nix install path.

## Category Scope

Included in this category:

- Nix install overview: Covers Nix install overview across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.
- nix-openclaw source-of-truth: Covers nix-openclaw source-of-truth across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.
- Install discoverability: Covers Install discoverability across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.
- Verification handoff: Covers Verification handoff across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.

## Features

- Nix install overview: Covers Nix install overview across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.
- nix-openclaw source-of-truth: Covers nix-openclaw source-of-truth across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.
- Install discoverability: Covers Install discoverability across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.
- Verification handoff: Covers Verification handoff across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (25%)`
- Positive signals: Public docs describe the Nix install path, quick start, rollback promise, Home Manager handoff, and verification expectation.
- Negative signals: The source repo has no `flake.nix`, `flake.lock`, `default.nix`, or `shell.nix` outside generated/build folders, so the local OpenClaw repo cannot itself prove the Nix install path.
- Integration gaps: No local integration, e2e, live, or real Home Manager service proof was found for the install handoff.

## Quality Score

- Score: `Experimental (45%)`
- Gitcrawl reports: `nix-openclaw` search mostly returns broad Nix mentions and open Nix-adjacent issues/PRs rather than a clean support-status thread, which makes repo-local issue evidence noisy.
- Discrawl reports: Current Discord messages show active work on declarative plugins and a `nix-openclaw` proposal, which is a positive maintenance signal but also evidence that core pieces are still moving.
- Good qualities: The docs make the source-of-truth boundary explicit and keep the local page as an overview instead of pretending the OpenClaw repo owns the full Nix module.
- Bad qualities: The support promise remains split across local docs and external implementation, and the scorecard row itself says the optional install flow needs a clearer support promise before promotion.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow evidence were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Experimental (25%)`
- Surface instructions: evaluated against `references/completeness/nix-install-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Nix install overview, nix-openclaw source-of-truth, Install discoverability, Verification handoff.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- The local source repo does not contain the Nix package/module implementation.
- The docs point users to copy an external template but do not show a checked-in local template or pinned example in this repo.
- The install page says to verify that the launchd service runs and the bot responds, but there is no local real-runtime proof attached to that instruction.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/nix.md:10` presents Nix as declarative install through `nix-openclaw`.
- `/Users/kevinlin/code/openclaw/docs/install/nix.md:13` says the `nix-openclaw` repo is the source of truth and the page is only an overview.
- `/Users/kevinlin/code/openclaw/docs/install/nix.md:21` promises rollback through `home-manager switch --rollback`.
- `/Users/kevinlin/code/openclaw/docs/install/nix.md:26` through `:41` gives a quick-start outline but requires copying the agent-first flake template from the external repo.
- `/Users/kevinlin/code/openclaw/docs/install/index.md:140` links the Install index card to `/install/nix`.
- `/Users/kevinlin/code/openclaw/docs/start/docs-directory.md:23` includes Nix mode in the docs directory.
- `/Users/kevinlin/code/openclaw/docs/start/showcase.md:294` lists Nix packaging with a link to `openclaw/nix-openclaw`.

### Source

- `find /Users/kevinlin/code/openclaw ... -iname 'flake.nix' -o -iname 'flake.lock' -o -iname 'default.nix' -o -iname 'shell.nix'` returned no source-repo Nix package files after pruning `node_modules` and `dist`.
- `/Users/kevinlin/code/openclaw/docs/docs.json:668` redirects `/nix` to `/install/nix`.
- `/Users/kevinlin/code/openclaw/docs/docs.json:1041` includes `install/nix` in docs navigation.

### Integration tests

- No repo-local integration, e2e, live, launchd/systemd, or Home Manager proof was found for the public docs handoff itself.

### Unit tests

- No unit test directly validates the public docs handoff or external template copy instructions.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "nix-openclaw" --json`

Results:

- Returned open Nix-adjacent items including PR `#77843`, issue `#9987`, issue `#73328`, issue `#70191`, PR `#85238`, PR `#79734`, issue `#80536`, and PR `#82032`; results were broad because the keyword index tokenized `nix-openclaw`.
- No clean repo-local issue proving the docs handoff as an end-to-end supported install path was found in this query.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "nix-openclaw"`

Results:

- `golden-path-deployments` on 2026-05-29 linked proposal `openclaw/nix-openclaw#96`.
- `maintainers` on 2026-05-29 said declarative plugins in `nix-openclaw` had a first subset working.
- `golden-path-deployments` on 2026-05-28 said a plugin POC in `nix-openclaw` only did a subset of built-in plugins.
