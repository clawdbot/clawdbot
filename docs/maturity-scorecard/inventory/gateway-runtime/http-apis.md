---
title: Gateway Runtime - HTTP APIs Maturity Note
version: 3
last_refreshed: 2026-05-29
last_refreshed_by: codex
feature_family: HTTP APIs
feature_slug: http-apis
---

# HTTP APIs

## Summary

OpenClaw exposes first-class HTTP API routes on the Gateway port, including
OpenAI-compatible `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and
`/v1/embeddings`, `/tools/invoke`, optional admin HTTP RPC, and hook ingress.
Coverage remains strong because the archived evidence includes real Gateway
server-flow tests for the main OpenAI-compatible routes, tools invocation, and
hooks. Quality remains Beta because archive reports still include compatibility
edge cases, hooks auth confusion, admin RPC enablement gaps, and tool
availability issues.

Scores:

- Coverage: `88` - `Stable`
- Quality: `74` - `Beta`
- Completeness: `72` - `Beta`

## Features

- OpenAI-compatible APIs: OpenAI-compatible HTTP APIs (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`).
- Tool invocation API: HTTP tools invoke path.
- Admin API access: Optional admin HTTP RPC plugin route.
- Hook ingress: Hook hosting and HTTP ingress routes.

## Coverage

Score: `88`

Positive signals:

- Gateway docs list `/v1/*`, `/tools/invoke`, admin HTTP RPC, and hook routes as Gateway HTTP surfaces.
- Source dispatches `/v1/models`, `/v1/embeddings`, `/v1/chat/completions`, `/v1/responses`, and `/tools/invoke` from the Gateway HTTP server.
- Integration tests cover models, chat completions, responses, embeddings, `/tools/invoke`, and hook routes through real Gateway HTTP requests.

Negative signals:

- Admin HTTP RPC has registration and handler tests, but still needs a full enabled-plugin Gateway flow for `POST /api/v1/admin/rpc`.
- The archived issue record includes open edge cases around `/v1/*` media mapping, reasoning exposure, session reuse, dynamic model catalog refresh, and hook auth.

## Quality

Score: `74`

Good qualities:

- OpenAI-compatible endpoints and `/tools/invoke` share Gateway auth semantics.
- Hook routes are documented and have dedicated Gateway tests.
- Admin HTTP RPC is default-off and plugin-gated.

Bad qualities:

- Operator expectations around hooks tokens versus Gateway auth remain confusing.
- Compatibility with OpenAI-style clients still has active edge cases.
- Admin HTTP RPC maturity depends on enabled-plugin scenario proof.

## Completeness

Score: `72`

Positive signals:

- The category covers the durable HTTP endpoint families that external clients and automation can call directly.

Missing capability branches:

- Full admin RPC Gateway-flow proof.
- Coexistence scenario covering OpenAI-compatible routes, `/tools/invoke`, hooks, and admin/plugin HTTP routes on one Gateway process.

## Evidence

- Docs: `docs/gateway/index.md`, `docs/gateway/openai-http-api.md`, `docs/gateway/openresponses-http-api.md`, `docs/gateway/tools-invoke-http-api.md`, `docs/automation/hooks.md`, `docs/web/index.md`.
- Source: `src/gateway/server-http.ts`, `src/gateway/models-http.ts`, `src/gateway/openai-http.ts`, `src/gateway/openresponses-http.ts`, `src/gateway/embeddings-http.ts`, `src/gateway/tools-invoke-http.ts`, `extensions/admin-http-rpc/index.ts`.
- Tests: `src/gateway/models-http.test.ts`, `src/gateway/openai-http.test.ts`, `src/gateway/openresponses-http.test.ts`, `src/gateway/embeddings-http.test.ts`, `src/gateway/gateway.test.ts`, `src/gateway/server.hooks.test.ts`, `extensions/admin-http-rpc/index.test.ts`, `extensions/admin-http-rpc/src/handler.test.ts`.
- Archive queries: OpenAI-compatible Gateway issues, `/v1/responses`, `/tools/invoke`, Gateway hooks HTTP, and admin HTTP RPC issues from the archived score run.
