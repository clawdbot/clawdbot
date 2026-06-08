---
title: "WhatsApp - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# WhatsApp - Channel Setup and Operations Maturity Note

## Summary

WhatsApp operator install and configuration are Beta. The official external
plugin package has clear docs, manifest metadata, config schema, setup wiring,
ClawHub/npm install guidance, and doctor/setup caveats. It remains below Stable
because the real operator path still depends on volatile Baileys/session
behavior and lacks a WhatsApp-specific install-to-linked-account proof.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Channel Operations`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Official @openclaw/whatsapp plugin metadata: Official @openclaw/whatsapp plugin metadata, package entrypoints, and setup discovery.
- openclaw plugin install whatsapp: openclaw plugin install whatsapp and config-first setup guidance
- Channel config schema: Channel config schema, plugin hooks, setup finalization, default account, and secret handling.
- Baileys socket lifecycle: Baileys socket lifecycle, connection controller state, reconnect decisions, and repair status.
- Operator troubleshooting: Operator troubleshooting for reconnect loops, stale sockets, Bun/Node runtime
- Baileys socket lifecycle: Covers Baileys socket lifecycle, connection controller state, reconnect decisions behavior.
- Operator troubleshooting for reconnect loops: Covers Operator troubleshooting for reconnect loops, stale sockets, Bun/Node runtime behavior.

## Features

- Official @openclaw/whatsapp plugin metadata: Official @openclaw/whatsapp plugin metadata, package entrypoints, and setup discovery.
- openclaw plugin install whatsapp: openclaw plugin install whatsapp and config-first setup guidance
- Channel config schema: Channel config schema, plugin hooks, setup finalization, default account, and secret handling.
- Baileys socket lifecycle: Baileys socket lifecycle, connection controller state, reconnect decisions, and repair status.
- Operator troubleshooting: Operator troubleshooting for reconnect loops, stale sockets, Bun/Node runtime

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: docs cover plugin installation, account config, QR setup,
  troubleshooting, Node/Bun caveats, and plugin reference; source declares the
  external plugin manifest, package scripts, config schema, setup hooks, account
  resolution, and setup finalization.
- Negative signals: install proof is mostly docs/source and setup-unit backed;
  current archive results include setup/config confusion and Docker restart-loop
  risk.
- Integration gaps: generic plugin install proof exists, but no located
  WhatsApp-specific scenario proves ClawHub/npm install, setup config writes,
  QR link, and status/doctor output as one operator workflow.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: `whatsapp plugin install config auth dir` surfaced open
  #86612 Docker gateway restart loop after official external plugin install,
  open #87604 plugin-disabled-but-config-present warning confusion, and adjacent
  packaging/cache PR history. `@openclaw/whatsapp package external plugin
install` surfaced #85869 on plugin/core version compatibility after floating
  install.
- Discrawl reports: `whatsapp plugin install config auth dir` returned legacy
  setup/help/install chatter; `WhatsApp Baileys session QR login channels login`
  returned session/auth volatility reports and logout/relink guidance.
- Good qualities: the package is explicitly marked official, stable/beta default
  to trusted ClawHub install, npm fallback and local dev behavior are separated,
  metadata declares host/API compatibility, setup avoids loading Baileys in
  metadata-only paths, and account/auth path resolution is explicit.
- Bad qualities: external plugin packaging, host Node/Bun behavior, QR-only
  setup, plugin/core version compatibility, and auth directory choices remain
  easy to misconfigure; plugin-disabled warnings can still confuse operators
  when config is present.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow
  test coverage did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/whatsapp.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Official @openclaw/whatsapp plugin metadata, openclaw plugin install whatsapp, Channel config schema, Baileys socket lifecycle, Operator troubleshooting.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a WhatsApp-specific install-to-config-to-login scenario for ClawHub and
  npm fallback.
- Close the loop on plugin/core version guard, secondary-account boot crash, and
  wedged channel recovery without forced relink.
- Make plugin-disabled-but-config-present diagnostics easier to distinguish from
  package resolution failures.
- Keep Bun and Node runtime caveats near the install path rather than only in
  troubleshooting.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:10` documents on-demand plugin installation, ClawHub-first resolution, and npm fallback.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:43` documents quick setup and QR login entrypoints.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:557` documents account selection, credential paths, and logout behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:592` documents troubleshooting, reconnect, provider acceptance, group issues, and Bun caveats.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:93` documents WhatsApp channel config, reconnect timings, multi-account config, and legacy auth migration.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/whatsapp.md:12` documents the official package, ClawHub/npm availability, and channel surface.

### Source

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/openclaw.plugin.json:1` declares the official WhatsApp plugin id, name, channel, config schema, and hooks.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/package.json:1` declares `@openclaw/whatsapp`, ClawHub/npm publish scripts, and Baileys dependency.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/channel.ts:69` builds the plugin channel with setup, pairing, outbound, group helpers, allowlist, target resolver, actions, and approvals.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/channel.setup.ts:17` wires setup and legacy migrations.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/accounts.ts:23` defines resolved account fields, auth directory behavior, and account enablement.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/setup-core.ts:1` and `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/setup-finalize.ts:1` implement setup-time config mutation and finalization.
- `/Users/kevinlin/code/openclaw/scripts/lib/official-external-channel-catalog.json:488` lists WhatsApp as an official external channel install.
- `/Users/kevinlin/code/openclaw/src/commands/onboarding-plugin-install.ts:303` chooses stable/beta remote defaults and separates ClawHub, npm, and local dev source handling.
- `/Users/kevinlin/code/openclaw/src/plugins/install.ts:145` checks host and plugin API compatibility.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/vitest/vitest.extension-whatsapp.config.ts:11` defines the scoped WhatsApp extension test lane.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:387` builds a live QA config with plugin enablement, account config, allowFrom, group policy, and approvals.
- `/Users/kevinlin/code/openclaw/docs/concepts/qa-e2e-automation.md:694` documents WhatsApp QA scenarios and credential-pool behavior.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh:40` covers generic bundled plugin install/runtime/uninstall behavior.
- `/Users/kevinlin/code/openclaw/.github/workflows/qa-live-transports-convex.yml:671` runs a live WhatsApp QA lane adjacent to runtime behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/config-schema.test.ts:1` covers WhatsApp config schema behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/setup-surface.test.ts:1` covers setup surface behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/channel.setup.test.ts:1` covers setup wiring.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/accounts.test.ts:1` and `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/accounts.whatsapp-auth.test.ts:1` cover account and auth path resolution.
- `/Users/kevinlin/code/openclaw/src/commands/channel-setup/plugin-install.test.ts:364` covers npm install, active profile install dir, dev/beta defaults, ClawHub source, fallback, and setup-only registry reload.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "whatsapp plugin install config auth dir" --json`

Results:

- Open #86612 reported a Docker gateway container restart loop after installing the official external WhatsApp plugin and included config warnings.
- Open #87604 reported a plugin-disabled-but-config-present warning state.
- Adjacent hits covered bundled plugin/cache work and WhatsApp account policy refactors.

Query:

`gitcrawl search openclaw/openclaw --query "@openclaw/whatsapp package external plugin install" --json`

Results:

- Surfaced #85869 for plugin/core version compatibility after floating install, plus plugin install hardening PRs.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "whatsapp plugin install config auth dir" --limit 5`

Results:

- Returned legacy Clawdbot setup/help/install messages and no stronger current install-specific defect than the Gitcrawl results.

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "WhatsApp Baileys session QR login channels login" --limit 5`

Results:

- Returned session/auth volatility reports, including atomic credential rewrite discussion, restart-loop reports, and support guidance to logout/relink after Baileys failures.
