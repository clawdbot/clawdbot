---
title: "OpenAI / Codex provider path - Native Codex Harness Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenAI / Codex provider path - Native Codex Harness Maturity Note

## Summary

The native Codex app-server harness is deeply documented and has meaningful runtime proof. It covers managed stdio app-server startup, WebSocket app-server connections, `/codex` controls, native thread binding/resume/compact, queue steering, native hooks, approval bridges, sandbox policy, native plugin apps, Computer Use, and diagnostics upload. Coverage is Stable because there are docs, source modules, focused unit tests, Docker E2E, and opt-in live harness probes. Quality is Beta because the boundary is complex and archived discussions still show confusion about usage, compaction, `codex/*` versus `openai-codex/*`, and native-vs-OpenClaw tool ownership.

## Category Scope

Included in this category:

- Native Codex App-server Harness: Covers Native Codex App-server Harness across native Codex app-server runtime path used by OpenAI agent turns when the Codex harness owns thread identity, native model loop, compaction, native tools, and native app-server controls.
- Thread Lifecycle: Covers Thread Lifecycle across native Codex app-server runtime path used by OpenAI agent turns when the Codex harness owns thread identity, native model loop, compaction, native tools, and native app-server controls.

## Features

- Native Codex App-server Harness: Covers Native Codex App-server Harness across native Codex app-server runtime path used by OpenAI agent turns when the Codex harness owns thread identity, native model loop, compaction, native tools, and native app-server controls.
- Thread Lifecycle: Covers Thread Lifecycle across native Codex app-server runtime path used by OpenAI agent turns when the Codex harness owns thread identity, native model loop, compaction, native tools, and native app-server controls.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Docs cover setup, runtime boundaries, reference config, native plugins, Computer Use, approvals, sandboxing, and diagnostics; live harness tests and Docker E2E cover real gateway/app-server behavior.
- Negative signals: Many capabilities are opt-in, account-dependent, or version-dependent, so release proof is spread across multiple specialized lanes.
- Integration gaps: Native plugin apps, guardian approvals, sandbox exec-server preview, and remote WebSocket app-server deployments need recurring current-version proof.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Query returned #85914 about making tool-call failure recovery a native OpenClaw run-loop capability, which is adjacent to the harness/native tool boundary.
- Discrawl reports: 2026-04-24 maintainer discussion argued the Codex app-server path is not just another launch backend because it owns native thread identity, resume/compact behavior, account/model/status, permissions, fast/stop/steer/binding controls, dynamic tool bridging, transcript mirroring, and diagnostics.
- Good qualities: The docs are explicit about owner boundaries and fail-closed behavior; the source has named extension and task surfaces instead of ad hoc bridges.
- Bad qualities: Operationally, the harness still requires users to understand app-server state, Codex thread state, OpenClaw session state, and tool ownership.
- Excluded from quality: Harness test coverage was considered only for Coverage.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/openai-codex-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native Codex App-server Harness, Thread Lifecycle.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Native app-server version drift needs release-scorecard proof.
- Native plugin app accessibility and destructive-action policy are intentionally narrow and can surprise operators.
- Usage comparisons between OpenAI/Codex provider path and native harness path remain a support topic.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness.md` documents setup, runtime selection, `/codex` controls, deployment patterns, and verification.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness-runtime.md` documents thread bindings, hooks, tools, approvals, queue steering, feedback upload, compaction, and transcript mirrors.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness-reference.md` documents app-server config fields, transport, approval/sandbox modes, auth isolation, and sandboxed native execution.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-native-plugins.md` documents native Codex plugin app migration, app inventory, thread app config, and destructive-action policy.

### Source

- `/Users/kevinlin/code/openclaw/src/plugins/codex-app-server-extension-types.ts` defines extension event hooks for Codex app-server tool results.
- `/Users/kevinlin/code/openclaw/src/plugins/codex-app-server-extension-factory.ts` lists active Codex app-server extension factories.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/codex-native-task-runtime.ts` exposes local-only helpers for mirroring Codex native subagents into OpenClaw task state.
- `/Users/kevinlin/code/openclaw/src/tasks/codex-native-subagent-task.ts` owns native Codex subagent task identity and stale-state handling.
- `/Users/kevinlin/code/openclaw/src/commands/codex-runtime-plugin-install.ts` manages bundled Codex runtime plugin installation.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/gateway-codex-harness.live.test.ts` contains opt-in live Codex harness probes for gateway, `/codex status`, models, image/chat image, MCP, subagent, guardian, and code-mode variants.
- `/Users/kevinlin/code/openclaw/scripts/e2e/codex-media-path-docker.sh` runs a Codex media-path Docker E2E with gateway and app-server logs.
- `/Users/kevinlin/code/openclaw/scripts/e2e/codex-on-demand-docker.sh` covers on-demand Codex plugin/runtime behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/system-prompt.test.ts` covers preferring native Codex app-server commands over ACP when available.
- `/Users/kevinlin/code/openclaw/src/agents/cli-runner.spawn.test.ts` covers Codex system prompt passthrough into CLI/app-server-like execution.
- `/Users/kevinlin/code/openclaw/extensions/openai/openclaw.plugin.test.ts` and plugin registration contract tests cover OpenAI/Codex plugin registration.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "codex app-server harness thread compact /codex status native codex"`

Results:

- Returned #85914, a feature request around native run-loop tool-call failure recovery.

### Discrawl queries

Query: `discrawl search --limit 10 "codex app-server harness thread compact /codex status native codex"`

Results:

- Returned 2026-04-24 maintainer review context explaining why the Codex app-server path owns native thread identity, resume/compact behavior, account/model/status, permissions, controls, dynamic tool bridging, and transcript mirroring.
- Returned 2026-04-14 discussion distinguishing `openai-codex/*` provider usage from native `codex/*` harness usage and compaction tradeoffs.
