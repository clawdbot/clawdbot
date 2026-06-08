---
title: "Gateway Web App - Operator Panels and Admin Workflows Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - Operator Panels and Admin Workflows Maturity Note

## Summary

The Control UI is more than chat: it exposes channels, instances, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and setup/login workflows through Gateway RPCs. Coverage is Stable because the underlying RPCs and many UI controllers/views have tests, but the end-to-end operator workflow matrix is broad. Quality is Beta because the panels are useful and scope-gated, while archive evidence shows users still struggle with elevated exec, channel/setup status, skill UI, and multi-agent/session scoping.

## Category Scope

This category covers non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.

## Features

- Channels/login: Covers Channels/login across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Session manager and history: Covers browser Control UI session manager, session history, instance presence, approvals, diagnostics, and log tabs.
- Cron: Covers Cron across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Skills/nodes: Covers Skills/nodes across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Exec approvals/agents: Covers Exec approvals/agents across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: Gateway method descriptors scope the relevant RPCs; UI controllers and view tests cover channels, sessions, cron, skills, nodes, exec approvals, agents, usage, and activity-adjacent panels.
- Negative signals: Full workflows span upstream channel APIs, node hosts, skill/plugin registries, cron execution, exec policy, and multi-agent session state. Many panels are covered independently rather than through full browser operator journeys.
- Integration gaps: Add release scenarios for channel QR login/status, session patching, cron create/run/edit, skill install/API-key update, node exec approval edit, multi-agent usage scoping, and agent creation.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: Specific operator-panel query returned `[]`, but broad Control UI PRs returned #80388 for plugin Control UI entry points, #80192 for Codex activity in Control UI, #87147 for usage page agent scoping, #81954 for Agents tab New Agent flow, and #74715 for Notifications tab visibility.
- Discrawl reports: Operator-panel search found a full Control UI transcript where a user enabled elevated exec for WebChat, hit a wrong config shape, restarted, and still could not execute the requested command in-session. Other support examples show users relying on Control UI for status, logs, channels, and setup triage.
- Good qualities: Admin RPCs are scope-gated, panels generally use Gateway-derived state, slow channel probes preserve snapshots, and exec approval editing uses base-hash guards.
- Bad qualities: The operational surface is wide enough that users can misread policy, scope, runtime, or config-reload state, especially around elevated exec and channel/node workflows.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Channels/login, Session manager and history, Cron, Skills/nodes, Exec approvals/agents.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Panel-level state is broad but still lacks a small set of stable, public operator scenario scorecards.
- Elevated exec policy and WebChat-origin permissions need clearer UX handoff after config changes.
- Plugin/skill Control UI extension surfaces are still evolving.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents Channels, Instances, Sessions, Dreams, Cron, Skills, Nodes, Exec approvals, Debug, Logs, and Update panels.
- `/Users/kevinlin/code/openclaw/docs/gateway/protocol.md` lists scopes and RPCs for channels, nodes, cron, sessions, skills, models, exec approvals, and devices.
- `/Users/kevinlin/code/openclaw/docs/web/dashboard.md` documents Control UI as an admin surface.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/methods/core-descriptors.ts` scopes core Gateway methods used by Control UI panels.
- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/channels.ts` loads channel status and starts/waits for web login.
- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/sessions.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/cron.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/skills.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/nodes.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/agents.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/exec-approvals.ts` implement panel controllers.
- `/Users/kevinlin/code/openclaw/ui/src/ui/views/channels.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/sessions.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/cron.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/skills.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/nodes.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/agents.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/views/exec-approval.ts` render the panels.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server-channels.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/server-cron.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/server-methods/sessions.ts`, and `/Users/kevinlin/code/openclaw/src/gateway/server-methods/skills-upload.test.ts` cover Gateway-side panel capabilities.
- `/Users/kevinlin/code/openclaw/src/gateway/operator-approvals-client.e2e.test.ts` covers operator approval client behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/channels.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/cron.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/sessions.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/exec-approval.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/channels.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/cron.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/skills.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/nodes.devices.test.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/views/agents.test.ts` cover panel logic and rendering.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Control UI channels sessions cron skills nodes exec approvals"`

Results:

- Returned `[]`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "Control UI"`

Results:

- Returned operator-panel-adjacent PRs #80388, #80192, #87147, #81954, #74715, and #79747.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Control UI channels sessions cron skills nodes exec approvals"`

Results:

- Found a Control UI transcript where a user tried to enable elevated exec from WebChat, patched config, restarted, and still could not run the command in the current session.
- Found support examples using Control UI status/logs/channels panels for setup triage.
