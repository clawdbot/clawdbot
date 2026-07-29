# OpenClaw App SDK Completeness

Use this rubric when assigning category Completeness scores for the
`openclaw-app-sdk` surface.

## Surface-Specific Scoring Questions

For each category, ask:

- Can an external app developer complete the category workflow using public SDK APIs?
- Are the taxonomy features represented by stable client contracts rather than protocol-only fragments?
- Are setup, authentication, streaming, result handling, error behavior, and compatibility expectations documented?
- Are browser, Node, React, testing, and custom transport variants covered where the category expects them?
- Do known gaps leave major external-app capability branches missing?

## Surface-Specific Guidance

Variation from the default completeness process:

- Completeness is the external app-developer workflow from connection through agent runs, sessions, events, approvals, resources, compatibility, and operational error handling.
- A complete SDK category exposes typed, documented, reusable client APIs instead of requiring low-level Gateway protocol work.
- Manual Gateway frame construction or reliance on internal package shapes is a material completeness gap.

## Category Scope

- Client API: SDK entrypoints, namespace layout, package split, and app/plugin boundary.
- Gateway Access: Gateway connect, URL and token config, auto gateway, custom transport, and scopes/redaction.
- Agent Conversations: agent handles, agent runs, run results, session creation, session send, and session controls.
- Events and Approvals: event stream, event envelope, replay cursors, approval callbacks, and questions.
- Resource Helpers: models, ToolSpace, artifacts, tasks, and environments.
- Compatibility: generated client, ergonomic wrappers, unsupported calls, schema alignment, and public package contract.
