---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Twitch Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Twitch Maturity Note

## Summary

Twitch is Alpha. It is a bundled plugin with docs for Twitch IRC chat, OAuth tokens, token refresh, multi-account configuration, access control, tool actions, safety, and troubleshooting. Source includes client, token, status, outbound, access-control, and live-test hooks. It remains Alpha because the live verification is opt-in and credential-gated, and archive evidence shows recent restart-loop, token resolution, and `client.connect()` lifecycle concerns.

## Category Scope

- Twitch bot account setup, OAuth access/refresh tokens, client ID/secret, channel join config, multi-account config, and package/bundled install behavior.
- Twitch IRC monitor/client lifecycle, token refresh, status/probe, access control by user ID/roles, `requireMention`, and outbound chat delivery.
- Message tool send action, moderation-oriented action surface, safety/ops, and troubleshooting.

## Features

- Twitch bot account setup: Twitch bot account setup, OAuth access/refresh tokens, client ID/secret, channel join config, multi-account config, and package/bundled install behavior
- Twitch IRC monitor/client lifecycle: Twitch IRC monitor/client lifecycle, token refresh, status/probe, access control by user ID/roles, requireMention, and outbound chat delivery
- Message tool send action: Message tool send action, moderation-oriented action surface, safety/ops, and troubleshooting

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (66%)`
- Positive signals: docs cover setup, OAuth/token refresh, access control, multi-account config, status probes, tool actions, and ops limits; source has plugin lifecycle, client manager, Twitch client, token handling, status/probe, outbound, send, actions, and setup surfaces.
- Negative signals: the only live Twitch proof found is an opt-in test gated by `TWITCH_LIVE_TEST=1` and credentials; no committed run artifact proves a real Twitch account/channel path.
- Integration gaps: live IRC connect, token refresh, incoming chat, mention-gated dispatch, outbound send, role/user access, reconnect, and multi-account routing are not captured in a recurring scenario.

## Quality Score

- Score: `Alpha (63%)`
- Gitcrawl reports: current results include `#55341` persisted refreshed Twitch tokens, `#83885` `client.connect()` not awaited with failed connection stored, `#62387` named-account promotion default stripping, and broader broker work.
- Discrawl reports: 2026-05-15 contributor message described a Twitch restart-loop fix after connect and provided credential-gated verification instructions; 2026-04-17 review comments flagged normalized token lookup in a bundled setup-entry PR.
- Good qualities: docs are unusually explicit about token scope, refresh limitations, user ID allowlists, roles, multi-account config, and safety/ops; source separates token, client, access, outbound, status, and setup concerns.
- Bad qualities: OAuth token lifecycle, account/channel ID mapping, live IRC connection lifecycle, and setup-entry normalization remain fragile; docs rely on third-party token generators and manual credentials.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (66%)`
- Surface instructions: evaluated against `references/completeness/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Twitch bot account setup, Twitch IRC monitor/client lifecycle, Message tool send action.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No committed live Twitch run proves the full receive/reply loop.
- Token refresh, token persistence, and normalized account ID resolution need continued release-scenario proof.
- Access control uses Twitch user IDs and roles, which can be operator-hostile without stronger setup validation.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/twitch.md` lines 9-37 describe Twitch chat support via IRC and bundled plugin install behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/twitch.md` lines 37-90 document beginner setup, token generator scopes, config, access control, and minimal config.
- `/Users/kevinlin/code/openclaw/docs/channels/twitch.md` lines 97-179 document detailed setup, access control, token refresh, and refresh logging.
- `/Users/kevinlin/code/openclaw/docs/channels/twitch.md` lines 179-431 document multi-account support, troubleshooting, config reference, tool actions, safety/ops, limits, and related docs.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/twitch.md` declares `@openclaw/twitch` and the `twitch` channel surface.
- `/Users/kevinlin/code/openclaw/extensions/twitch/README.md` documents local/npm install, minimal config, setup, and full-doc pointers.

### Source

- `/Users/kevinlin/code/openclaw/extensions/twitch/openclaw.plugin.json` declares plugin id `twitch` and channel `twitch`.
- `/Users/kevinlin/code/openclaw/extensions/twitch/package.json` names the package `@openclaw/twitch`.
- `/Users/kevinlin/code/openclaw/extensions/twitch/src/plugin.ts`, `monitor.ts`, `twitch-client.ts`, `client-manager-registry.ts`, and `runtime.ts` implement lifecycle, monitor, client, and runtime behavior.
- `/Users/kevinlin/code/openclaw/extensions/twitch/src/token.ts`, `access-control.ts`, `status.ts`, `probe.ts`, and `config-schema.ts` implement credentials, access, status, probe, and config.
- `/Users/kevinlin/code/openclaw/extensions/twitch/src/outbound.ts`, `send.ts`, `actions.ts`, and `resolver.ts` implement outbound chat and action behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/twitch/src/plugin.live.test.ts` is a credential-gated live Twitch IRC verification guarded by `TWITCH_LIVE_TEST=1`.
- No committed live Twitch result artifact or QA scenario was found under `/Users/kevinlin/code/openclaw/qa`.

### Unit tests

- Twitch has 16 focused tests, including `access-control.test.ts`, `actions.test.ts`, `client-manager-registry.test.ts`, `config-schema.test.ts`, `config.test.ts`, `outbound.test.ts`, `plugin.lifecycle.test.ts`, `plugin.test.ts`, `probe.test.ts`, `send.test.ts`, `setup-surface.test.ts`, `status.test.ts`, `token.test.ts`, and `twitch-client.test.ts`.
- `/Users/kevinlin/code/openclaw/test/plugin-npm-package-manifest.test.ts`, `test/official-channel-catalog.test.ts`, and `test/plugin-npm-release.test.ts` include Twitch package/catalog/release coverage.

### Gitcrawl queries

Query: `twitch`

Results:

- `#55341` open PR: `Persist refreshed Twitch tokens and fix OpenProse fast-loop exits`.
- `#83885` open issue: `client.connect() not awaited - failed connection stored in clients map`.
- `#62387` open issue: most channels missing `namedAccountPromotionKeys`, causing multi-account promotion to strip shared defaults.
- `#86113` open issue: Channel Broker Phase 3.
- `#84560` open PR: CLI support for `--dm-policy` and `--dm-allowlist` in `channels add`.

Query: `Twitch chat OAuth token refresh setup`

Results:

- The exact query did not return focused top results; the simple `twitch` query and discrawl token queries returned current token/lifecycle evidence.

### Discrawl queries

Query: `twitch token`

Results:

- 2026-05-15 contributor message described a Twitch restart-loop fix after connect and gave live verification command using `TWITCH_LIVE_TEST=1`, `TWITCH_USERNAME`, `TWITCH_ACCESS_TOKEN`, `TWITCH_CLIENT_ID`, and `TWITCH_CHANNEL`.
- 2026-04-17 GitHub mirror review comment on PR `#68008` flagged token resolution alignment with normalized account IDs.

Query: `Twitch client connect`

Results:

- No displayed top results for that exact query; gitcrawl issue `#83885` is the stronger archive evidence for the `client.connect()` lifecycle concern.
