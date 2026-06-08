---
title: "Microsoft Teams - Sso, Delegated Auth, Graph Directory, and Member Info Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams - Sso, Delegated Auth, Graph Directory, and Member Info Maturity Note

## Summary

Teams Graph and delegated-auth support is important for enterprise use, but it
is still evidence-light. Source covers Bot Framework SSO, delegated OAuth token
storage/refresh, Graph token resolution, directory search, member-info, and
Graph role/scope probing. Coverage and Quality stay Alpha because these flows
depend on tenant app registration, admin consent, and cross-tenant Graph
configuration that lack durable scenario proof and still have active archive
work.

## Category Scope

This category covers Bot Framework SSO invokes, OAuth token exchange,
delegated token storage and refresh, Graph app token resolution, Graph scopes
and roles, directory peer/group listing, Graph user search, member-info action,
cross-tenant Graph access, and China Graph limitations.

## Features

- Bot Framework SSO invokes: Covers Bot Framework SSO invoke handling and OAuth token exchange for Microsoft Teams users.
- Delegated token storage: Covers delegated token storage, token refresh, and recovery for Microsoft Teams user auth.
- Graph directory lookup: Covers Graph app token resolution and directory lookup behavior for Teams routing and user metadata.
- Member profile lookup: Covers member info lookup and user metadata retrieval for Microsoft Teams conversations.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (60%)`
- Positive signals: Docs and source cover SSO configuration, delegated auth,
  Graph tokens, directory listing, member-info, Graph role/scope probes, and
  admin-consent prerequisites.
- Negative signals: No live Teams SSO, delegated consent, member-info, or
  cross-tenant Graph scenario was found.
- Integration gaps: Missing proof for successful token exchange, missing
  consent, expired delegated tokens, admin consent grants, cross-tenant Graph,
  and Graph-disabled China behavior.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: Broad search returned `#78839` member-info action gate,
  `#77784` delegated auth for plugin tools, `#67174/#87169` separate Teams
  Graph tenant work, and review comments about federated Graph auth.
- Discrawl reports: Focused SSO/delegated-auth query returned no lines; broad
  search returned Teams SDK migration discussion and member/context concerns.
- Good qualities: SSO invoke handling is auth-gated, tokens are persisted with
  connection metadata, probes report Graph roles/scopes, and directory/member
  actions are separated behind runtime adapters.
- Bad qualities: Graph behavior depends on tenant admin state, permissions,
  cross-tenant configuration, and cloud endpoints; active archive work shows
  this surface is still moving.
- Excluded from quality: Unit-test breadth, directory mock coverage, and lack
  of live SSO tests.

## Completeness Score

- Score: `Alpha (60%)`
- Surface instructions: evaluated against `references/completeness/microsoft-teams.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bot Framework SSO invokes, Delegated token storage, Graph directory lookup, Member profile lookup.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live enterprise scenario for Bot Framework SSO token exchange and
  delegated Graph token use.
- Add scenarios for missing admin consent, expired delegated tokens, and
  cross-tenant Graph tenant configuration.
- Add documented China/21Vianet behavior for disabled Graph helpers.

## Evidence

### Docs

- `docs/channels/msteams.md` documents federated authentication, Graph
  permissions, member-info requirements, Graph-enabled media/history, delegated
  auth-related configuration, Graph role/scope probe output, and China Graph
  limitations.

### Source

- `src/config/types.msteams.ts` defines `delegatedAuth` and `sso` config.
- `extensions/msteams/src/monitor.ts` registers sign-in invoke handlers,
  delegates through SDK handlers, and persists SSO tokens after authorized
  sign-in events.
- `extensions/msteams/src/sso.ts` handles Bot Framework token exchange and
  verify-state flows.
- `extensions/msteams/src/sso-token-store.ts` persists SSO token metadata.
- `extensions/msteams/src/oauth.ts`, `oauth.flow.ts`, `oauth.token.ts`, and
  `token.ts` implement delegated OAuth, local callback, token refresh, and
  delegated token storage.
- `extensions/msteams/src/graph.ts` resolves Graph tokens.
- `extensions/msteams/src/directory-live.ts`, `graph-users.ts`,
  `graph-members.ts`, and `channel.runtime.ts` implement directory and
  member-info runtime adapters.
- `extensions/msteams/src/probe.ts` reports Graph roles/scopes and delegated
  token status.

### Integration tests

- No Teams live SSO/delegated-auth/member-info scenario was found by `rg`.
- `directory-live.test.ts` is mocked and does not prove a real Graph tenant.

### Unit tests

- `extensions/msteams/src/monitor-handler.sso.test.ts` and
  `monitor.lifecycle.test.ts` cover sign-in invoke auth gates and routing.
- `extensions/msteams/src/sso-token-store.test.ts` covers token storage.
- `extensions/msteams/src/oauth.test.ts` covers delegated OAuth helpers.
- `extensions/msteams/src/graph.test.ts` covers Graph token behavior.
- `extensions/msteams/src/directory-live.test.ts`,
  `graph-users.test.ts` if present, and `graph-members.test.ts` cover mocked
  directory/member flows.
- `extensions/msteams/src/probe.test.ts` covers probe output.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "msteams SSO delegated auth Graph tenant member-info" --json --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams Microsoft Teams" --json --limit 10`

Results:

- The focused SSO/delegated-auth query returned `[]`.
- The broad search returned `#78839`, `#77784`, `#67174`, and `#87169` covering
  member-info, delegated auth, and Graph tenant work.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams SSO delegated auth Graph tenant member-info"`

Results:

- The focused query returned no lines.
