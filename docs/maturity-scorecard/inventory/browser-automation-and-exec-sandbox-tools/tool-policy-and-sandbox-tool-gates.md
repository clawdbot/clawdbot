---
title: "Browser automation and exec/sandbox tools - Tool Policy and Sandbox Tool Gates Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools - Tool Policy and Sandbox Tool Gates Maturity Note

## Summary

Tool policy and sandbox tool gates is Stable. The docs and source define a
layered policy pipeline: profiles, provider policy, global/agent policy, group
and sender policy, sandbox tool policy, subagent policy, and inherited policy.
The key quality risk is not missing implementation; it is policy complexity and
operator misunderstanding, especially for plugin/MCP tools inside sandboxed
turns and for shell execution remaining mutating even when file tools are
denied.

## Category Scope

This note covers tool profiles, tool groups, allow/deny policy, provider policy,
sender policy, group/channel policy, sandbox tool policy, plugin/MCP sandbox
gate entries, effective tool projection, subagent inherited tools, sandbox
blocked-tool guidance, and `tools.effective`/`sandbox explain` diagnostics.

## Features

- Tool Policy: Covers Tool Policy across tool profiles, tool groups, allow/deny policy, provider policy, and related tool policy and sandbox tool gates behavior.
- Sandbox Tool Gates: Covers Sandbox Tool Gates across tool profiles, tool groups, allow/deny policy, provider policy, and related tool policy and sandbox tool gates behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals:
  - Docs clearly describe tool profiles, groups, provider policy, sender policy,
    sandbox tool policy, MCP/plugin sandbox gates, and precedence.
  - Source normalizes policy entries, expands core/plugin groups, analyzes
    unknown allowlist entries, handles `alsoAllow`, and applies final effective
    tool policy to plugin/bundled tools.
  - Tests cover sandbox tool policy merging, deny precedence, blocked guidance,
    effective sandbox resolver alignment, and direct HTTP/RPC tool invoke policy.
  - Security docs warn that tool policy controls callable tools, not arbitrary
    side effects inside an allowed shell.
- Negative signals:
  - Archive reports show MCP/plugin tools disappearing from sandboxed sessions
    and operators confusing tool policy with plugin runtime or shell isolation.
  - Unknown tool allowlist entries can make configuration look safer than it is.
- Integration gaps:
  - Add an end-to-end sandboxed MCP/plugin tool visibility matrix for `bundle-mcp`,
    plugin id, `group:plugins`, exact server tool, and server glob entries.
  - Add a user-facing policy inspector that explains the exact policy step that
    removed each important tool.

## Quality Score

- Score: `Stable (83%)`
- Gitcrawl reports:
  - `tools sandbox tool policy` returned PR #86715 for adding `message` to
    default sandbox policy, issue #75124 for skill slash commands bypassing
    effective tool policy, PR #60981 for filesystem access control PathGuard,
    issue #85030 for MCP tools not injected into subagent sessions, and issue
    #44484 about declared tools not matching effective session tools.
- Discrawl reports:
  - `tool policy sandbox tools` returned 2026-04-28 guidance recommending
    sandbox/tool policy for hard isolation and explaining that workspaces are
    not a hard sandbox by themselves.
  - The same query returned companion/Joi support guidance that denying `exec`
    removes model-callable exec/process but does not stop trusted plugin/service
    code from shelling out internally.
- Good qualities:
  - Policy layers are ordered and documented.
  - Deny wins and restrictive allowlists fail loudly when no callable tools
    remain.
  - Plugin-owned tools have explicit group/plugin expansion logic.
  - Effective tool policy uses trusted session-derived group context instead of
    untrusted model/tool-call fields.
  - Sandbox blocked-tool messages include fix-it keys and shell-safe formatting.
- Bad qualities:
  - Operators must understand several policy layers and their precedence.
  - The sandbox plugin/MCP gate is an additional layer that can hide tools even
    after the server/plugin loads successfully.
  - Allowing `exec` means the model still has a shell; denying `write` or
    `apply_patch` does not make that shell read-only.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence affected
    Coverage only.

## Completeness Score

- Score: `Stable (86%)`
- Surface instructions: evaluated against `references/completeness/browser-automation-and-exec-sandbox-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Tool Policy, Sandbox Tool Gates.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- The policy inspector should make missing MCP/plugin tools easier to debug.
- Subagent and inherited tool-policy behavior needs more direct user-facing
  visibility.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:15`: tool profiles are documented.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:30`: tool groups are documented, including runtime, fs, sessions, memory, web, ui, automation, messaging, nodes, agents, media, openclaw, and plugins.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:48`: MCP and plugin tools inside sandbox policy require an additional sandbox gate.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:79`: global allow/deny policy is documented and deny wins.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:97`: provider-specific policy order is documented.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:113`: toolsBySender is documented as defense-in-depth.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandbox-vs-tool-policy-vs-elevated.md:52`: docs distinguish tool profile, provider policy, global/agent policy, and sandbox tool policy.
- `/Users/kevinlin/code/openclaw/docs/tools/multi-agent-sandbox-tools.md:197`: docs enumerate the filtering order through sandbox and subagent tool policy.
- `/Users/kevinlin/code/openclaw/docs/tools/multi-agent-sandbox-tools.md:309`: docs warn that shell execution can still write even when filesystem tools are disabled.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/tool-policy.ts:63`: explicit allowlists are collected across policy layers.
- `/Users/kevinlin/code/openclaw/src/agents/tool-policy.ts:107`: plugin tool groups are built from plugin metadata.
- `/Users/kevinlin/code/openclaw/src/agents/tool-policy.ts:131`: plugin group entries expand to plugin-owned tools.
- `/Users/kevinlin/code/openclaw/src/agents/tool-policy.ts:172`: allowlist analysis detects unknown and plugin-only entries.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox-tool-policy.ts:31`: sandbox tool policy picks allow, alsoAllow, and deny entries.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/effective-tool-policy.ts:23`: group identity inputs are documented as authorization signals that must be server-derived.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/effective-tool-policy.ts:151`: final policy pipeline includes default policy, sandbox tools, subagent tools, and inherited tools.
- `/Users/kevinlin/code/openclaw/src/gateway/tool-resolution.ts:177`: Gateway-scoped tools apply the policy pipeline before exposure.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.test.ts:440`: HTTP tools invoke integration-like tests exercise policy filtering.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.browser-plugin.integration.test.ts:1`: integration coverage exists for built-in/plugin tool exposure.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/sandbox-tool-policy.test.ts:10`: verifies sandbox tool policy behavior.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox-tool-policy.test.ts:11`: verifies sandbox `alsoAllow` merges into default sandbox allowlist.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox-tool-policy.test.ts:197`: verifies sandbox deny precedence over allow and alsoAllow.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox-tool-policy.test.ts:238`: verifies blocked-tool guidance uses effective sandbox policy.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox-tool-policy.test.ts:270`: verifies blocked-tool guidance is glob-aware and shell-safe.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.buildembeddedsandboxinfo.test.ts:1`: embedded sandbox info tests exist.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "tools sandbox tool policy" --json`

Results:

- Open PR #86715: add message to `DEFAULT_TOOL_ALLOW` in sandbox policy.
- Open issue #75124: skill slash commands bypass effective tool policy.
- Open PR #60981: filesystem access control PathGuard.
- Open issue #85030: MCP tools not injected into subagent sessions.
- Open issue #44484: declared tools do not match effective session tools.

### Discrawl queries

Query:

`discrawl search --mode fts --limit 5 "tool policy sandbox tools"`

Results:

- 2026-04-28 archive guidance recommends sandbox/tool policy for hard isolation,
  with workspaces and auth stores treated separately.
- 2026-04-27 archive guidance explains that denying `exec` removes model-callable
  exec/process but does not disable trusted plugin, hook, or service code.
