# QA Refactor

Status: foundational migration landed.

## Goal

Move OpenClaw QA from a split-definition model to a single source of truth:

- scenario metadata
- prompts sent to the model
- setup and teardown
- harness logic
- assertions and success criteria
- artifacts and report hints

The desired end state is a generic QA harness that loads powerful scenario definition files instead of hardcoding most behavior in TypeScript.

## Current State

Primary source of truth now lives in `qa/scenarios/index.md` plus one file per
scenario under `qa/scenarios/<theme>/*.md`.

Implemented:

- `qa/scenarios/index.md`
  - canonical QA pack metadata
  - operator identity
  - kickoff mission
- `qa/scenarios/<theme>/*.md`
  - one markdown file per scenario
  - scenario metadata
  - handler bindings
  - scenario-specific execution config
- `extensions/qa-lab/src/scenario-catalog.ts`
  - markdown pack parser + zod validation
- `extensions/qa-lab/src/qa-agent-bootstrap.ts`
  - plan rendering from the markdown pack
- `extensions/qa-lab/src/qa-agent-workspace.ts`
  - seeds generated compatibility files plus `QA_SCENARIOS.md`
- `extensions/qa-lab/src/suite.ts`
  - selects executable scenarios through markdown-defined handler bindings
- QA bus protocol + UI
  - generic inline attachments for image/video/audio/file rendering

Remaining split surfaces:

- `extensions/qa-lab/src/suite.ts`
  - still owns most executable custom handler logic
- `extensions/qa-lab/src/report.ts`
  - still derives report structure from runtime outputs

So the source-of-truth split is fixed, but execution is still mostly handler-backed rather than fully declarative.

## What The Real Scenario Surface Looks Like

Reading the current suite shows a few distinct scenario classes.

### Simple interaction

- channel baseline
- DM baseline
- threaded follow-up
- model switch
- approval followthrough
- reaction/edit/delete

### Config and runtime mutation

- config patch skill disable
- config apply restart wake-up
- config restart capability flip
- runtime inventory drift check

### Filesystem and repo assertions

- source/docs discovery report
- build Lobster Invaders
- generated image artifact lookup

### Memory orchestration

- memory recall
- memory tools in channel context
- memory failure fallback
- session memory ranking
- thread memory isolation
- memory dreaming sweep

### Tool and plugin integration

- MCP plugin-tools call
- skill visibility
- skill hot install
- native image generation
- image roundtrip
- image understanding from attachment

### Multi-turn and multi-actor

- subagent handoff
- subagent fanout synthesis
- restart recovery style flows

These categories matter because they drive DSL requirements. A flat list of prompt + expected text is not enough.

## Direction

### Single source of truth

Use `qa/scenarios/index.md` plus `qa/scenarios/<theme>/*.md` as the authored
source of truth.

The pack should stay:

- human-readable in review
- machine-parseable
- rich enough to drive:
  - suite execution
  - QA workspace bootstrap
  - QA Lab UI metadata
  - docs/discovery prompts
  - report generation

### Preferred authoring format

Use markdown as the top-level format, with structured YAML inside it.

Recommended shape:

- YAML frontmatter
  - id
  - title
  - surface
  - tags
  - docs refs
  - code refs
  - model/provider overrides
  - prerequisites
- prose sections
  - objective
  - notes
  - debugging hints
- fenced YAML blocks
  - setup
  - steps
  - assertions
  - cleanup

This gives:

- better PR readability than giant JSON
- richer context than pure YAML
- strict parsing and zod validation

Raw JSON is acceptable only as an intermediate generated form.

## Proposed Scenario File Shape

Example:

````md
---
id: image-generation-roundtrip
title: Image generation roundtrip
surface: image
tags: [media, image, roundtrip]
models:
  primary: openai/gpt-5.4
requires:
  tools: [image_generate]
  plugins: [openai, qa-channel]
docsRefs:
  - docs/help/testing.md
  - docs/concepts/model-providers.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - src/gateway/chat-attachments.ts
---

# Objective

Verify generated media is reattached on the follow-up turn.

# Setup

```yaml scenario.setup
- action: config.patch
  patch:
    agents:
      defaults:
        imageGenerationModel:
          primary: openai/gpt-image-1
- action: session.create
  key: agent:qa:image-roundtrip
```

# Steps

```yaml scenario.steps
- action: agent.send
  session: agent:qa:image-roundtrip
  message: |
    Image generation check: generate a QA lighthouse image and summarize it in one short sentence.
- action: artifact.capture
  kind: generated-image
  promptSnippet: Image generation check
  saveAs: lighthouseImage
- action: agent.send
  session: agent:qa:image-roundtrip
  message: |
    Roundtrip image inspection check: describe the generated lighthouse attachment in one short sentence.
  attachments:
    - fromArtifact: lighthouseImage
```

# Expect

```yaml scenario.expect
- assert: outbound.textIncludes
  value: lighthouse
- assert: requestLog.matches
  where:
    promptIncludes: Roundtrip image inspection check
  imageInputCountGte: 1
- assert: artifact.exists
  ref: lighthouseImage
```
````

## Runner Capabilities The DSL Must Cover

Based on the current suite, the generic runner needs more than prompt execution.

### Environment and setup actions

- `bus.reset`
- `gateway.waitHealthy`
- `channel.waitReady`
- `session.create`
- `thread.create`
- `workspace.writeSkill`

### Agent turn actions

- `agent.send`
- `agent.wait`
- `bus.injectInbound`
- `bus.injectOutbound`

### Config and runtime actions

- `config.get`
- `config.patch`
- `config.apply`
- `gateway.restart`
- `tools.effective`
- `skills.status`

### File and artifact actions

- `file.write`
- `file.read`
- `file.delete`
- `file.touchTime`
- `artifact.captureGeneratedImage`
- `artifact.capturePath`

### Memory and cron actions

- `memory.indexForce`
- `memory.searchCli`
- `doctor.memory.status`
- `cron.list`
- `cron.run`
- `cron.waitCompletion`
- `sessionTranscript.write`

### MCP actions

- `mcp.callTool`

### Assertions

- `outbound.textIncludes`
- `outbound.inThread`
- `outbound.notInRoot`
- `tool.called`
- `tool.notPresent`
- `skill.visible`
- `skill.disabled`
- `file.contains`
- `memory.contains`
- `requestLog.matches`
- `sessionStore.matches`
- `cron.managedPresent`
- `artifact.exists`

## Variables and Artifact References

The DSL must support saved outputs and later references.

Examples from the current suite:

- create a thread, then reuse `threadId`
- create a session, then reuse `sessionKey`
- generate an image, then attach the file on the next turn
- generate a wake marker string, then assert that it appears later

Needed capabilities:

- `saveAs`
- `${vars.name}`
- `${artifacts.name}`
- typed references for paths, session keys, thread ids, markers, tool outputs

Without variable support, the harness will keep leaking scenario logic back into TypeScript.

## What Should Stay As Escape Hatches

A fully pure declarative runner is not realistic in phase 1.

Some scenarios are inherently orchestration-heavy:

- memory dreaming sweep
- config apply restart wake-up
- config restart capability flip
- generated image artifact resolution by timestamp/path
- discovery-report evaluation

These should use explicit custom handlers for now.

Recommended rule:

- 85-90% declarative
- explicit `customHandler` steps for the hard remainder
- named and documented custom handlers only
- no anonymous inline code in the scenario file

That keeps the generic engine clean while still allowing progress.

## Architecture Change

### Current

Scenario markdown already is the source of truth for:

- suite execution
- workspace bootstrap files
- QA Lab UI scenario catalog
- report metadata
- discovery prompts

Generated compatibility:

- seeded workspace still includes `QA_KICKOFF_TASK.md`
- seeded workspace still includes `QA_SCENARIO_PLAN.md`
- seeded workspace now also includes `QA_SCENARIOS.md`

## Refactor Plan

### Phase 1: loader and schema

Done.

- added `qa/scenarios/index.md`
- split scenarios into `qa/scenarios/<theme>/*.md`
- added parser for named markdown YAML pack content
- validated with zod
- switched consumers to the parsed pack
- removed repo-level `qa/seed-scenarios.json` and `qa/QA_KICKOFF_TASK.md`

### Phase 2: generic engine

- split `extensions/qa-lab/src/suite.ts` into:
  - loader
  - engine
  - action registry
  - assertion registry
  - custom handlers
- keep existing helper functions as engine operations

Deliverable:

- engine executes simple declarative scenarios

Start with scenarios that are mostly prompt + wait + assert:

- threaded follow-up
- image understanding from attachment
- skill visibility and invocation
- channel baseline

Deliverable:

- first real markdown-defined scenarios shipping through the generic engine

### Phase 4: migrate medium scenarios

- image generation roundtrip
- memory tools in channel context
- session memory ranking
- subagent handoff
- subagent fanout synthesis

Deliverable:

- variables, artifacts, tool assertions, request-log assertions proven out

### Phase 5: keep hard scenarios on custom handlers

- memory dreaming sweep
- config apply restart wake-up
- config restart capability flip
- runtime inventory drift

Deliverable:

- same authoring format, but with explicit custom-step blocks where needed

### Phase 6: delete hardcoded scenario map

Once the pack coverage is good enough:

- remove most scenario-specific TypeScript branching from `extensions/qa-lab/src/suite.ts`

## Fake Slack / Rich Media Support

The current QA bus is text-first.

Relevant files:

- `extensions/qa-channel/src/protocol.ts`
- `extensions/qa-lab/src/bus-state.ts`
- `extensions/qa-lab/src/bus-queries.ts`
- `extensions/qa-lab/src/bus-server.ts`
- `extensions/qa-lab/web/src/ui-render.ts`

Today the QA bus supports:

- text
- reactions
- threads

It does not yet model inline media attachments.

### Needed transport contract

Add a generic QA bus attachment model:

```ts
type QaBusAttachment = {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  mimeType: string;
  fileName?: string;
  inline?: boolean;
  url?: string;
  contentBase64?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  transcript?: string;
};
```

Then add `attachments?: QaBusAttachment[]` to:

- `QaBusMessage`
- `QaBusInboundMessageInput`
- `QaBusOutboundMessageInput`

### Why generic first

Do not build a Slack-only media model.

Instead:

- one generic QA transport model
- multiple renderers on top of it
  - current QA Lab chat
  - future fake Slack web
  - any other fake transport views

This prevents duplicate logic and lets media scenarios stay transport-agnostic.

### UI work needed

Update the QA UI to render:

- inline image preview
- inline audio player
- inline video player
- file attachment chip

The current UI can already render threads and reactions, so attachment rendering should layer onto the same message card model.

### Scenario work enabled by media transport

Once attachments flow through QA bus, we can add richer fake-chat scenarios:

- inline image reply in fake Slack
- audio attachment understanding
- video attachment understanding
- mixed attachment ordering
- thread reply with media retained

## Recommendation

The next implementation chunk should be:

1. add markdown scenario loader + zod schema
2. generate the current catalog from markdown
3. migrate a few simple scenarios first
4. add generic QA bus attachment support
5. render inline image in the QA UI
6. then expand to audio and video

This is the smallest path that proves both goals:

- generic markdown-defined QA
- richer fake messaging surfaces

## Open Questions

- whether scenario files should allow embedded markdown prompt templates with variable interpolation
- whether setup/cleanup should be named sections or just ordered action lists
- whether artifact references should be strongly typed in schema or string-based
- whether custom handlers should live in one registry or per-surface registries
- whether the generated JSON compatibility file should remain checked in during migration
