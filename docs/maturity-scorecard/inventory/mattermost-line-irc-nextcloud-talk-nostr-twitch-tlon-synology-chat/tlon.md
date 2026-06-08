---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Tlon Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Tlon Maturity Note

## Summary

Tlon is Alpha. It is a bundled Tlon/Urbit plugin with docs for ship setup, private/LAN ships, group channels, owner approval, auto-accept, delivery targets, bundled skill, rich text, images, and troubleshooting. Source covers Urbit auth, SSE, channel operations, send/upload, monitor settings, approvals, discovery, media, and processed-message tracking. It remains Alpha because there is no committed live ship scenario, archive evidence shows thread-routing and private-network complexity, and reactions/polls are explicitly not supported.

## Category Scope

- Tlon/Urbit ship URL/code setup, private network opt-in, group channel config, owner ship, allowlists, auto-accept, and setup/doctor behavior.
- Urbit API auth/session, SSE monitor, DM/group discovery, group mention handling, thread replies, approvals, processed message tracking, and settings helpers.
- Rich text conversion, image upload through Tlon storage/Memex, delivery targets, bundled Tlon skill, security, and troubleshooting.

## Features

- Tlon/Urbit ship URL/code setup: Tlon/Urbit ship URL/code setup, private network opt-in, group channel config, owner ship, allowlists, auto-accept, and setup/doctor behavior
- Urbit API auth/session: Urbit API auth/session, SSE monitor, DM/group discovery, group mention handling, thread replies, approvals, processed message tracking, and settings helpers
- Rich text conversion: Rich text conversion, image upload through Tlon storage/Memex, delivery targets, bundled Tlon skill, security, and troubleshooting

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals: docs and source cover setup, private ships, groups, owner approvals, auto-accept, delivery targets, Tlon skill, rich text, images, troubleshooting, doctor, Urbit auth, SSE, send, and upload.
- Negative signals: no committed live Urbit/Tlon ship proof was found; runtime behavior is proven mainly through unit/mocked API tests.
- Integration gaps: login, SSE receive, DM invite auto-accept, group invite auto-accept, group mention dispatch, thread reply routing, image upload, and owner approval are not proven in a recurring real-ship scenario.

## Quality Score

- Score: `Alpha (63%)`
- Gitcrawl reports: current `tlon` search was noisy and sparse, returning broader private-network and channel-broker items rather than many focused Tlon reports; this does not count as a positive signal.
- Discrawl reports: 2026-04-23 review comment warned that treating only Slack/Mattermost/Google Chat as thread-based could break Tlon outbound thread routing across multi-payload sends; support output lists Tlon as a decentralized Urbit channel during setup.
- Good qualities: docs are explicit about private network opt-in, owner ship behavior, auto-accept settings, group mention requirements, unsupported reactions/polls, rich text, and image upload behavior; source separates Urbit auth and upload URL safety from the higher-level monitor path.
- Bad qualities: Urbit/Tlon deployment is intrinsically specialized, private/LAN ship support requires risky opt-ins, and thread routing, invite handling, and owner approval semantics are complex.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No recurring live Tlon/Urbit ship scenario is checked in.
- Reactions and polls are documented as unsupported.
- Private-network ship support, group discovery, thread routing, and image upload need operator-proof artifacts before Beta.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/tlon.md` lines 8-15 describe Tlon/Urbit support status, DMs, group mentions, thread replies, rich text, images, and unsupported reactions/polls.
- `/Users/kevinlin/code/openclaw/docs/channels/tlon.md` lines 40-90 document setup and private/LAN ship behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/tlon.md` lines 92-207 document group channels, access control, owner approval, and auto-accept settings.
- `/Users/kevinlin/code/openclaw/docs/channels/tlon.md` lines 209-290 document delivery targets, bundled skill, capabilities, troubleshooting, configuration reference, and notes.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/tlon.md` declares `@openclaw/tlon` and the `tlon` channel surface.
- `/Users/kevinlin/code/openclaw/extensions/tlon/README.md` summarizes the plugin as supporting DMs, group mentions, and thread replies.

### Source

- `/Users/kevinlin/code/openclaw/extensions/tlon/openclaw.plugin.json` declares plugin id `tlon` and channel `tlon`.
- `/Users/kevinlin/code/openclaw/extensions/tlon/package.json` names the package `@openclaw/tlon`.
- `/Users/kevinlin/code/openclaw/extensions/tlon/src/urbit/auth.ts`, `base-url.ts`, `sse-client.ts`, `channel-ops.ts`, `send.ts`, and `upload.ts` implement Urbit auth, URL handling, SSE, operations, send, and upload.
- `/Users/kevinlin/code/openclaw/extensions/tlon/src/monitor/index.ts`, `authorization.ts`, `approval.ts`, `approval-runtime.ts`, `discovery.ts`, `history.ts`, `media.ts`, `processed-messages.ts`, and `settings-helpers.ts` implement monitor behavior.
- `/Users/kevinlin/code/openclaw/extensions/tlon/src/channel.ts`, `channel.runtime.ts`, `setup-core.ts`, `setup-surface.ts`, `doctor.ts`, `security.ts`, and `session-route.ts` implement channel runtime, setup, doctor, security, and routing.

### Integration tests

- No committed live Urbit/Tlon ship scenario was found under `/Users/kevinlin/code/openclaw/qa` or `/Users/kevinlin/code/openclaw/test`.
- `/Users/kevinlin/code/openclaw/extensions/tlon/src/tlon-api.test.ts`, `urbit/sse-client.test.ts`, `urbit/send.test.ts`, and `urbit/upload.test.ts` use mocked HTTP/SSE/upload behavior rather than a real ship.

### Unit tests

- Tlon has 15 focused tests, including `channel.message-adapter.test.ts`, `core.test.ts`, `doctor.test.ts`, `monitor/approval.test.ts`, `monitor/media.test.ts`, `monitor/processed-messages.test.ts`, `monitor/settings-helpers.test.ts`, `security.test.ts`, `tlon-api.test.ts`, `urbit/auth.ssrf.test.ts`, `urbit/base-url.test.ts`, `urbit/channel-ops.test.ts`, `urbit/send.test.ts`, `urbit/sse-client.test.ts`, and `urbit/upload.test.ts`.

### Gitcrawl queries

Query: `tlon`

Results:

- `#39604` open issue: private-network fetch allowlist feature, relevant to private/LAN ship support.
- `#86113` open issue: Channel Broker Phase 3, relevant to future channel framework migration.
- Other top results were broad or unrelated to Tlon-specific behavior.

Query: `Tlon Urbit ship setup group DM image upload`

Results:

- No focused top results were returned for this exact query.

### Discrawl queries

Query: `tlon urbit`

Results:

- 2026-04-23 review comment warned that Tlon thread routing could be lost across multi-payload sends when outbound core treated only Slack/Mattermost/Google Chat as thread-based channels.
- 2026-04-19 setup support output listed Tlon as a decentralized Urbit messaging channel in channel selection.

Query: `Tlon group`

Results:

- 2026-05-07 channel ingress refactor note named Tlon ship mentions as plugin-owned facts in the broader channel authorization migration.
