---
title: CLI - Plugin and Channel Setup Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# CLI - Plugin and Channel Setup Maturity Note

## Summary

The CLI supports guided plugin install sources, channel account setup, and
post-setup status and capability checks. Coverage is strong because there is a
large implementation and test surface, but quality is only moderate because
plugin installation and externalized channel behavior continue to create
operator confusion.

## Category Scope

This category covers plugin install sources, channel setup and account
configuration, and post-setup verification during or after onboarding. It does
not cover provider-model auth or non-channel plugin SDK authoring.

## Features

- Channel picker: Onboarding can guide the operator through choosing which channels to configure.
- Plugin install sources: Plugin setup supports bundled, npm, ClawHub, marketplace, git, and local install sources.
- Channel account setup: Channel commands support interactive and flag-driven account configuration for supported chat transports.
- Post-setup probes: Operators can probe channel status and capabilities after setup to verify that the configured account works.
- Remote gateway caveat: Remote onboarding documents that plugin installation does not happen locally when the gateway runs elsewhere.

## Archive Freshness

- gitcrawl: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `repository_count=2`, `api_supported=false`, `github_token_present=false`.
- discrawl: `generated_at=2026-05-30T01:10:41Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  - `docs/cli/onboard.md`, `docs/cli/plugins.md`, and `docs/cli/channels.md` describe plugin install sources, channel setup, and runtime verification.
  - Plugin install flows are implemented in `src/cli/plugins-install-command.ts` and `src/commands/onboarding-plugin-install.ts`.
  - Channel setup, status, capabilities, logs, and resolution flows are implemented in `src/commands/channels/add.ts`, `src/commands/channels/list.ts`, `src/commands/channels/status.ts`, `src/commands/channels/capabilities.ts`, and `src/commands/channels/resolve.ts`.
  - The repo contains broad plugin install and channel command tests.
- Negative signals:
  - The overall surface is broad and crosses package install state, config writes, and per-channel plugin behavior.
  - Externalized and optional channel plugins still create usability complexity.
- Integration gaps:
  - No single end-to-end onboarding smoke was found that installs an external channel plugin and then proves a complete account login and capability probe path.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  - Query `gitcrawl search issues "plugins install channels add channels status" -R openclaw/openclaw --state open --json number,title,url,state --limit 5` returned open hits including `#68782 Add selective installation for plugins, skills, and channels`, `#79738 u4s-openclaw restart rewrites openclaw.json and breaks WhatsApp allowFrom / owner config`, and `#78493 sudo openclaw update can create mixed ownership, then doctor overwrites config after EACCES/read failure`.
- Discrawl reports:
  - Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "plugins install channels add status"` surfaced release notes about plugin and channel repair work, plus user confusion around WhatsApp plugin install, channel discovery, and `channels status`.
- Good qualities:
  - The CLI supports several plugin source types instead of a single hidden path.
  - Channel commands expose setup, status, capability, and log surfaces rather than forcing manual config edits.
  - The plugin install CLI has extensive policy and edge-case tests.
- Bad qualities:
  - External channel plugin install and enablement rules are still hard for users to reason about.
  - Plugin/channel state spans config, install roots, and runtime registry refreshes, which increases drift risk.
- Excluded from quality:
  - Plugin install and channel command tests below are coverage evidence only.

## Known Gaps

- Full onboarding-to-live-account end-to-end proof for external channel plugins was not found.
- Externalized channel packaging and selective install semantics are still in flux.

## Evidence

### Docs

- `docs/cli/onboard.md`
- `docs/cli/plugins.md`
- `docs/cli/channels.md`

### Source

- `src/cli/plugins-install-command.ts`
- `src/commands/onboarding-plugin-install.ts`
- `src/commands/channels/add.ts`
- `src/commands/channels/list.ts`
- `src/commands/channels/status.ts`
- `src/commands/channels/capabilities.ts`
- `src/commands/channels/resolve.ts`

### Integration tests

- None found for a full external-plugin install plus live channel login flow.

### Unit tests

- `src/commands/onboarding-plugin-install.test.ts`
- `src/cli/plugins-cli.install.test.ts`
- `src/commands/channels.list.test.ts`
- `src/commands/channels.status.command-flow.test.ts`
- `src/commands/channels/capabilities.test.ts`
- `src/commands/channels.resolve.test.ts`

### Surface validation commands

- `none declared in taxonomy`: `pass` - CLI surface does not declare extra validation commands for scoring.

### Gitcrawl queries

Query:

- `gitcrawl search issues "plugins install channels add channels status" -R openclaw/openclaw --state open --json number,title,url,state --limit 5`

Results:

- `[{"number":68782,"state":"open","title":"Add selective installation for plugins, skills, and channels — reduce install size and startup overhead","url":"https://github.com/openclaw/openclaw/issues/68782"},{"number":79738,"state":"open","title":"u4s-openclaw restart rewrites openclaw.json and breaks WhatsApp allowFrom / owner config","url":"https://github.com/openclaw/openclaw/issues/79738"},{"number":86612,"state":"open","title":"Docker gateway container restart loop when OPENCLAW_SANDBOX=1 and OPENCLAW_HOME=/mnt/...","url":"https://github.com/openclaw/openclaw/issues/86612"},{"number":83223,"state":"open","title":"v2026.5.16-beta.5 audit: migrated openai/gpt-5.5 route still looks up openai-codex auth before fallback","url":"https://github.com/openclaw/openclaw/issues/83223"},{"number":78493,"state":"open","title":"sudo openclaw update can create mixed ownership, then doctor overwrites config after EACCES/read failure","url":"https://github.com/openclaw/openclaw/issues/78493"}]`

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "plugins install channels add status"`

Results:

- Release and support chatter shows active work on plugin/channel repair and repeated operator confusion around external plugin install, channel discovery, and `channels status` expectations.
