---
title: "Browser automation and exec/sandbox tools - Sandboxed Browser and Codex Dynamic Tools Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools - Sandboxed Browser and Codex Dynamic Tools Maturity Note

## Summary

Sandboxed browser and Codex dynamic tools is Beta. The Docker sandbox browser
path has real implementation and tests: CDP relay auth, noVNC tokens, browser
config hashes, loopback publish, bridge reuse, and auto-start. Codex dynamic
tools also have a clear fail-closed design that exposes `sandbox_exec` and
`sandbox_process` when OpenClaw sandboxing disables host-native Code Mode. The
score remains Beta because non-Docker browser sandboxing is unsupported, Codex
sandbox exec-server is preview/local-only, and several active reports mention
browser sandbox availability and CDP/noVNC friction.

## Category Scope

This note covers sandbox browser config, Docker browser container creation,
CDP relay authentication, noVNC password/token flow, browser bridge server,
CDP source ranges, config-hash recreation, `allowHostControl`, unsupported
backends, Codex native execution disablement under active OpenClaw sandboxing,
`sandbox_exec`, `sandbox_process`, and the preview Codex sandbox exec-server.

## Features

- Sandboxed Browser: Covers Sandboxed Browser across sandbox browser config, Docker browser container creation, CDP relay authentication, noVNC password/token flow, and related sandboxed browser and codex dynamic tools behavior.
- Codex Dynamic Tools: Covers Codex Dynamic Tools across sandbox browser config, Docker browser container creation, CDP relay authentication, noVNC password/token flow, and related sandboxed browser and codex dynamic tools behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - Docs explicitly describe sandboxed browser auto-start, dedicated Docker
    network, CDP source range, noVNC observer token URLs, allowHostControl, and
    custom control allowlists.
  - Source implements Docker browser image contract checks, CDP auth, noVNC
    password/token handling, config-hash recreation, loopback port publishing,
    and bridge reuse.
  - Codex docs and source implement fail-closed native execution and distinct
    sandbox-backed dynamic tools.
  - Tests cover sandbox browser create args, noVNC auth, CDP relay auth, bridge
    policy changes, dynamic tool exposure, and Codex sandbox exec-server.
- Negative signals:
  - Docs state sandbox browser support is Docker-only; SSH/OpenShell do not
    support it.
  - Codex sandbox exec-server is a preview path requiring newer app-server
    support and a local loopback app-server.
  - Archive reports include target=sandbox browser unavailable and requests for
    non-Docker browser sandbox support.
- Integration gaps:
  - Add a release-gate sandbox browser E2E that opens noVNC token flow, proves
    CDP auth, and runs browser snapshot/action through the sandbox target.
  - Add an app-server sandbox exec-server compatibility smoke for supported
    Codex app-server versions and a fail-closed smoke for unsupported versions.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  - `sandbox browser` returned issue #84942 about sandbox policy reporting
    sandboxed while target=sandbox browser is unavailable, issue #52662 for
    non-Docker browser sandbox backends, issue #49609 for noVNC clipboard
    encoding, PR #85572 adding sandbox posture checks, and issue #64383 about
    simplifying the sandbox browser CDP path.
  - `sandbox browser sandbox_exec sandbox_process Codex app-server` returned no
    focused hits, so broader sandbox/browser archive evidence was used.
- Discrawl reports:
  - `browser sandbox` hybrid search returned a 2026-05-21 maintainer message
    about using browser automation from a US-hosted devbox/session and avoiding
    VPN-required browser workflows.
  - The same search returned 2026-05-14 release notes saying browser/control UI
    pairing got stricter and transcript/tool-result redaction became more
    consistent.
  - `sandbox_exec sandbox_process browser sandbox` returned no high-signal FTS
    hits.
- Good qualities:
  - Sandbox browser image and container config have explicit contract/hash
    checks and stale-container recreation paths.
  - CDP and noVNC are published on loopback and protected with auth/token
    mechanisms.
  - Active OpenClaw sandboxing disables Codex native host-side execution
    surfaces instead of silently treating Codex's host sandbox as equivalent.
  - Dynamic tool exposure uses distinct `sandbox_exec`/`sandbox_process` names
    and follow-up guidance.
- Bad qualities:
  - Browser sandbox is coupled to Docker today.
  - The CDP/noVNC/container path is security-sensitive and operationally
    complicated.
  - Codex sandbox exec-server remains preview and local-only, which keeps the
    stable path intentionally fail-closed.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence affected
    Coverage only.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/browser-automation-and-exec-sandbox-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Sandboxed Browser, Codex Dynamic Tools.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Non-Docker browser sandbox support needs a first-party story or a clearly
  documented extension point.
- Codex sandbox exec-server should stay Beta until the environment contract is
  stable and covered by release-gate integration.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:21`: sandboxed browser details document auto-start, network, CDP source range, noVNC token URL, allowHostControl, and custom target allowlists.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:78`: backend matrix states browser sandbox is supported on Docker and not supported on SSH/OpenShell.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:101`: active OpenClaw sandboxing disables Codex native Code Mode, user MCP, and app-backed plugins while exposing sandbox-backed tools.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness-reference.md:151`: Codex docs explain active OpenClaw sandboxing disables host-side native execution surfaces.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness-reference.md:170`: sandboxed native execution is preview and fail-closed by default.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness-reference.md:197`: preview path starts a loopback exec-server backed by the active sandbox and registers it with Codex app-server.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.ts:77`: sandbox browser waits for CDP readiness with auth.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.ts:162`: sandbox browser image contract is checked before use.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.ts:210`: `ensureSandboxBrowser` creates or reuses a sandbox browser context.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.ts:222`: browser sandbox is skipped when the sandbox tool policy does not allow browser.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.ts:325`: new containers generate noVNC password and CDP auth token.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.ts:364`: CDP and noVNC ports are published on loopback.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.ts:478`: browser bridge server starts with resolved config, auth, auto-start, and noVNC token resolver.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/novnc-auth.ts:58`: noVNC observer tokens are one-time short-lived tokens.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/dynamic-tool-build.ts:508`: sandbox shell dynamic tools are added when OpenClaw sandboxing disables native execution.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/dynamic-tool-build.ts:526`: `sandbox_exec` wraps exec and rewrites follow-up guidance to `sandbox_process`.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/native-execution-policy.ts:63`: native execution policy maps auto to sandbox/gateway and blocks node-targeted native surfaces.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/sandbox-exec-server.ts:60`: Codex sandbox exec-server environment is registered only when an active sandbox backend exists.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/browser-cdp-snapshot-docker.sh:84`: Docker browser E2E validates CDP-backed browser interaction.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/sandbox-exec-server.test.ts:116`: Codex sandbox exec-server routes process execution through a sandbox-backed environment.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/sandbox-exec-server.http.test.ts:29`: Codex sandbox exec-server routes HTTP requests through the sandbox backend.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.create.test.ts:258`: verifies stale sandbox browser images are rejected.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.create.test.ts:292`: verifies noVNC loopback publish and password env.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.create.test.ts:431`: verifies browser SSRF policy is passed to sandbox bridge.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.create.test.ts:647`: verifies sandbox CDP relay requires auth.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/browser.novnc-url.test.ts:26`: verifies one-time noVNC observer tokens.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/dynamic-tool-build.test.ts:219`: verifies sandbox shell tools are exposed for non-Docker sandbox backends.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/dynamic-tool-build.test.ts:689`: verifies Codex native surfaces are disabled when OpenClaw sandbox is active.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/dynamic-tool-build.test.ts:739`: verifies sandbox exec-server native surfaces stay behind sandbox tool policy.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "sandbox browser" --json`

Results:

- Open issue #84942: sandboxed runtime reported while target=sandbox browser is unavailable.
- Open issue #52662: browser sandbox should support non-Docker backends.
- Open PR #85572: add sandbox posture conformance checks.
- Open issue #49609: sandbox-browser noVNC clipboard garbles non-Latin-1 characters.
- Open issue #64383: simplify sandbox browser CDP path.

Query:

`gitcrawl search openclaw/openclaw --query "sandbox browser sandbox_exec sandbox_process Codex app-server" --json`

Results:

- No focused hits returned; broader `sandbox browser` results supplied current archive evidence.

### Discrawl queries

Query:

`discrawl search --mode hybrid --limit 5 "browser sandbox"`

Results:

- 2026-05-21 maintainers archive discusses browser automation from a hosted
  devbox/session and local Playwright/Chrome alternatives.
- 2026-05-14 release archive notes stricter setup/browser/control UI pairing and
  more consistent transcript/tool-result redaction.

Query:

`discrawl search --mode fts --limit 5 "sandbox_exec sandbox_process browser sandbox"`

Results:

- No high-signal FTS hits.
