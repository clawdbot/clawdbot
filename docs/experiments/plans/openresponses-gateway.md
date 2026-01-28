---
summary: "Plan: Add OpenResponses /v1/responses endpoint and deprecate chat completions cleanly"
owner: "moltbot"
status: "draft"
last_updated: "2026-01-19"
---

# OpenResponses Gateway Integration Plan

## Context

Moltbot Gateway currently exposes a minimal OpenAI-compatible Chat Completions endpoint at
`/v1/chat/completions` (see [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses is an open inference standard based on the OpenAI Responses API. It is designed
for agentic workflows and uses item-based inputs plus semantic streaming events. The OpenResponses
spec defines `/v1/responses`, not `/v1/chat/completions`.

## Goals

- Add a `/v1/responses` endpoint that adheres to OpenResponses semantics.
- Keep Chat Completions as a compatibility layer that is easy to disable and eventually remove.
- Standardize validation and parsing with isolated, reusable schemas.

## Non-goals

- Full OpenResponses feature parity in the first pass (images, files, hosted tools).
- Replacing internal agent execution logic or tool orchestration.
- Changing the existing `/v1/chat/completions` behavior during the first phase.

## Research Summary

Sources: OpenResponses OpenAPI, OpenResponses specification site, and the Hugging Face blog post.

Key points extracted:

- `POST /v1/responses` accepts `CreateResponseBody` fields like `model`, `input` (string or
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens`, and
  `max_tool_calls`.
- `ItemParam` is a discriminated union of:
  - `message` items with roles `system`, `developer`, `user`, `assistant`
  - `function_call` and `function_call_output`
  - `reasoning`
  - `item_reference`
- Successful responses return a `ResponseResource` with `object: "response"`, `status`, and
  `output` items.
- Streaming uses semantic events such as:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- The spec requires:
  - `Content-Type: text/event-stream`
  - `event:` must match the JSON `type` field
  - terminal event must be literal `[DONE]`
- Reasoning items may expose `content`, `encrypted_content`, and `summary`.
- HF examples include `OpenResponses-Version: latest` in requests (optional header).

## Proposed Architecture

- Add `src/gateway/open-responses.schema.ts` containing Zod schemas only (no gateway imports).
- Add `src/gateway/openresponses-http.ts` (or `open-responses-http.ts`) for `/v1/responses`.
- Keep `src/gateway/openai-http.ts` intact as a legacy compatibility adapter.
- Add config `gateway.http.endpoints.responses.enabled` (default `false`).
- Keep `gateway.http.endpoints.chatCompletions.enabled` independent; allow both endpoints to be
  toggled separately.
- Emit a startup warning when Chat Completions is enabled to signal legacy status.

## Deprecation Path for Chat Completions

- Maintain strict module boundaries: no shared schema types between responses and chat completions.
- Make Chat Completions opt-in by config so it can be disabled without code changes.
- Update docs to label Chat Completions as legacy once `/v1/responses` is stable.
- Optional future step: map Chat Completions requests to the Responses handler for a simpler
  removal path.

## Phase 1 Support Subset

- Accept `input` as string or `ItemParam[]` with message roles and `function_call_output`.
- Extract system and developer messages into `extraSystemPrompt`.
- Use the most recent `user` or `function_call_output` as the current message for agent runs.
- Reject unsupported content parts (image/file) with `invalid_request_error`.
- Return a single assistant message with `output_text` content.
- Return `usage` with zeroed values until token accounting is wired.

## Validation Strategy (No SDK)

- Implement Zod schemas for the supported subset of:
  - `CreateResponseBody`
  - `ItemParam` + message content part unions
  - `ResponseResource`
  - Streaming event shapes used by the gateway
- Keep schemas in a single, isolated module to avoid drift and allow future codegen.

## Streaming Implementation (Phase 1)

- SSE lines with both `event:` and `data:`.
- Required sequence (minimum viable):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (repeat as needed)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Tests and Verification Plan

- Add e2e coverage for `/v1/responses`:
  - Auth required
  - Non-stream response shape
  - Stream event ordering and `[DONE]`
  - Session routing with headers and `user`
- Keep `src/gateway/openai-http.e2e.test.ts` unchanged.
- Manual: curl to `/v1/responses` with `stream: true` and verify event ordering and terminal
  `[DONE]`.

## Doc Updates (Follow-up)

- Add a new docs page for `/v1/responses` usage and examples.
- Update `/gateway/openai-http-api` with a legacy note and pointer to `/v1/responses`.
