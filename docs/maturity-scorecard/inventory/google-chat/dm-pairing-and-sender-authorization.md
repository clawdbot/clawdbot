---
title: "Google Chat - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat - Access and Identity Maturity Note

## Summary

Direct-message access is one of the stronger Google Chat subareas. The docs describe pairing and stable target formats, and the source uses the shared channel ingress resolver for DM policy, pairing-store allowlists, access groups, and mutable-identifier handling. The score is still Beta rather than Stable because the evidence is mostly simulated and because Google Chat identity semantics are easy to misconfigure when users mix raw emails and `users/<id>` values.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Conversation Access and Routing`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- DM pairing approval: Covers DM pairing approval across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Sender allowlists: Covers Sender allowlists across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Google Chat identity matching: Covers Google Chat identity matching across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Direct session routing: Covers Direct session routing across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Pairing diagnostics: Covers Pairing diagnostics across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Space allowlists: Covers Space allowlists across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Mention gating: Covers Mention gating across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Sender access groups: Covers Sender access groups across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Group session isolation: Covers Group session isolation across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Bot-loop protection: Covers Bot-loop protection across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Space diagnostics: Covers Space diagnostics across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.

## Features

- DM pairing approval: Covers DM pairing approval across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Sender allowlists: Covers Sender allowlists across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Google Chat identity matching: Covers Google Chat identity matching across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Direct session routing: Covers Direct session routing across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Pairing diagnostics: Covers Pairing diagnostics across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Space allowlists: Covers Space allowlists across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Mention gating: Covers Mention gating across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Sender access groups: Covers Sender access groups across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Group session isolation: Covers Group session isolation across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Bot-loop protection: Covers Bot-loop protection across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Space diagnostics: Covers Space diagnostics across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: Local tests cover pairing challenge issuance, DM allowlist decisions, raw email blocking unless dangerous matching is enabled, `users/<email>` not being treated as email allowlist entries, user-id matching, access-group expansion, setup wizard DM policy writes, account-specific DM policy paths, and direct-message thread metadata omission.
- Negative signals: I found no live Google Chat DM pairing scenario that starts from an unknown sender, verifies the actual pairing message in Google Chat, approves the code, and confirms a later DM creates the expected direct session.
- Integration gaps: Add a real Google Chat DM pairing smoke that exercises unknown sender, challenge delivery, pairing approval, allowlist persistence, and post-approval session creation.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: The broad Google Chat issue set shows DMs often work when spaces fail. #58514 explicitly says DMs create `agent:X:googlechat:direct:spaces/Y` sessions while spaces do not. No current gitcrawl hit from the feature-specific DM pairing queries identified a dedicated open DM pairing failure.
- Discrawl reports: `discrawl search "Google Chat DMs work spaces" --limit 10` returned a user config where `openclaw channels status --probe` reported Google Chat configured/running/works with `dm:pairing`, while the user still had message-delivery problems. `discrawl search "Google Chat space messages ignored" --limit 10` returned #58514 comments confirming DMs worked while spaces were misclassified or dropped.
- Good qualities: DM policy uses shared ingress helpers, the default is pairing rather than open access, wildcard open mode is schema-guarded, sender IDs normalize to stable Google Chat user resources, raw email matching is break-glass only, and the pairing reply is sent through the same Google Chat send path.
- Bad qualities: Google Chat identities remain confusing for operators because raw emails, `users/<id>`, `users/<email>`, and `googlechat:` prefixes have different semantics. Direct-message target resolution still depends on Google Chat API `spaces:findDirectMessage`, which can fail for email aliases under service-account auth.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence/depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/google-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for DM pairing approval, Sender allowlists, Google Chat identity matching, Direct session routing, Pairing diagnostics, Space allowlists, Mention gating, Sender access groups, Group session isolation, Bot-loop protection, Space diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live DM pairing smoke with a real Google Chat user id and pairing approval.
- Improve docs with a short identity table: stable `users/<id>`, raw email compatibility, deprecated `users/<email>`, and prefixed target forms.
- Surface a more direct diagnostic when proactive DM resolution fails because service-account auth cannot look up an email alias.
- Include account-scoped DM policy and allowlist state in setup/status output.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`: documents DM pairing default behavior, `openclaw pairing approve googlechat <code>`, direct-message target format `users/<userId>`, raw email compatibility only under dangerous name matching, and `dm.policy`/`dm.allowFrom` config.
- `/Users/kevinlin/code/openclaw/docs/channels/pairing.md`: lists `googlechat` as a supported pairing channel.
- `/Users/kevinlin/code/openclaw/docs/channels/access-groups.md`: documents `message.senders` groups with Google Chat members such as `users/1234567890`.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md`: repeats Google Chat DM and mutable-name-matching config guidance.

### Source

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-access.ts`: applies DM policy through the shared channel ingress resolver, reads pairing-store allowlists, issues pairing challenges, handles raw email alias matching only when dangerous matching is enabled, and blocks unauthorized DMs.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.adapters.ts`: defines DM security adapter paths, sender normalization, pairing approval notification text, and outbound target normalization.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/setup-surface.ts`: wires DM policy setup and account-scoped allowFrom writes.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/targets.ts`: normalizes `users/...`, raw email, and prefixed target forms and resolves user targets to direct-message spaces.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/doctor.ts`: warns on mutable Google Chat allowlist entries.

### Integration tests

- No dedicated live Google Chat DM pairing scenario was found under `/Users/kevinlin/code/openclaw/extensions/qa-lab` or `qa/scenarios`.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/setup-wizard-helpers.test.ts`: includes Google Chat setup-helper scenarios that write `channels.googlechat.dm.allowFrom` and `channels.googlechat.dm.policy`, which is closer to config integration than live channel proof.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-access.test.ts`: covers raw email matching controls, `users/<email>` deprecation behavior, user-id matching, pairing challenge issuance, access-group expansion, group/DM sender decisions, and control-command blocking.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/setup.test.ts`: covers DM policy defaults, account-specific policy paths, open policy wildcard writes, and allowFrom prompt behavior.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/targets.test.ts`: covers Google Chat target normalization and outbound space resolution.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/config-schema.test.ts`: covers DM policy schema rules such as `open` requiring `allowFrom: ["*"]`.

### Gitcrawl queries

Query:

`gitcrawl search issues "Google Chat direct messages pairing users email allowlist" --repo openclaw/openclaw --limit 15 --json number,title,state,updatedAt,url`

Results:

- Returned no direct issue hits. This is neutral after successful archive freshness checks; related evidence came from broader Google Chat issues and discrawl.

Query:

`gitcrawl gh issue view 58514 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #58514, where DMs were reported working and creating direct sessions while space/group messages returned HTTP 200 and were silently ignored.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat DMs work spaces" --limit 10`

Results:

- Returned a user report with `openclaw channels status --probe` showing `Google Chat default: enabled, configured, running, dm:pairing, works`, alongside a config using `dm.policy: "pairing"`.

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat space messages ignored" --limit 10`

Results:

- Returned #58514 discussion confirming the observed split: DMs worked correctly while space/group messages were dropped until space type handling was fixed.
