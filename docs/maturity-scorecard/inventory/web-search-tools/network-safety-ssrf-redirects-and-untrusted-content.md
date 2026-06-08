---
title: "Web search tools - Network Safety Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Web search tools - Network Safety Maturity Note

## Summary

This note migrates archived maturity evidence for `Web search tools` / `Network Safety, Ssrf, Redirects, and Untrusted Content` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- Network Safety: Defines Network Safety authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.
- SSRF: Defines SSRF authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.
- Redirects: Defines Redirects authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.
- Untrusted Content: Defines Untrusted Content authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.

## Features

- Network Safety: Defines Network Safety authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.
- SSRF: Defines SSRF authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.
- Redirects: Defines Redirects authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.
- Untrusted Content: Defines Untrusted Content authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`

Coverage is Stable because docs and source cover SSRF policy, guarded fetch, fake-IP allowlists, redirect rechecks, self-hosted endpoint policy, trusted env proxy, citation redirects, and external untrusted content wrapping. The score is limited by active requests around private-network opt-in, IPv6 special-use handling, exec parity, and fetched-content injection hardening.

## Quality Score

- Score: `Stable (84%)`

Quality is Stable because safety controls are centralized and conservative: network access routes through guarded fetch, DNS and redirect behavior are rechecked, private/internal hosts are blocked by default, and fetched/search content is explicitly marked untrusted. Remaining risk sits in policy exceptions, local/private network opt-ins, and provider-specific bypass requirements.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/web-search-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Network Safety, SSRF, Redirects, Untrusted Content.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/web.md:156` documents guarded fetch behavior, fake-IP allowlists, private/metadata blocking, and redirect rechecks.
- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:40` documents private/internal blocks and redirect rechecks.
- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:146` documents trusted env proxy and limits.
- `/Users/kevinlin/code/openclaw/docs/tools/firecrawl.md:139` documents Firecrawl safety considerations.
- `/Users/kevinlin/code/openclaw/docs/tools/searxng-search.md:112` documents SearXNG self-hosted endpoint configuration.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/tools/web-guarded-fetch.ts:13` defines self-hosted endpoint policy.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-guarded-fetch.ts:41` chooses strict or trusted-env guarded fetch behavior.
- `/Users/kevinlin/code/openclaw/src/infra/net/fetch-guard.ts:383` implements redirect loops with policy checks.
- `/Users/kevinlin/code/openclaw/src/infra/net/fetch-guard.ts:500` pins DNS results.
- `/Users/kevinlin/code/openclaw/src/infra/net/fetch-guard.ts:594` logs SSRF blocks.
- `/Users/kevinlin/code/openclaw/src/infra/net/ssrf.ts:185` implements fake-IP hostname allowlists.
- `/Users/kevinlin/code/openclaw/src/infra/net/ssrf.ts:294` blocks private and special-use IPs.
- `/Users/kevinlin/code/openclaw/src/infra/net/ssrf.ts:535` pins and rechecks DNS.
- `/Users/kevinlin/code/openclaw/src/security/external-content.ts:13` marks web content as externally untrusted.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search-citation-redirect.ts:1` resolves citation redirects through guarded HEAD requests.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/web-fetch.md:11` covers web_fetch runtime behavior with failure modes.
- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/web-search.md:11` covers web_search runtime behavior with failure modes.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.ssrf.test.ts:103` covers web_fetch SSRF protections.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search.redirect.test.ts:23` covers citation redirect behavior.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch-visibility.test.ts:214` covers visibility behavior around fetched content.
- `/Users/kevinlin/code/openclaw/extensions/firecrawl/src/firecrawl-tools.test.ts:606` covers Firecrawl URL safety cases.
- `/Users/kevinlin/code/openclaw/extensions/searxng/src/searxng-client.test.ts:160` covers SearXNG endpoint safety behavior.
- `/Users/kevinlin/code/openclaw/extensions/google/web-search-provider.test.ts:253` covers Gemini redirect handling.

### Gitcrawl queries

Freshness: `gitcrawl doctor --json` reported version `0.2.1`, `last_sync_at` `2026-05-28T19:09:52.784704Z`, `29,810` threads, `11,181` open threads, and `18,594` clusters.

- `gitcrawl --json search issues -R openclaw/openclaw "SSRF web_fetch"` returned #39604 private-network opt-in, #76260 exec parity with web_fetch SSRF block, #39685 egress firewall, #41993 IPv6 special-use failures, and #87505 timeout regression.
- `gitcrawl --json search prs -R openclaw/openclaw "web_fetch"` returned #67421 per-agent SSRF policy, #39630 allowPrivateNetwork, #87758 fetched-content injection hardening, #55485 SSRF policy, and #61961 related safety work.
- `gitcrawl --json search prs -R openclaw/openclaw "provider-web-search"` returned #85317 Gemini SSRF private-network bypass and #87758 fetched-content injection hardening.

### Discrawl queries

Freshness: `discrawl status --json` reported state `current`, `generated_at` `2026-05-29T17:44:19Z`, `last_sync_at` `2026-05-29T15:59:50Z`, `1,487,061` messages, `25,819` channels, and zero embedding backlog.

- `discrawl search --mode hybrid --limit 12 "web_fetch ssrf private internal redirect injection"` found support guidance that web_fetch is safer than exec/browser automation but remains high risk because it pulls untrusted external content, blocks private/internal hosts, and rechecks redirects.
