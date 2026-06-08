---
title: "Matrix - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Matrix - Channel Setup and Operations Maturity Note

## Summary

Matrix setup has a real bundled-plugin contract: manifest metadata, package
metadata, setup entrypoints, account-scoped config, environment shortcuts,
private-network controls, proxy settings, default account selection, invite
auto-join, allowlists, and encryption bootstrap are all represented in docs,
source, and tests. Coverage is Beta because there is broad setup and QA
evidence, but not a single live install matrix that exercises every account and
environment variant. Quality is Beta because the structure is mature but the
surface is broad and tied to active Matrix operational risk.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Setup and Repair`, `Runtime Lifecycle`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Matrix plugin identity: Matrix plugin identity, install metadata, runtime/setup entries, and account configuration.
- Setup wizard: Setup wizard, setup adapter, validation, post-write bootstrap, and account setup.
- Account discovery: Account discovery, default account rules, env-backed accounts, and stored account metadata.
- Matrix doctor warnings: Matrix doctor warnings, config normalization, and stale plugin config cleanup.
- Matrix probe/status: Matrix probe/status, live directory lookup, CLI diagnostics, and QA runtime status.
- Shared Matrix client resolution: Shared Matrix client resolution and active-client lifecycle
- Monitor startup: Monitor startup, sync status, fatal stop handling, task tracking, and event handler behavior.
- Startup maintenance: Startup maintenance for profile sync, verification checks, backup restore, and startup repair.
- Matrix doctor warnings: Covers Matrix doctor warnings, config normalization, stale plugin config cleanup behavior.
- Matrix probe/status: Covers Matrix probe/status, live directory lookup, CLI diagnostics, QA runtime behavior.
- Monitor startup: Monitor startup, sync status, fatal stop handling, task tracking, and event handler behavior
- Startup maintenance: Startup maintenance for profile sync, verification checks, backup restore, and startup repair

## Features

- Matrix plugin identity: Matrix plugin identity, install metadata, runtime/setup entries, and account configuration.
- Setup wizard: Setup wizard, setup adapter, validation, post-write bootstrap, and account setup.
- Account discovery: Account discovery, default account rules, env-backed accounts, and stored account metadata.
- Matrix doctor warnings: Matrix doctor warnings, config normalization, and stale plugin config cleanup.
- Matrix probe/status: Matrix probe/status, live directory lookup, CLI diagnostics, and QA runtime status.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - Docs cover install sources, setup flow, auth options, account-scoped env
    vars, invite auto-join defaults, allowlists, and multi-account defaults.
  - Source has manifest/package metadata, a typed config schema, account
    selection helpers, setup capabilities, setup wizard proxy, setup adapter,
    and post-write bootstrap.
  - Unit and runtime tests cover env shortcuts, account promotion, private
    network prompts, allowlists, stable invite targets, default account
    ambiguity, setup validation, and encryption bootstrap after setup.
  - Integration evidence includes the Matrix QA runtime injecting a temporary
    Matrix account and deriving DM plus multi-room gateway config.
- Negative signals:
  - I did not find one recurring live install or upgrade lane that exercises all
    setup variants together: ClawHub, npm, local source, stored credentials,
    env-backed credentials, named accounts, proxy, private-network opt-in,
    auto-join, and encryption bootstrap.
  - Narrow gitcrawl and discrawl setup queries returned no setup-specific issue
    hits, so archive evidence is not deep enough to prove real-world setup
    stability by itself.
- Integration gaps:
  - Add a live setup matrix covering install source, account mode, env/stored
    auth, proxy, private-network, auto-join, and encryption bootstrap.
  - Add a recurring upgrade scenario that starts from legacy top-level Matrix
    config and verifies account promotion plus default account selection.
  - Tie setup status output to gateway readiness checks after post-write
    bootstrap.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports:
  - Query `gitcrawl --json search openclaw/openclaw --query "matrix setup account config autoJoin"` returned no hits.
  - Query `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned broad Matrix operational hits, including open issues #68188 for configured Matrix messages not reaching the agent session and #83142 for mention parsing.
- Discrawl reports:
  - Query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix setup account config autoJoin"` returned no hits.
  - Broad query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"` returned release and scorecard discussion mentioning Matrix channel validation and the maturity-scorecard scoring approach.
- Good qualities:
  - Docs clearly separate install, setup, auth, account env vars, recovery key
    env vars, private/LAN homeserver opt-in, proxy, default account rules, and
    target resolution.
  - Config schema uses typed nested account/action/thread/approval/network
    structures instead of ad hoc keys.
  - Account selection fails closed when multiple accounts exist without an
    explicit default.
  - Setup code separates lazy setup loading from setup state mutation and
    post-write bootstrap.
- Bad qualities:
  - Setup is spread across docs, CLI, setup adapter, account resolution,
    env-backed credential discovery, and runtime bootstrap, which creates many
    operator-visible edge cases.
  - Broad Matrix archive reports show end-to-end configured-account failures are
    possible even when setup appears complete.
  - Private-network and proxy setup remain inherently risky because they touch
    SSRF policy and local-network reachability.
- Excluded from quality:
  - I did not raise or lower Quality because of unit, integration, e2e, live, or
    runtime test coverage.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/matrix.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Matrix plugin identity, Setup wizard, Account discovery, Matrix doctor warnings, Matrix probe/status.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a single setup QA report that maps install source, auth mode, account
  mode, network mode, auto-join, and encryption bootstrap to observed gateway
  readiness.
- Add scorecard evidence for ClawHub and npm setup behavior, not only source
  checkout behavior.
- Keep docs and config schema examples in lockstep for account-scoped env vars
  and recovery-key env vars.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:12` documents
  install from ClawHub, npm, or a local checkout.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:30` documents setup,
  auth choices, wizard flow, env shortcut, and E2EE bootstrap.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:81` documents
  `autoJoin` default-off behavior and invite allowlists.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:130` documents
  Matrix account env var naming and recovery-key env vars.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:710` documents
  multi-account and default account behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:758` documents
  private/LAN homeserver opt-in and proxy configuration.

### Source

- `/Users/kevinlin/code/openclaw/extensions/matrix/openclaw.plugin.json:1`
  declares the bundled Matrix plugin id, command alias, channel, env vars, and
  config schema.
- `/Users/kevinlin/code/openclaw/extensions/matrix/package.json:32` declares
  Matrix extension metadata, setup entry, channel docs path, capabilities,
  install specs, and release compatibility.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/config-schema.ts:14`
  defines Matrix action, thread binding, exec approval, room, network, and root
  config schema.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/account-selection.ts:139`
  resolves account ids, configured accounts, and default-account requirements.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/channel.setup.ts:12`
  exposes setup capabilities, reload behavior, and config schema hooks.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/setup-core.ts:45`
  implements the setup wizard proxy and setup adapter.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/accounts.ts:145`
  resolves account enablement, homeserver, user id, cached credentials, and
  account config.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/runtime.test.ts:202`
  verifies temporary Matrix account injection into QA gateway config.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/runtime.test.ts:275`
  verifies derived Matrix DM and multi-room config from provisioned topology.
- `/Users/kevinlin/code/openclaw/src/commands/agents.bind.matrix.integration.test.ts:21`
  verifies Matrix plugin binding resolution when account id is omitted.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/onboarding.test.ts:28`
  covers env shortcut setup for non-default accounts.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/onboarding.test.ts:70`
  covers env-shortcut setup through invite auto-join.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/onboarding.test.ts:317`
  covers allowlist and room access writes.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/onboarding.test.ts:477`
  covers default account prompts for multiple named accounts.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/setup-core.test.ts:284`
  covers switching an account to env-backed auth.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/setup-core.test.ts:412`
  covers private-network setup opt-in.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/channel.setup.test.ts:133`
  covers verification bootstrap for newly added encrypted accounts.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/account-selection.test.ts:44`
  covers explicit default requirements for multiple accounts.

### Gitcrawl queries

- `gitcrawl --json search openclaw/openclaw --query "matrix setup account config autoJoin"`
  returned no hits.
- `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned broad
  Matrix hits, including #68188, #83142, #73480, #85620, #87307, #81892,
  #80432, #76611, and related open PRs.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix setup account config autoJoin"`
  returned no hits.
- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"`
  returned release chatter referencing Matrix mention behavior and a maintainer
  discussion of the maturity-scorecard scoring approach.
