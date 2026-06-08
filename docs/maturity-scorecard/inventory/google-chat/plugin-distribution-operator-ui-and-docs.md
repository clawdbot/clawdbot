---
title: "Google Chat - Plugin Distribution Operator UI and Docs Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat - Plugin Distribution Operator UI and Docs Maturity Note

## Summary

Google Chat is well represented in plugin metadata, docs navigation, install catalogs, Android labels, Control UI status cards, and channel overview pages. Distribution coverage is stronger than the runtime surface, but Quality remains Alpha because the docs/status/operator UI do not yet absorb the full Workspace/admin complexity, user-OAuth limitation, appPrincipal nuance, and space/thread failure modes exposed in archive evidence.

## Category Scope

This note covers npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, Android/control UI channel labels, status card rendering, install/update metadata, channel aliases, and operator-facing documentation. It excludes the core runtime behavior already scored in setup, webhook, routing, delivery, actions, media, and account/status notes.

## Features

- NPM and ClawHub install: Covers NPM and ClawHub install across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Plugin docs and catalog routing: Covers Plugin docs and catalog routing across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Channel aliases and labels: Covers Channel aliases and labels across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Operator status UI: Covers Operator status UI across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Install/update metadata: Covers Install/update metadata across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: Plugin metadata declares npm/ClawHub install routes, docs path, aliases, channel env vars, CLI add options, publish metadata, and compatibility. Tests cover official external catalog resolution, bundled build entries, setup wizard helpers, channel IDs/aliases, Control UI card rendering, and plugin import guardrails.
- Negative signals: Distribution/status coverage does not prove the real end-to-end install from npm/ClawHub through Google Cloud setup and first message. UI/status coverage is also mostly static rendering and config-state proof, not an operator repair workflow.
- Integration gaps: Add an install smoke that installs `@openclaw/googlechat`, verifies docs links and status card fields, runs setup wizard or `channels add`, starts the gateway, and confirms the operator can diagnose a failed Google-side webhook.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: #9764, #58514, #65007, #80995, #82014, #42510, and #69422 show docs/operator surfaces have not yet eliminated confusion around user OAuth, spaces, payloads, thread routing, and typing lifecycle. #71078/#57542/#53888 show auth diagnostics had to be improved after opaque appPrincipal failures.
- Discrawl reports: `discrawl search "Google Chat setup service account audience" --limit 10` returned operator guidance and appPrincipal confusion; `discrawl search "Google Chat appPrincipal" --limit 10` returned issue/PR discussion that warnings and logs improved but the setup contract remains nuanced. Release chatter for 2026.5.27-beta.1 explicitly called out Google Chat DM thread behavior as worth testing, not settled.
- Good qualities: The docs are discoverable, the plugin is externalized with production metadata, the channel card exposes credential/audience/probe state, and reference pages route users from plugin inventory to channel docs. The channel is also visible across CLI docs, wizard references, Android labels, and docs navigation.
- Bad qualities: Operator surfaces overstate readiness if read only as installed/configured/running. The public docs do not yet carry all live pain points: appPrincipal numeric values, add-on payload variants, service-account versus user OAuth scope gaps, no receive-all space messages, and stale typing/thread behaviors.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence/depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/google-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for NPM and ClawHub install, Plugin docs and catalog routing, Channel aliases and labels, Operator status UI, Install/update metadata.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a "What status proves and what it does not prove" section for Google Chat.
- Update docs to separate service-account-supported capabilities from user-OAuth-required capabilities.
- Add an operator repair table for appPrincipal, add-on payloads, space allowlists, thread leakage, and stale typing placeholders.
- Add a real install/setup/status smoke for the externalized plugin package.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`: primary channel docs with install, setup, public URL, config, targets, troubleshooting, and related links.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/googlechat.md`: plugin reference for `@openclaw/googlechat`.
- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md` and `/Users/kevinlin/code/openclaw/docs/plugins/reference.md`: list Google Chat with npm/ClawHub distribution and channel surface.
- `/Users/kevinlin/code/openclaw/docs/channels/index.md`: lists Google Chat as a downloadable plugin channel.
- `/Users/kevinlin/code/openclaw/docs/docs.json`: contains the Google Chat docs route and redirect from `/providers/googlechat`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/googlechat/package.json`: contains the OpenClaw plugin metadata, npm spec, docs path, aliases, install metadata, compatibility metadata, and release flags.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/index.ts`: exports plugin id, name, description, setup, and runtime entrypoints.
- `/Users/kevinlin/code/openclaw/ui/src/ui/views/channels.googlechat.ts`: renders Google Chat status card fields including credential, audience, last start/probe timestamps, probe result, and config section.
- `/Users/kevinlin/code/openclaw/ui/src/ui/views/channels.ts`: includes Google Chat in the channels view.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt`: maps `googlechat` to `Google Chat` for Android channel labels.
- `/Users/kevinlin/code/openclaw/src/plugins/official-external-plugin-catalog.test.ts`: verifies the official external plugin catalog resolves Google Chat to `@openclaw/googlechat`.

### Integration tests

- No dedicated live install/setup/status smoke for the external Google Chat package was found.
- `/Users/kevinlin/code/openclaw/test/scripts/bundled-plugin-build-entries.test.ts`: covers Google Chat bundled plugin build entries.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/contracts/channel-import-guardrails.test.ts`: includes Google Chat in channel import guardrails.
- `/Users/kevinlin/code/openclaw/ui/src/ui/views/channels.test.ts`: covers channel view rendering paths that include Google Chat.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/channels/ids.test.ts`: verifies aliases `gchat` and `google-chat` normalize to `googlechat`.
- `/Users/kevinlin/code/openclaw/src/plugins/official-external-plugin-catalog.test.ts`: verifies official install metadata for `googlechat`.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/bundled.shape-guard.test.ts`: covers Google Chat runtime/API entrypoint shape.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.test.ts`: covers metadata/capability behavior of the Google Chat channel adapter.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/setup-wizard-helpers.test.ts`: includes Google Chat setup helper paths.

### Gitcrawl queries

Query:

`gitcrawl search issues "Google Chat plugin install npm ClawHub disabled" --repo openclaw/openclaw --limit 15 --json number,title,state,updatedAt,url`

Results:

- Returned no direct Google Chat install issue hits. This is neutral after successful freshness checks; quality concerns came from broader operator/runtime reports.

Query:

`gitcrawl search issues "Google Chat" --repo openclaw/openclaw --limit 20 --json number,title,state,updatedAt,url`

Results:

- Returned open runtime/operator issues #65007, #80995, #82014, #44347, #49350, #77307, #58514, #42510, #9764, #69422, and #39843, all of which affect operator docs/status expectations.

Query:

`gitcrawl gh issue view 71078 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned closed #71078, which documents the prior observability gap around swallowed Google Chat auth rejection reasons.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat setup service account audience" --limit 10`

Results:

- Returned operator setup guidance and appPrincipal/audience debugging context, showing the docs/status surface must cover more than package installation.

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat appPrincipal" --limit 10`

Results:

- Returned issue comments and PR discussions about appPrincipal warnings, numeric JWT `sub` values, and auth-rejection logging improvements.
