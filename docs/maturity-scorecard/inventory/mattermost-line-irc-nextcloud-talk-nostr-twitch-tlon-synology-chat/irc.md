---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - IRC Chat Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - IRC Chat Maturity Note

## Summary

IRC is Alpha. It is bundled and has clear docs for host/nick setup, TLS, DM and group policy, mention gating, channel sender allowlists, NickServ, environment variables, and troubleshooting. Source and tests cover the important local contracts, but there is no recurring live IRC-network proof and archive evidence still includes NickServ/login confusion and broader ingress-refactor pressure around duplicated channel auth trees.

## Category Scope

Included in this category:

- IRC server/nick/TLS/NickServ setup: IRC server/nick/TLS/NickServ setup, env/config loading, account resolution, and plugin runtime setup
- Raw IRC receive/send: Raw IRC receive/send, direct messages, channel messages, sender identity normalization, control-character handling, access policy, mention gating, and tools-by-sender policy
- Probe/status: Probe/status, outbound text normalization, reconnect/monitor lifecycle, and security defaults around direct IRC egress
- Twitch bot account setup: Twitch bot account setup, OAuth access/refresh tokens, client ID/secret, channel join config, multi-account config, and package/bundled install behavior
- Twitch IRC monitor/client lifecycle: Twitch IRC monitor/client lifecycle, token refresh, status/probe, access control by user ID/roles, requireMention, and outbound chat delivery
- Message tool send action: Message tool send action, moderation-oriented action surface, safety/ops, and troubleshooting

## Features

- IRC server/nick/TLS/NickServ setup: IRC server/nick/TLS/NickServ setup, env/config loading, account resolution, and plugin runtime setup
- Raw IRC receive/send: Raw IRC receive/send, direct messages, channel messages, sender identity normalization, control-character handling, access policy, mention gating, and tools-by-sender policy
- Probe/status: Probe/status, outbound text normalization, reconnect/monitor lifecycle, and security defaults around direct IRC egress
- Twitch bot account setup: Twitch bot account setup, OAuth access/refresh tokens, client ID/secret, channel join config, multi-account config, and package/bundled install behavior
- Twitch IRC monitor/client lifecycle: Twitch IRC monitor/client lifecycle, token refresh, status/probe, access control by user ID/roles, requireMention, and outbound chat delivery
- Message tool send action: Message tool send action, moderation-oriented action surface, safety/ops, and troubleshooting

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals: docs and source cover quick setup, security defaults, access control, mention gating, public-channel warnings, tools-by-sender, NickServ, env vars, and troubleshooting; extension tests cover accounts, client, config schema, connect options, inbound behavior, monitor, policy, protocol, probe, send, and setup.
- Negative signals: there is no checked-in live IRC network scenario; many proofs are local mocks or parser/unit coverage.
- Integration gaps: real server connect, TLS/SASL/NickServ variants, reconnect, channel join, direct message, mention-gated channel reply, and public-network guardrails are not proven in a recurring runtime flow.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: query results include `#55901` for markdown via draft/multiline, `#56283` for stripping markdown for plain-text channels, `#86039/#86166` around bundled channel setup fallback warnings, and broader channel broker/ingress work.
- Discrawl reports: a 2026-03-09 archive comment on issue `#26059` showed IRC login/NickServ confusion around nickname already in use and password formatting; 2026-05-07 maintainer notes described channel ingress auth duplication that explicitly mentions IRC mention facts.
- Good qualities: docs are explicit about direct IRC egress, TLS, mutable nick matching, channel-vs-sender gates, and mention-gating logs; source separates normalization, policy, protocol, and send paths.
- Bad qualities: IRC identity is inherently mutable, network behavior varies by server, NickServ setup is fragile, and the raw TCP/TLS transport sits outside operator-managed forward proxy routing.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for IRC server/nick/TLS/NickServ setup, Raw IRC receive/send, Probe/status, Twitch bot account setup, Twitch IRC monitor/client lifecycle, Message tool send action.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No recurring live IRC network proof for TLS, NickServ, channel join, reconnect, DM, group message, and mention-gating.
- Operator docs warn about mutable nick matching and public-channel risk, but there is no scenario report proving safe defaults on public networks.
- Channel ingress semantics are implemented locally and likely need parity work with the broader shared ingress refactor.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/irc.md` lines 9-32 document quick start, host, port, nick, TLS, channel, and policy config.
- `/Users/kevinlin/code/openclaw/docs/channels/irc.md` lines 40-63 document security defaults, direct egress, DM/group policy, TLS, stable identities, and mutable nick matching.
- `/Users/kevinlin/code/openclaw/docs/channels/irc.md` lines 65-187 document channel access, sender allowlists, mention gating, public-channel warnings, tools-by-sender, and group behavior links.
- `/Users/kevinlin/code/openclaw/docs/channels/irc.md` lines 189-245 document NickServ, environment variables, and troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/irc.md` declares `@openclaw/irc` and the `irc` channel surface.

### Source

- `/Users/kevinlin/code/openclaw/extensions/irc/openclaw.plugin.json` declares plugin id `irc` and channel `irc`.
- `/Users/kevinlin/code/openclaw/extensions/irc/package.json` names the package `@openclaw/irc`.
- `/Users/kevinlin/code/openclaw/extensions/irc/src/channel-runtime.ts`, `monitor.ts`, `client.ts`, `protocol.ts`, `inbound.ts`, and `send.ts` implement runtime monitor, protocol, receive, and send behavior.
- `/Users/kevinlin/code/openclaw/extensions/irc/src/policy.ts`, `normalize.ts`, `control-chars.ts`, `connect-options.ts`, and `accounts.ts` implement identity, policy, and connection setup.
- `/Users/kevinlin/code/openclaw/extensions/irc/src/probe.ts`, `doctor.ts`, `setup-core.ts`, and `setup-surface.ts` implement status/doctor/setup surfaces.

### Integration tests

- No committed live IRC server e2e or QA scenario was found under `/Users/kevinlin/code/openclaw/qa` or `/Users/kevinlin/code/openclaw/test`.
- `/Users/kevinlin/code/openclaw/test/vitest/vitest.extension-irc.config.ts` defines a scoped IRC extension test lane, but it is not a live network scenario.
- `/Users/kevinlin/code/openclaw/extensions/irc/src/inbound.behavior.test.ts`, `monitor.test.ts`, and `runtime-api.test.ts` cover runtime-adjacent behavior with local test doubles.

### Unit tests

- IRC has 16 focused tests, including `accounts.test.ts`, `channel.test.ts`, `client.test.ts`, `config-schema.test.ts`, `connect-options.test.ts`, `control-chars.test.ts`, `normalize.test.ts`, `policy.test.ts`, `probe.test.ts`, `protocol.test.ts`, `send.test.ts`, and `setup.test.ts`.

### Gitcrawl queries

Query: `irc`

Results:

- `#55901` open PR: `feat(irc): support markdown messages via draft/multiline`.
- `#86039` open issue: bundled channel setup entries emit warnings when generated modules are missing, ignoring disabled config.
- `#86166` open PR: `fix #86039: skip disabled bundled setup fallbacks`.
- `#56283` open PR: `feat(outbound): strip markdown for plain-text channels`.
- `#69926` open issue references per-group allowFrom parity with IRC/LINE/Telegram/Nextcloud Talk.

Query: `IRC channel setup nickserv tls mention allowlist`

Results:

- The displayed top results were sparse for this exact query; the simple `irc` query returned the useful current IRC-linked items above.

### Discrawl queries

Query: `IRC nickserv tls`

Results:

- 2026-03-09 GitHub mirror comment on issue `#26059` described IRC login failure `433` nickname already in use and an operator workaround using `nickname:password` plus NickServ config.

Query: `IRC channel missing mention`

Results:

- 2026-05-07 maintainer note on the channel ingress refactor explicitly called out plugin-owned IRC nick mentions and repeated local authorization trees as an area needing core AccessGraph parity.
