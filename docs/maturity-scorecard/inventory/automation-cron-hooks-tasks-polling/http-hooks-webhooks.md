---
title: "Automation: cron, hooks, tasks, polling - HTTP Webhooks Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - HTTP Webhooks Maturity Note

## Summary

HTTP hooks expose the external automation ingress for wake and isolated agent runs. The contract has strong security defaults: dedicated path, bearer or `x-openclaw-token` auth, query-token rejection, agent allowlists, session-key prefix gates, mapped hook transforms, and external-content boundaries. Coverage and quality are held back by user-facing integration friction and open requests for related webhook behavior.

## Category Scope

This category covers `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, request body limits, path/client-IP policy, allowed agent/session controls, idempotency keys, payload wrapping, asynchronous dispatch, and webhook plugin ingress helpers.

## Features

- POST /hooks/wake: Covers POST /hooks/wake across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- POST /hooks/agent: Covers POST /hooks/agent across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Mapped hooks: Covers Mapped hooks across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Hook auth policy: Covers Hook auth policy across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Async dispatch: Covers Async dispatch across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Unit and integration-style coverage exists for hook request handling, trust/session policy, mapping resolution, request timeout, plugin webhook guards, and the bundled webhooks extension.
- Negative signals: Real external integrations are harder to prove locally; Gmail/Tailscale and channel webhook setups show that end-to-end ingress depends on reverse-proxy path/token details outside the core handler.
- Integration gaps: A single e2e fixture should stand up a Gateway hook handler, POST `wake`, `agent`, and mapped hook requests, validate token/session/agent policy failures, and prove the resulting run/event appears in task or session state.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: PR #62528 requests `/hooks/message` with auth parity, PR #83118 requests tokenFile auth secrets, issue #77093 reports Gmail Pub/Sub push not processing in Docker plus Tailscale Funnel, and issue #64556 reports `hooks.mappings[].agentId`/`sessionKey` ignored for `action="wake"`.
- Discrawl reports: PR #69267 adds logging for 4xx hook gateway errors because invalid webhook POSTs previously left no trace; Discord user guidance emphasizes external workflow engines for deterministic human-in-the-loop Telegram flows and lists `/hooks/agent` and `/hooks/wake` as worker-runtime ingress.
- Good qualities: Auth is centralized, query-string tokens are rejected, session-key selection is opt-in and prefix-bound, templated mappings require prefix gates, and mapped external content can be wrapped as untrusted.
- Bad qualities: Debuggability and integration setup remain weak spots. Several reports cluster around silent validation failures, missing auth-secret ergonomics, and path/token mismatches with real reverse proxies.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for POST /hooks/wake, POST /hooks/agent, Mapped hooks, Hook auth policy, Async dispatch.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Hook 4xx responses need consistently actionable logs and operator-facing troubleshooting.
- Token-file support and safer secret management would reduce config-risk pressure.
- Mapped wake action semantics need to be explicit for agent/session fields so operators know which fields apply.

## Evidence

### Docs

- `docs/automation/cron-jobs.md#webhooks` documents `/hooks/wake`, `/hooks/agent`, mapped hooks, auth headers, query-token rejection, allowed agents, session-key controls, and safety boundaries.
- `docs/automation/webhook.md` redirects to the scheduled-tasks webhook docs.
- `docs/cli/webhooks.md` documents webhook CLI setup, including Gmail setup.

### Source

- `src/gateway/hooks.ts` resolves hook config, token extraction, body parsing, allowed agents, session-key policy, delivery fields, and payload normalization.
- `src/gateway/server/hooks.ts` and `src/gateway/server/hooks-request-handler.ts` implement request dispatch and HTTP handling.
- `src/gateway/hooks-mapping.ts` implements preset and custom mapped hook transforms, path matching, templates, and transform path containment.
- `src/gateway/hooks-policy.ts` and `src/gateway/server/hook-client-ip-config.ts` implement policy helpers.
- `src/plugin-sdk/webhook-ingress.ts`, `src/plugin-sdk/webhook-request-guards.ts`, `src/plugin-sdk/webhook-targets.ts`, and `extensions/webhooks/` implement plugin-facing webhook helpers and the bundled webhooks plugin.

### Integration tests

- `src/gateway/server/hooks.agent-trust.test.ts` exercises hook dispatch trust boundaries.
- `src/gateway/server-http.hooks-request-timeout.test.ts` covers request timeout behavior.
- `extensions/webhooks/index.test.ts` and `extensions/webhooks/src/http.test.ts` exercise the bundled webhooks plugin path.

### Unit tests

- `src/gateway/hooks.test.ts`, `src/gateway/hooks-mapping.test.ts`, `src/gateway/hooks-test-helpers.ts`, and `src/gateway/server.hooks.test.ts` cover core hook parsing and mapping behavior.
- `src/plugin-sdk/webhook-request-guards.test.ts`, `src/plugin-sdk/webhook-memory-guards.test.ts`, and `src/plugin-sdk/webhook-targets.test.ts` cover SDK guard helpers.
- `src/gateway/server/hooks.agent-trust.test.ts` covers agent/session trust policy details.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "hooks agent wake token allowedSessionKey" --json --limit 5`

Results:

- No hits for the exact query.

Fallback query:

`gitcrawl search openclaw/openclaw --query "webhook token hook" --json --limit 5`

Results:

- PR #62528 requests `/hooks/message` ingress with webhook auth parity.
- PR #83118 requests token-file auth secrets shared across gateway hooks and Gmail runtime/setup.
- Issue #77093 reports real Gmail Pub/Sub pushes reaching the topic but not processing through the webhook/watcher path.
- PR #64126 references shared secret comparison for hook token validation.
- Issue #64556 reports mapped hook `agentId` and `sessionKey` ignored for wake actions.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "hooks agent wake token allowedSessionKey"`

Results:

- No matching Discord messages returned for this exact query.

Fallback query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "webhook token hook"`

Results:

- PR #69267 discussion adds logging for 4xx hook gateway errors, including token-in-query, invalid payload, disallowed agent, session-key errors, unauthorized requests, and missing endpoints.
- Discord workflow guidance recommends external workflow ownership for hard deterministic Telegram orchestration and treats `/hooks/agent` and `/hooks/wake` as OpenClaw worker-runtime ingress.
