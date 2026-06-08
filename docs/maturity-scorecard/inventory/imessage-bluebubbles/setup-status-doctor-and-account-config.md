---
title: "iMessage / BlueBubbles - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles - Channel Setup and Operations Maturity Note

## Summary

Setup, status, doctor, and account configuration are Beta. The feature has a
clear source model for top-level and account-scoped config, duplicate local
source detection, status probes, and setup-policy edits. It remains below
Stable because the setup path ultimately has to validate real macOS and `imsg`
state, and there is no live setup lane covering the supported operator flows.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Setup and Host Runtime`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Translate legacy config: Covers Translate legacy config across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Cut over safely: Covers Cut over safely across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Handle migration caveats: Covers Handle migration caveats across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Run local imsg: Covers Run local imsg across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Run through SSH wrapper: Covers Run through SSH wrapper across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Grant macOS permissions: Covers Grant macOS permissions across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Probe runtime health: Covers Probe runtime health across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Account setup prompts: Covers setup prompts, policy writes, account merging, default account selection, and account configuration behavior for iMessage/BlueBubbles.
- Account status checks: Covers account status output, setup state, account merging, and default account selection for iMessage/BlueBubbles.
- Doctor repair checks: Covers doctor checks, setup repair prompts, and policy verification for iMessage/BlueBubbles account configuration.
- Account Config: Covers Account Config across setup prompts, policy writes, account merging, default account selection, and related setup, status, doctor, and account config behavior.
- Translate legacy config: Covers Translate legacy config across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist
- Cut over safely: Covers Cut over safely across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist
- Handle migration caveats: Covers Handle migration caveats across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist
- Run local imsg: Covers Run local imsg across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior
- Run through SSH wrapper: Covers Run through SSH wrapper across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior
- Grant macOS permissions: Covers Grant macOS permissions across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior
- Probe runtime health: Covers Probe runtime health across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior

## Features

- Translate legacy config: Covers Translate legacy config across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Cut over safely: Covers Cut over safely across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Handle migration caveats: Covers Handle migration caveats across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Run local imsg: Covers Run local imsg across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Run through SSH wrapper: Covers Run through SSH wrapper across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Grant macOS permissions: Covers Grant macOS permissions across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Probe runtime health: Covers Probe runtime health across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Account setup prompts: Covers setup prompts, policy writes, account merging, default account selection, and account configuration behavior for iMessage/BlueBubbles.
- Account status checks: Covers account status output, setup state, account merging, and default account selection for iMessage/BlueBubbles.
- Doctor repair checks: Covers doctor checks, setup repair prompts, and policy verification for iMessage/BlueBubbles account configuration.
- Account Config: Covers Account Config across setup prompts, policy writes, account merging, default account selection, and related setup, status, doctor, and account config behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - The docs include quick setup, status probe, remote setup, multi-account
    setup, troubleshooting, and config-reference entries.
  - Source has a setup adapter, account resolver, duplicate-source doctor,
    channel runtime startup, and per-account status/probe adapter.
  - Tests cover account inheritance, default account selection, duplicate
    watcher parking, doctor warnings, config schema, status lines, and probe
    behavior.
  - Gateway `channels.status` tests exercise plugin-provided iMessage probe
    integration.
- Negative signals:
  - Setup success depends on external `imsg`, macOS permissions, and signed-in
    user session state.
  - There is no single setup smoke that starts from empty config and reaches a
    real working iMessage monitor on a Mac.
  - Duplicate-source handling is robust in source, but operators still have to
    understand account ownership and rebinding.
- Integration gaps:
  - Add an install/setup/status smoke against a live or hermetic fake `imsg`
    binary that validates end-to-end setup prompts and `channels status`.
  - Add a multi-account remote wrapper scenario proving duplicate-source
    warnings and owner selection in an operational run.

## Quality Score

- Score: `Beta (73%)`
- Gitcrawl reports:
  - `channels.imessage allowFrom` returned #73822 for SecretRef phone-number config and #62387 for named account promotion key handling.
  - `iMessage channels status probe imsg private API` returned no direct hits in the latest gitcrawl pass.
- Discrawl reports:
  - `iMessage Full Disk Access Automation cliPath dbPath` returned a support thread where setup repair required hard-setting `cliPath` and `dbPath`.
  - Narrow query `iMessage channels status probe imsg private API` returned no snippets.
- Good qualities:
  - Account merging is explicit and supports account-scoped overrides without
    silently inheriting sibling state.
  - Duplicate local Messages sources are detected and converted into a single
    watcher owner instead of creating duplicate inbound replies.
  - Status/probe output is account-scoped and separates configured state from
    actual RPC/private API readiness.
  - Setup rejects DM `allowFrom` entries that are actually group/chat targets.
- Bad qualities:
  - The setup surface is broad enough that correct config can still fail due to
    external host state.
  - Account ownership warnings require operators to re-point bindings or disable
    unused duplicates.
  - Some config hardening still appears in adjacent archive issues.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence is recorded
    under Coverage only.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/imessage-bluebubbles.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Translate legacy config, Cut over safely, Handle migration caveats, Run local imsg, Run through SSH wrapper, Grant macOS permissions, Probe runtime health, Account setup prompts, Account status checks, Doctor repair checks, Account Config.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- End-to-end setup proof on a live Mac is missing.
- Account ownership is internally consistent but still operator-facing and
  subtle.
- Status can be healthy for the channel while action-specific private API
  capability is stale until reprobed.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:41`: quick setup verifies `imsg`, starts `imsg launch`, and runs `openclaw channels status --probe`.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:76`: first DM pairing approval is part of the default setup flow.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:399`: each account can point `cliPath` and `dbPath` to a specific user profile.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:442`: account overrides include `cliPath`, `dbPath`, allowlists, group policy, media limits, history settings, and attachment roots.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:777`: troubleshooting points operators back to `openclaw channels status --probe --channel imessage`.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:605`: config reference exposes `cliPath`.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:606`: config reference exposes `dbPath`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/setup-core.ts:62`: setup rejects chat-target style entries in DM `allowFrom`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/setup-core.ts:122`: setup writes `channels.imessage.dmPolicy`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/setup-core.ts:123`: setup writes `channels.imessage.allowFrom`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/accounts.ts:52`: account config detects account-specific behavior keys.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/accounts.ts:82`: duplicate local source handling is tied to openclaw/openclaw#65141.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/accounts.ts:178`: duplicate-source preview warning explains owner account and binding repair.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/channel.runtime.ts:82`: non-owner duplicate watcher slots are parked instead of started.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:92`: plugin reload boundary is `channels.imessage`.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/channels.status.test.ts:213`: status handler registers an iMessage plugin probe.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/channels.status.test.ts:225`: status payload includes iMessage channel order after probing.
- No live setup-to-Messages test was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/accounts.test.ts:12`: preserves top-level default account when named accounts are configured.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/accounts.test.ts:29`: uses configured `defaultAccount` when account id is omitted.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/accounts.test.ts:56`: flags default as a non-owner when a named account shares its source.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/doctor.test.ts:5`: doctor flags accounts sharing the local Messages source.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/channel.runtime.test.ts:42`: duplicate-source non-owner does not spawn the monitor.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/status.test.ts:138`: setup status lines use the selected account `cliPath`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/config-schema.test.ts:119`: accepts safe `remoteHost`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/config-schema.test.ts:127`: rejects unsafe `remoteHost`.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "channels.imessage allowFrom" --json --limit 6`

Results:

- Open issue #73822: SecretRef support for phone numbers in channel configs.
- Open issue #62387: named account promotion keys strip shared defaults.

Query:

`gitcrawl search openclaw/openclaw --query "iMessage channels status probe imsg private API" --json --limit 6`

Results:

- No direct hits in the latest pass.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage Full Disk Access Automation cliPath dbPath" --limit 6`

Results:

- A support thread advised adding Full Disk Access/Automation for the exact
  process running Gateway/`imsg`, then hard-setting `cliPath` and `dbPath`.

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage channels status probe imsg private API" --limit 6`

Results:

- No snippets returned.
