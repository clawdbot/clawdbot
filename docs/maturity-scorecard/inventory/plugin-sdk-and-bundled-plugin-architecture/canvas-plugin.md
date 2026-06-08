---
title: Plugins - Canvas Plugin Maturity Note
version: 3
last_refreshed: 2026-06-04
last_refreshed_by: codex
---

# Plugins - Canvas Plugin Maturity Note

## Summary

Canvas is best framed as one experimental bundled plugin that owns a cluster of
related capabilities: hosted Canvas/A2UI routes, the agent `canvas` tool, node
commands, Control UI embeds, hosted document materialization, snapshots, and
A2UI transport. Coverage is `Beta` because the repo has concrete source and
docs for the feature family, but the evidence remains plugin-entry and
component-level rather than an end-to-end release support promise. Quality is
`Alpha` because the feature is explicitly experimental and depends on several
host, node, and embed paths staying aligned.

## Category Scope

- This category covers the bundled Canvas plugin as a feature family, not a
  single narrow behavior.
- This category covers hosted Canvas/A2UI Gateway routes, the agent-facing
  `canvas` tool, node `canvas.*` commands, Control UI embeds, hosted document
  URLs, snapshots, and A2UI transport.
- Out of scope: native app-specific Canvas implementation details for macOS,
  iOS, Android, or Windows nodes. Those remain scored in the relevant platform
  surfaces.

## Features

- Hosted Canvas and A2UI surfaces: Canvas plugin registers authenticated Gateway HTTP and WebSocket routes for hosted Canvas documents and A2UI runtime surfaces.
- Agent canvas tool: Canvas plugin registers the agent-facing `canvas` tool for present, hide, navigate, eval, snapshot, and A2UI control.
- Node Canvas commands: Canvas plugin owns node invoke policy for `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, and `canvas.a2ui.*` commands.
- Control UI embeds: Assistant output can embed hosted Canvas document URLs in Control UI and WebChat sessions.
- Canvas documents: Canvas plugin materializes hosted document files and `/__openclaw__/canvas/documents/...` URLs.
- A2UI transport and snapshots: Canvas plugin groups A2UI push, reset, and JSONL transport with snapshot capture and node-rendered Canvas state.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - `extensions/canvas/index.ts:45` defines Canvas as a bundled plugin entry,
    and `docs/refactor/canvas.md:12` frames Canvas as an experimental bundled
    plugin rather than a platform-only feature.
  - `extensions/canvas/index.ts:82` registers hosted Canvas/A2UI HTTP surfaces,
    and `docs/gateway/configuration-reference.md:812` documents the hosted
    Canvas/A2UI configuration surface.
  - `extensions/canvas/index.ts:128` registers the agent-facing `canvas` tool.
  - `extensions/canvas/index.ts:9` defines node commands including
    `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, and
    `canvas.a2ui.*`.
  - `src/agents/system-prompt.ts:428` documents Control UI embeds for hosted
    Canvas documents.
  - `extensions/canvas/src/documents.ts:132` materializes Canvas document entry
    URLs under `/__openclaw__/canvas/documents/...`.
- Negative signals:
  - The clearest proof is source and docs alignment. This note does not record
    a full Gateway-plus-node-plus-embed release smoke for Canvas.
  - Canvas is still described as experimental, so the category should not be
    treated as an LTS support kernel.
- Integration gaps:
  - Add a release smoke that starts the Gateway, loads the bundled Canvas
    plugin, serves a hosted document URL, embeds it in Control UI, invokes a
    paired node command, and verifies snapshot/A2UI round trips.

## Quality Score

- Score: `Alpha (66%)`
- Good qualities:
  - Ownership is concentrated in one plugin entry instead of spread across
    unrelated platform surfaces.
  - The plugin groups host routes, tool registration, node commands, document
    URLs, and A2UI transport under a coherent Canvas namespace.
  - Gateway docs expose the hosted URL/configuration boundary operators need to
    reason about Canvas routing.
- Bad qualities:
  - The plugin remains experimental and crosses several operational boundaries:
    Gateway HTTP auth, node foreground/availability, assistant embed output,
    hosted document assets, and A2UI message transport.
  - Platform-specific app readiness and node command availability still affect
    whether Canvas succeeds in practice, even if plugin ownership is clear.
  - There is no category-specific recurring support artifact showing all
    subfeatures working together.
- Excluded from quality:
  - Source presence and tests raise Coverage only; they do not by themselves
    raise Quality.

## Completeness Score

- Score: `Beta (74%)`
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Hosted Canvas and A2UI surfaces, Agent canvas tool, Node Canvas commands, Control UI embeds, Canvas documents, A2UI transport and snapshots.
  embeds, node control, snapshots, documents, and A2UI transport.
- Negative signals: The category lacks a hardened user-facing support boundary
  and a recurring whole-family validation artifact.
- Completeness gaps:
  - Document the supported Canvas subfeature matrix in the public Canvas
    reference page.
  - Add operator-facing failure guidance for host configuration, node
    availability, document URL reachability, and A2UI transport errors.
