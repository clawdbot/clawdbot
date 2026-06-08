---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Decentralized Messaging Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Decentralized Messaging Maturity Note

## Summary

Nostr is Alpha. It is a documented optional bundled plugin for NIP-04 encrypted direct messages, relays, profile metadata, key formats, and security guidance. Source and tests cover Nostr bus behavior, encrypted inbound/outbound paths, profiles, relay state, and setup. It remains below Beta because live relay behavior and subscription lifetime have recent bug history, and the docs explicitly mark media and NIP-17/NIP-44 support as not yet implemented.

## Category Scope

Included in this category:

- Nostr key setup: Nostr key setup, relay configuration, profile metadata, private key handling, plugin install, and setup status
- NIP-04 encrypted DM receive/send: NIP-04 encrypted DM receive/send, event signature verification, sender policy, relay bus, duplicate/seen tracking, local relay testing, and state storage
- Profile import/publish: Profile import/publish, relay URL safety, metrics, session routing, and limitations around media and newer encrypted DM protocols
- Tlon/Urbit ship URL/code setup: Tlon/Urbit ship URL/code setup, private network opt-in, group channel config, owner ship, allowlists, auto-accept, and setup/doctor behavior
- Urbit API auth/session: Urbit API auth/session, SSE monitor, DM/group discovery, group mention handling, thread replies, approvals, processed message tracking, and settings helpers
- Rich text conversion: Rich text conversion, image upload through Tlon storage/Memex, delivery targets, bundled Tlon skill, security, and troubleshooting

## Features

- Nostr key setup: Nostr key setup, relay configuration, profile metadata, private key handling, plugin install, and setup status
- NIP-04 encrypted DM receive/send: NIP-04 encrypted DM receive/send, event signature verification, sender policy, relay bus, duplicate/seen tracking, local relay testing, and state storage
- Profile import/publish: Profile import/publish, relay URL safety, metrics, session routing, and limitations around media and newer encrypted DM protocols
- Tlon/Urbit ship URL/code setup: Tlon/Urbit ship URL/code setup, private network opt-in, group channel config, owner ship, allowlists, auto-accept, and setup/doctor behavior
- Urbit API auth/session: Urbit API auth/session, SSE monitor, DM/group discovery, group mention handling, thread replies, approvals, processed message tracking, and settings helpers
- Rich text conversion: Rich text conversion, image upload through Tlon storage/Memex, delivery targets, bundled Tlon skill, security, and troubleshooting

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (62%)`
- Positive signals: docs cover keys, relays, DM policy, allowlists, profile metadata, protocol support, local relay testing, troubleshooting, and security; tests include Nostr bus integration-style coverage and fuzz tests.
- Negative signals: no committed live public-relay or local-relay run was found; subscription lifetime and restart-loop issues are current archive concerns.
- Integration gaps: setup-to-relay subscription, encrypted inbound DM, encrypted outbound reply, relay reconnection, duplicate suppression, and profile import/publish are not proven as a recurring live scenario.

## Quality Score

- Score: `Alpha (58%)`
- Gitcrawl reports: current results include `#53858` restart loop, `#87457` keeping DM subscriptions alive until abort, `#72216` setup status scope fix, `#63673` no inbound messages after update, and broader channel broker work.
- Discrawl reports: 2026-05-28 contributor message described PR `#87457` for Nostr DM subscription lifecycle on strict relays; 2026-03-26 issue `#55409` described WebSocket subscriptions closing immediately and restart loops; archive review also referenced relay URL validation and private-key-state cleanup.
- Good qualities: docs clearly warn about private keys, supported NIPs, relay redundancy, duplicate responses, and the sender-policy-before-decrypt flow; source has separate key, profile, relay bus, seen tracker, and state-store modules.
- Bad qualities: Nostr relay behavior is decentralized and high variance, strict relay subscription handling has active fixes, relay URL validation has stale PR history, and NIP-17/NIP-44/media are not part of the current contract.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (62%)`
- Surface instructions: evaluated against `references/completeness/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Nostr key setup, NIP-04 encrypted DM receive/send, Profile import/publish, Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No recurring relay-backed live scenario is checked in.
- NIP-17 gift-wrapped DMs, NIP-44 versioned encryption, and media attachments are documented as not yet supported.
- Relay URL validation, strict-relay subscription lifetime, and restart behavior need stronger operational hardening.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/nostr.md` lines 9-48 describe optional bundled plugin status, install, and non-interactive setup.
- `/Users/kevinlin/code/openclaw/docs/channels/nostr.md` lines 48-87 document quick setup, private key, relays, DM policy, allowFrom, and profile config.
- `/Users/kevinlin/code/openclaw/docs/channels/nostr.md` lines 89-187 document profile metadata, access control, key formats, relay guidance, and protocol support.
- `/Users/kevinlin/code/openclaw/docs/channels/nostr.md` lines 187-245 document local relay testing, manual testing, troubleshooting, security, and limitations.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/nostr.md` declares `@openclaw/nostr` and the `nostr` channel surface.
- `/Users/kevinlin/code/openclaw/extensions/nostr/README.md` repeats the NIP-04 DM scope, local relay testing, protocol table, and security notes.

### Source

- `/Users/kevinlin/code/openclaw/extensions/nostr/openclaw.plugin.json` declares plugin id `nostr` and channel `nostr`.
- `/Users/kevinlin/code/openclaw/extensions/nostr/package.json` names the package `@openclaw/nostr`.
- `/Users/kevinlin/code/openclaw/extensions/nostr/src/nostr-bus.ts`, `inbound-direct-dm-runtime.ts`, `seen-tracker.ts`, and `nostr-state-store.ts` implement relay bus, inbound DM runtime, duplicate tracking, and state.
- `/Users/kevinlin/code/openclaw/extensions/nostr/src/nostr-key-utils.ts`, `nostr-profile.ts`, `nostr-profile-http.ts`, `nostr-profile-import.ts`, and `nostr-profile-url-safety.ts` implement key/profile handling and profile URL safety.
- `/Users/kevinlin/code/openclaw/extensions/nostr/src/channel.ts`, `channel.setup.ts`, `setup-adapter.ts`, `setup-surface.ts`, and `session-route.ts` implement channel runtime, setup, and routing.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/nostr/src/nostr-bus.integration.test.ts` provides local integration-style coverage of bus behavior, but no committed live public-relay run was found.
- No Nostr QA scenario was found under `/Users/kevinlin/code/openclaw/qa`.

### Unit tests

- Nostr has 13 focused tests, including `channel.inbound.test.ts`, `channel.lifecycle.test.ts`, `channel.outbound.test.ts`, `channel.test.ts`, `nostr-bus.fuzz.test.ts`, `nostr-bus.inbound.test.ts`, `nostr-bus.test.ts`, `nostr-profile-http.test.ts`, `nostr-profile-import.test.ts`, `nostr-profile.fuzz.test.ts`, `nostr-profile.test.ts`, and `nostr-state-store.test.ts`.

### Gitcrawl queries

Query: `nostr`

Results:

- `#72216` open PR: `fix(nostr): keep setup status off full surface`.
- `#53858` open issue: `Nostr channel restart loop - provider starts and immediately stops without error`.
- `#87457` open PR: `fix(nostr): keep DM subscriptions alive until abort`.
- `#63673` open issue: `Keychat Bridge receives no inbound messages after OpenClaw update to 2026.4.8`.

Query: `Nostr bug relay NIP-04 duplicate private key`

Results:

- The exact query did not return focused top results, but the simple `nostr` query and discrawl relay/restart queries returned the relevant Nostr subscription and key-history evidence.

### Discrawl queries

Query: `nostr relay`

Results:

- 2026-05-28 contributor message linked PR `#87457` for Nostr DM subscription lifecycle, strict-relay startup/restart, and cleanup on shutdown.
- 2026-04-26 archive review kept relay URL validation PR `#39748` open because current main still allowed broad relay config and direct runtime use.
- 2026-04-24 archive review closed private-key-in-state issue `#12545` as implemented after state-store cleanup.

Query: `Nostr restart loop`

Results:

- 2026-03-26 issue `#55409` reported WebSocket subscriptions closing immediately with timeouts/connection errors and an infinite restart loop.
- 2026-03-25 comment on issue `#53858` reported a root cause in bundled `nostr-tools` subscription handling.
